// jobMetricsWorker.js
const DEBUG = true;

// Store global app data passed from main thread
let rdBase = '';
let projectName = '';

// Configuration
const MAX_CONCURRENT_REQUESTS = 10;

function log(component, message, data = null) {
    if (!DEBUG) return;
    const timestamp = new Date().toISOString();
    const logData = {
        timestamp,
        component,
        message,
        ...(data && { data })
    };
    console.log(`[JobMetrics Worker] ${component}:`, logData);
}

function logError(component, error, context = {}) {
    if (!DEBUG) return;
    console.error(`[JobMetrics Worker Error] ${component}:`, {
        message: error.message,
        stack: error.stack,
        context,
        timestamp: new Date().toISOString()
    });
}

// Concurrency Pool for limiting API requests
class ConcurrencyPool {
    constructor(maxConcurrent = MAX_CONCURRENT_REQUESTS) {
        this.maxConcurrent = maxConcurrent;
        this.running = 0;
        this.queue = [];
        this.activeRequests = 0;
        this.peakConcurrency = 0;
        this.totalEnqueued = 0;
        this.totalProcessed = 0;
        this.waitTime = 0;
    }

    async add(fn) {
        this.totalEnqueued++;
        
        // If we can run it now, do so
        if (this.running < this.maxConcurrent) {
            return this._run(fn);
        }
        
        // Otherwise queue it
        return new Promise((resolve, reject) => {
            const startWait = performance.now();
            
            this.queue.push(() => {
                const waitTime = performance.now() - startWait;
                this.waitTime += waitTime;
                
                this._run(fn).then(resolve, reject);
            });
        });
    }
    
    async _run(fn) {
        this.running++;
        this.activeRequests++;
        
        // Update peak concurrency metric
        if (this.activeRequests > this.peakConcurrency) {
            this.peakConcurrency = this.activeRequests;
        }
        
        try {
            return await fn();
        } finally {
            this.running--;
            this.activeRequests--;
            this.totalProcessed++;
            
            // If there's something in the queue, run it
            if (this.queue.length > 0) {
                const next = this.queue.shift();
                next();
            }
        }
    }
    
    getMetrics() {
        return {
            maxConcurrent: this.maxConcurrent,
            currentActive: this.activeRequests,
            queueLength: this.queue.length,
            peakConcurrency: this.peakConcurrency,
            totalEnqueued: this.totalEnqueued,
            totalProcessed: this.totalProcessed,
            averageWaitTime: this.totalProcessed > 0 ? this.waitTime / this.totalProcessed : 0
        };
    }
}

// Create a global instance of the concurrency pool
const requestPool = new ConcurrencyPool();

// Function to fetch executions with pagination and retry logic
// Updated to use the same endpoint approach as ROI summary plugin
async function fetchExecutions(jobId, dateRange) {
    const startTime = performance.now();
    log('fetchExecutions:start', { jobId, dateRange });

    if (!rdBase || !projectName) {
        throw new Error('Worker not initialized with required app data: rdBase and projectName are needed');
    }

    let allExecutions = [];
    let offset = 0;
    const MAX_PER_PAGE = 500;
    let hasMore = true;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    let timeout = 3000;

    while (hasMore) {
        try {
            // Create the URL with parameters - matching ROI plugin approach
            let params = new URLSearchParams({
                jobIdListFilter: jobId,
                max: MAX_PER_PAGE,
                offset: offset,
                format: 'json'
            });
            
            // Use begin/end dates if provided, otherwise fallback to recentFilter
            if (dateRange && dateRange.begin && dateRange.end) {
                // Format dates in ISO format for API
                params.append('begin', dateRange.begin + 'T00:00:00Z');
                params.append('end', dateRange.end + 'T23:59:59Z');
            } else {
                // Default to 10 days if no dateRange specified
                params.append('recentFilter', '10d');
            }
            
            // Use the same API endpoint as ROI plugin
            const url = `${rdBase}api/40/project/${projectName}/executions?${params.toString()}`;
            
            const response = await fetch(url, {
                credentials: 'include',
                headers: {
                    'Accept': 'application/json',
                    'x-rundeck-ajax': 'true'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const responseData = await response.json();
            timeout = 1500;

            const executions = responseData.executions || [];
            allExecutions.push(...executions);

            log('fetchExecutions:progress', {
                jobId,
                batchSize: executions.length,
                totalSoFar: allExecutions.length,
                offset
            });

            if (executions.length < MAX_PER_PAGE) {
                hasMore = false;
            } else {
                offset += MAX_PER_PAGE;
            }

            retryCount = 0;

        } catch (error) {
            retryCount++;
            logError('fetchExecutions', error, { jobId, offset, attempt: retryCount });

            if (retryCount >= MAX_RETRIES) {
                hasMore = false;
            } else {
                await new Promise(resolve => setTimeout(resolve, 500 * retryCount));
            }
        }
    }

    const duration = performance.now() - startTime;
    log('fetchExecutions:complete', {
        jobId,
        totalExecutions: allExecutions.length,
        duration: `${duration.toFixed(2)}ms`
    });

    return allExecutions;
}

// Process execution data to extract metrics
function processExecutionData(executions) {
    let successful = 0;
    let failed = 0;
    let totalDuration = 0;
    const executionsByDate = {};
    const executionsByHour = Array(24).fill(0);
    let mostRecentExec = null;
    
    // Check for ROI metrics
    let hasRoi = false;
    
    // Always process executions array, even if it's empty
    // This allows us to generate valid metrics for jobs with no executions
    if (executions && executions.length > 0) {
        executions.forEach(execution => {
            // Check if any execution has ROI data
            if (execution.roiHours !== undefined && execution.roiHours !== null) {
                hasRoi = true;
            }
            
            // Track successful vs failed executions
            if (execution.status === 'succeeded') {
                successful++;
            } else {
                failed++;
            }
            
            // Track duration
            if (execution.duration) {
                totalDuration += execution.duration;
            }
            
            // Track most recent execution to get job.averageDuration
            const dateStarted = execution['date-started']?.date || execution.dateStarted;
            if (dateStarted) {
                if (!mostRecentExec || 
                    (mostRecentExec['date-started'] && 
                     dateStarted > mostRecentExec['date-started'].date)) {
                    mostRecentExec = execution;
                }
                
                // Track by day
                const datePart = dateStarted.split('T')[0];
                if (!executionsByDate[datePart]) {
                    executionsByDate[datePart] = { 
                        total: 0, 
                        success: 0, 
                        duration: 0 
                    };
                }
                executionsByDate[datePart].total++;
                if (execution.status === 'succeeded') {
                    executionsByDate[datePart].success++;
                }
                if (execution.duration) {
                    executionsByDate[datePart].duration += execution.duration;
                }
                
                // Track by hour
                try {
                    const dateObj = new Date(dateStarted);
                    const hour = dateObj.getHours();
                    executionsByHour[hour]++;
                } catch (e) {
                    // Skip if date parsing fails
                }
            }
        });
    }
    
    // Calculate success rate
    const successRate = executions.length > 0 ? (successful / executions.length) * 100 : 0;
    
    // Use job.averageDuration if available from most recent execution
    let avgDuration;
    if (mostRecentExec && mostRecentExec.job && mostRecentExec.job.averageDuration) {
        avgDuration = mostRecentExec.job.averageDuration;
    } else {
        // Fallback to calculating from executions if necessary
        avgDuration = executions.length > 0 ? totalDuration / executions.length : 0;
    }
    
    // Prepare time-based analysis
    const timeAnalysis = {
        byDate: executionsByDate,
        byHour: executionsByHour
    };
    
    return {
        summary: {
            total: executions.length,
            successful,
            failed,
            totalDuration,
            avgDuration,
            successRate,
            hasRoi  // Include hasRoi flag in metrics summary
        },
        timeAnalysis,
        processedAt: Date.now(),
        hasRoi  // Include hasRoi at top level as well
    };
}

// Add storage for tracking metrics
const workerMetrics = {
    requestsProcessed: 0,
    executionsProcessed: 0,
    errors: 0,
    totalProcessingTime: 0,
    startTime: Date.now(),
    lastProcessingTime: 0,
    lastHealthCheck: Date.now(),
    batches: 0,
    cacheHits: 0, 
    lastError: null,
    status: 'idle', // idle, processing, error
    concurrency: {
        maxConcurrent: MAX_CONCURRENT_REQUESTS,
        currentActive: 0,
        peakConcurrency: 0,
        totalEnqueued: 0,
        totalProcessed: 0,
        averageWaitTime: 0
    }
};

// Message handler
onmessage = async function(e) {
    const { type, data, id } = e.data;

    try {
        // Update startTime if not set
        if (!workerMetrics.startTime) {
            workerMetrics.startTime = Date.now();
        }
        
        switch(type) {
            case 'init':
                // Store app data if provided
                if (data) {
                    if (data.rdBase) {
                        rdBase = data.rdBase;
                    }
                    if (data.projectName) {
                        projectName = data.projectName;
                    }
                }
                
                workerMetrics.status = 'initialized';
                workerMetrics.startTime = Date.now();
                postMessage({ type: 'initialized' });
                break;
                
            case 'getMetrics':
                // Handler for metrics requests
                log('getMetrics', 'Health check received');
                
                // Get the latest concurrency pool metrics
                const poolMetrics = requestPool.getMetrics();
                workerMetrics.concurrency = {
                    ...poolMetrics,
                    timestamp: Date.now()
                };
                
                // Update worker status
                workerMetrics.lastHealthCheck = Date.now();
                
                postMessage({
                    type: 'metrics',
                    requestId: id,
                    data: {
                        status: 'healthy',
                        uptime: Date.now() - workerMetrics.startTime,
                        requestsProcessed: workerMetrics.requestsProcessed,
                        executionsProcessed: workerMetrics.executionsProcessed,
                        errors: workerMetrics.errors,
                        avgProcessingTime: workerMetrics.requestsProcessed > 0 
                            ? workerMetrics.totalProcessingTime / workerMetrics.requestsProcessed
                            : 0,
                        lastProcessingTime: workerMetrics.lastProcessingTime,
                        currentStatus: workerMetrics.status,
                        timestamp: Date.now(),
                        concurrency: workerMetrics.concurrency,
                        lastHealthCheck: workerMetrics.lastHealthCheck
                    }
                });
                break;
                
            case 'fetchAndProcessJob':
                // Handler for fetching and processing job executions
                workerMetrics.requestsProcessed++;
                const fetchStartTime = performance.now();
                workerMetrics.status = 'processing';
                
                try {
                    log('fetchAndProcessJob', `Starting fetch for job ${data.jobId}`, { 
                        timeWindow: data.timeWindow,
                        dateRange: data.dateRange
                    });
                    
                    // Calculate date range from timeWindow if needed
                    let dateRange = data.dateRange;
                    if (!dateRange && data.timeWindow) {
                        const end = new Date();
                        const begin = new Date();
                        begin.setDate(begin.getDate() - data.timeWindow);
                        
                        dateRange = {
                            begin: begin.toISOString().split('T')[0],
                            end: end.toISOString().split('T')[0]
                        };
                    }
                    
                    // Fetch executions using the requestPool for concurrency management
                    const executions = await requestPool.add(() => fetchExecutions(data.jobId, dateRange));
                    
                    // Process the executions to calculate metrics
                    // Always process executions, even if empty
                    const execCount = executions ? executions.length : 0;
                    const execArray = executions || [];
                    
                    workerMetrics.executionsProcessed += execCount;
                    const processedData = processExecutionData(execArray);
                    
                    const fetchDuration = performance.now() - fetchStartTime;
                    workerMetrics.lastProcessingTime = fetchDuration;
                    workerMetrics.totalProcessingTime += fetchDuration;
                    workerMetrics.status = 'idle';
                    
                    // Check for ROI hours in any execution and add hasRoi flag to each execution
                    const hasRoi = processedData.hasRoi;
                    
                    // Add the hasRoi flag to each execution
                    const enhancedExecutions = execArray.map(exec => ({
                        ...exec,
                        hasRoi: hasRoi,
                        jobId: data.jobId
                    }));
                    
                    // Send back the result - always return execution data even if empty
                    postMessage({
                        type: 'jobProcessed',
                        requestId: id,
                        results: {
                            jobId: data.jobId,
                            executions: enhancedExecutions,
                            metrics: processedData,
                            hasRoi: hasRoi
                        },
                        summary: {
                            jobId: data.jobId,
                            count: execCount,
                            duration: fetchDuration,
                            dateRange: dateRange,
                            hasRoi: hasRoi
                        }
                    });
                    
                } catch (fetchError) {
                    workerMetrics.errors++;
                    workerMetrics.status = 'error';
                    workerMetrics.lastError = {
                        time: Date.now(),
                        message: fetchError.message
                    };
                    
                    logError('fetchAndProcessJob', fetchError);
                    postMessage({
                        type: 'error',
                        requestId: id,
                        error: fetchError.message
                    });
                }
                break;
                
            default:
                log('unknownMessage', `Received unknown message type: ${type}`);
                postMessage({
                    type: 'error',
                    requestId: id,
                    error: `Unknown message type: ${type}`,
                    metadata: {
                        requestedType: type,
                        timestamp: Date.now()
                    }
                });
        }
    } catch (error) {
        workerMetrics.errors++;
        workerMetrics.status = 'error';
        workerMetrics.lastError = {
            time: Date.now(),
            message: error.message,
            stack: error.stack
        };
        
        logError('operation', error);
        postMessage({
            type: 'error',
            requestId: id,
            error: error.message,
            metadata: {
                timestamp: Date.now()
            }
        });
    }
};