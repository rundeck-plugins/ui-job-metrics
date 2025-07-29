/**
 * ExecutionDataManager
 * 
 * Adapter for Job Metrics plugin to leverage the data cached by ROI Summary plugin.
 * This allows both plugins to share execution data without duplicating API calls.
 */
class ExecutionDataManager {
    constructor(projectName) {
        this.DEBUG = false;
        this.projectName = projectName;
        
        // ROI plugin DB config - only for reading
        this.ROI_DB_CONFIG = {
            name: 'roiCache',  // Must match ROI plugin's DB name
            version: 1,
            stores: {
                jobCache: 'jobCache',
                executionCache: 'executionCache',
                metrics: 'metrics'
            }
        };
        
        // Job Metrics plugin DB config - for our own writes
        this.DB_CONFIG = {
            name: 'jobMetricsCache',  // Separate namespace for Job Metrics
            version: 1,
            stores: {
                jobCache: 'jobCache',
                executionCache: 'executionCache',
            }
        };
        
        // Cache settings
        this.EXECUTION_CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
        this.CACHE_FRESHNESS_THRESHOLD = 8; // hours
        
        // For tracking the ROI plugin initialization
        this.dbInitialized = false;
        this.dbInitializing = false;
        this.waitingForRoiPlugin = false;

        // DB references
        this.dbPromise = null;
        this.db = null;
        
        // Web Worker for processing
        this.worker = null;
        this.workerInitialized = false;
        this.pendingRequests = new Map();
        this.requestCounter = 0;
        this.workerInitFailCount = 0;
        this.maxWorkerInitRetries = 3;
        
        // Worker initialization lock to prevent concurrent initializations
        this.workerInitLock = false;
        this.workerInitPromise = null;
        this.WORKER_INIT_TIMEOUT = 10000; // 10 seconds
        this.HEALTH_CHECK_INTERVAL = 1000 * 60 * 5; // 5 minutes

        // For tracking fetch operations in progress to prevent duplicates
        this.fetchOperationsInProgress = new Map();
        
        // Set up navigation event handlers to properly terminate workers
        this.setupNavigationHandlers();
    }
    
    // Logging utilities
    log(method, msg, data = null) {
        if (!this.DEBUG) return;
        console.log(`%cJobMetricsDataManager%c: ${method}`,
            'background: #3b82f6; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit',
            msg,
            data || ''
        );
    }

    logGroup(method, details, type = 'general') {
        if (!this.DEBUG) return;
        console.groupCollapsed(`%cJobMetricsDataManager%c: ${method}`,
            'background: #3b82f6; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit'
        );
        Object.entries(details).forEach(([key, value]) => {
            console.log(`${key}:`, value);
        });
        console.groupEnd();
    }

    logError(method, error, context = {}) {
        if (!this.DEBUG) return;
        
        console.group(`%cJobMetricsDataManager%c: ${method} ERROR`,
            'background: #dc2626; color: white; padding: 2px 5px; border-radius: 3px;',
            'color: inherit'
        );
        console.error(error);
        if (Object.keys(context).length > 0) {
            console.log('Context:', context);
        }
        console.groupEnd();
    }
    
    /**
     * Sets up handlers to terminate workers on page navigation
     * This follows the same pattern used in ROI summary plugin
     */
    setupNavigationHandlers() {
        try {
            // Page unload event - when user navigates away or refreshes
            window.addEventListener('beforeunload', () => {
                this.log('setupNavigationHandlers', 'Terminating worker due to page unload', 'navigation');
                this.terminateWorker();
            });
            
            this.log('setupNavigationHandlers', 'Navigation handlers set up successfully');
        } catch (error) {
            this.logError('setupNavigationHandlers', error);
        }
    }
    // Database initialization - optimized for non-blocking operation
    async initDb() {
        if (this.db && this.roiDb) {
            return { db: this.db, roiDb: this.roiDb };
        }

        if (this.dbPromise) {
            return this.dbPromise;
        }

        this.dbInitializing = true;
        
        // Simplified initialization with lower timeouts
        this.log('initDb', 'Initializing database connections (non-blocking)');
        
        this.dbPromise = new Promise((resolve, reject) => {
            try {
                const connections = {};
                let completedConnections = 0;
                
                // Check if ROI Summary is installed using window flag
                const roiSummaryInstalled = window.RDPRO && 
                    window.RDPRO["ui-jobmetrics"] && 
                    window.RDPRO["ui-jobmetrics"].hasRoiSummary !== false;
                
                // Only try to connect to both databases if ROI Summary is installed
                const totalConnections = roiSummaryInstalled ? 2 : 1;
                
                this.log('initDb', `Total connections to initialize: ${totalConnections}`, {
                    roiSummaryInstalled
                });
                
                const checkComplete = () => {
                    if (completedConnections === totalConnections) {
                        this.roiDb = connections.roiDb;
                        this.db = connections.db;
                        this.dbInitialized = true;
                        this.dbInitializing = false;
                        
                        // Clear the promise so we can re-initialize if needed
                        this.dbPromise = null;
                        resolve({ db: this.db, roiDb: this.roiDb });
                    }
                };
                
                // Use a shorter timeout for database operations
                const DB_OPERATION_TIMEOUT = 3000; // 3 seconds max
                
                // Only try to connect to ROI database if ROI Summary is installed
                if (roiSummaryInstalled) {
                    // 1. Connect to ROI plugin's database for reading with timeout
                    this.log('initDb', 'Attempting to connect to ROI database');
                    
                    // Add timeout for ROI DB connection
                    const roiTimeout = setTimeout(() => {
                        this.log('initDb', 'ROI database connection timed out, continuing without it');
                        connections.roiDb = null;
                        completedConnections++;
                        checkComplete();
                    }, DB_OPERATION_TIMEOUT);
                    
                    const roiRequest = indexedDB.open(this.ROI_DB_CONFIG.name, this.ROI_DB_CONFIG.version);
                    
                    roiRequest.onerror = (event) => {
                        clearTimeout(roiTimeout);
                        const error = new Error('Failed to open ROI database: ' + (roiRequest.error || 'Unknown error'));
                        this.logError('initDb', error);
                        // Continue with our own database even if ROI db fails
                        connections.roiDb = null;
                        completedConnections++;
                        checkComplete();
                    };
                    
                    roiRequest.onsuccess = () => {
                        clearTimeout(roiTimeout);
                        connections.roiDb = roiRequest.result;
                        
                        this.log('initDb', 'Successfully connected to ROI plugin database (read-only)', {
                            name: this.ROI_DB_CONFIG.name,
                            stores: Array.from(connections.roiDb.objectStoreNames)
                        });
                        
                        completedConnections++;
                        checkComplete();
                    };
                } else {
                    // Skip ROI database connection if ROI Summary is not installed
                    this.log('initDb', 'ROI Summary is not installed, skipping ROI database connection');
                    connections.roiDb = null;
                    // Mark this connection as completed
                    completedConnections++;
                    // No need to call checkComplete here - will be called after our DB connection
                }
                
                // 2. Create/connect to our own database for writing
                const request = indexedDB.open(this.DB_CONFIG.name, this.DB_CONFIG.version);
                
                // Add timeout for our DB connection
                const dbTimeout = setTimeout(() => {
                    this.log('initDb', 'Job Metrics database connection timed out');
                    this.dbPromise = null;
                    this.dbInitializing = false;
                    reject(new Error('Database connection timeout'));
                }, DB_OPERATION_TIMEOUT);
                
                request.onerror = (event) => {
                    clearTimeout(dbTimeout);
                    const error = new Error('Failed to open Job Metrics database: ' + (request.error || 'Unknown error'));
                    this.logError('initDb', error);
                    this.dbPromise = null;
                    this.dbInitializing = false;
                    reject(error);
                };
                
                request.onsuccess = () => {
                    clearTimeout(dbTimeout);
                    connections.db = request.result;
                    
                    // Enable auto-closing connections to avoid blocking issues
                    connections.db.onversionchange = () => {
                        connections.db.close();
                        this.log('initDb', 'Database connection closed due to version change');
                        this.db = null;
                        this.dbInitialized = false;
                    };
                    
                    this.log('initDb', 'Successfully connected to Job Metrics database', {
                        name: this.DB_CONFIG.name,
                        stores: Array.from(connections.db.objectStoreNames)
                    });
                    
                    completedConnections++;
                    checkComplete();
                };
                
                // Create schema for our database if needed
                request.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    
                    this.log('initDb', 'Creating Job Metrics database schema', {
                        name: this.DB_CONFIG.name,
                        version: this.DB_CONFIG.version
                    });
                    
                    // Create object stores if they don't exist
                    if (!db.objectStoreNames.contains(this.DB_CONFIG.stores.jobCache)) {
                        db.createObjectStore(this.DB_CONFIG.stores.jobCache, { keyPath: 'id' });
                    }
                    
                    if (!db.objectStoreNames.contains(this.DB_CONFIG.stores.executionCache)) {
                        db.createObjectStore(this.DB_CONFIG.stores.executionCache, { keyPath: 'id' });
                    }
                };
                
            } catch (error) {
                this.logError('initDb', error);
                this.dbPromise = null;
                this.dbInitializing = false;
                reject(error);
            }
        });
        
        return this.dbPromise;
    }
    // Ensure database is initialized before performing operations
    async ensureDbConnection() {
        // If we have both databases already initialized, return them
        if (this.db && this.roiDb) {
            return { db: this.db, roiDb: this.roiDb };
        }
        
        // If we know ROI Summary is not installed, don't wait for roiDb
        if (window.RDPRO && 
            window.RDPRO["ui-jobmetrics"] && 
            window.RDPRO["ui-jobmetrics"].hasRoiSummary === false) {
            
            // If we have our own database initialized but not ROI's (which is expected)
            if (this.db) {
                this.log('ensureDbConnection', 'ROI Summary is not installed, using only our database');
                return { db: this.db, roiDb: null };
            }
        }
        
        try {
            return await this.initDb();
        } catch (error) {
            this.logError('ensureDbConnection', error);
            throw error;
        }
    }
    
    // Get data from cache
    async get(storeName, key) {
        try {
            const { roiDb, db } = await this.ensureDbConnection();
            
            // ALWAYS check our own database first
            const ourResult = await this.getFromDb(db, storeName, key);
            if (ourResult) {
                return ourResult;
            }
            
            // For executionCache, we need special handling
            if (storeName === this.DB_CONFIG.stores.executionCache && roiDb) {
                // IMPLEMENTATION OF THE PLAN: 
                // "try to get the data from its own table, then try to get the data from the
                // roiCache db's executionCache and check - if the job has the property hasRoi set to
                // false, ui-job-metrics will trigger the api calls"
                
                // Extract jobId from the key (they're the same in most cases)
                const jobId = key;
                
                // Check if this job has ROI metrics
                const hasRoiMetrics = await this.checkJobHasRoiMetrics(jobId);
                
                // Only check ROI cache for jobs WITH hasRoi=true
                if (hasRoiMetrics === true) {
                    try {
                        const result = await this.getFromDb(roiDb, storeName, key);
                        if (result) {
                            // console.log(`DEBUG: Found data for ROI job ${jobId} in ROI cache`);
                            return result;
                        }
                    } catch (error) {
                        this.log('get', `Failed to read from ROI database for ROI job: ${error.message}`);
                    }
                } else {
                    // console.log(`DEBUG: Job ${jobId} has no ROI metrics, NOT checking ROI cache`);
                    // For non-ROI jobs, we intentionally don't check ROI cache
                    // This ensures we make API calls for non-ROI jobs
                }
            } else if (roiDb) {
                // For other stores (like jobCache), we can still check ROI database
                try {
                    const result = await this.getFromDb(roiDb, storeName, key);
                    if (result) {
                        return result;
                    }
                } catch (error) {
                    this.log('get', `Failed to read from ROI database for store ${storeName}: ${error.message}`);
                }
            }
            
            // Return null if not found in either database
            return null;
        } catch (error) {
            this.logError('get', error, { storeName, key });
            return null;
        }
    }
    
    // Helper method to get data from a specific database
    async getFromDb(db, storeName, key) {
        if (!db) return null;
        
        // Check if this is the ROI database and if ROI plugin is installed
        if (db === this.roiDb && 
            window.RDPRO && 
            window.RDPRO["ui-jobmetrics"] && 
            window.RDPRO["ui-jobmetrics"].hasRoiSummary === false) {
            // Don't attempt to access ROI database when ROI plugin is not installed
            this.log('getFromDb', `Not accessing ROI database when ROI plugin is not installed (store: ${storeName}, key: ${key})`);
            return null;
        }
        

        // Check if the store exists in the database to avoid errors
        if (!db.objectStoreNames.contains(storeName)) {
            this.log('getFromDb', `Store ${storeName} does not exist in database ${db.name}`);
            return null;
        }
        
        return new Promise((resolve, reject) => {
            try {
                const transaction = db.transaction(storeName, 'readonly');
                const store = transaction.objectStore(storeName);
                const request = store.get(key);
                
                request.onsuccess = () => {
                    resolve(request.result);
                };
                
                request.onerror = () => {
                    reject(new Error(`Failed to get data: ${request.error || 'Unknown error'}`));
                };
            } catch (error) {
                reject(error);
            }
        });
    }
    
    // Store data in cache - only writes to our own database
    async set(storeName, value) {
        try {
            const { db } = await this.ensureDbConnection();
            
            // IMPORTANT: Only write to our own database, not ROI plugin's
            if (!db) {
                throw new Error('Job Metrics database not initialized');
            }
            
            return new Promise((resolve, reject) => {
                try {
                    const transaction = db.transaction(storeName, 'readwrite');
                    const store = transaction.objectStore(storeName);
                    const request = store.put(value);
                    
                    // Important: Wait for transaction completion, not just request success
                    // This ensures data is fully committed to the database
                    transaction.oncomplete = () => {
                        this.log('set', `Successfully stored data in ${storeName}`, {
                            id: value.id,
                            type: storeName
                        });
                        resolve(request.result);
                    };
                    
                    // Handle transaction errors - critical for reliable IndexedDB operations
                    transaction.onerror = () => {
                        this.logError('set:transaction', new Error(`Transaction failed: ${transaction.error?.message || 'Unknown transaction error'}`));
                        reject(new Error(`Transaction failed: ${transaction.error || 'Unknown error'}`));
                    };
                    
                    // Individual request errors
                    request.onerror = () => {
                        this.logError('set:request', new Error(`Failed to store data: ${request.error?.message || 'Unknown request error'}`));
                        reject(new Error(`Failed to store data: ${request.error || 'Unknown error'}`));
                    };
                } catch (error) {
                    this.logError('set:exception', error);
                    reject(error);
                }
            });
        } catch (error) {
            this.logError('set', error, { storeName });
            throw error;
        }
    }

    // Get executions for a job, leveraging ROI plugin's cache or web worker
    async getJobExecutions(jobId, timeWindow) {
        this.log('getJobExecutions', `Getting executions for job ${jobId} with timeWindow ${timeWindow}`);

        try {
            // First check if DB is available - this will wait for ROI plugin if needed
            try {
                await this.ensureDbConnection();
            } catch (dbError) {
                // If DB is not available, always use worker
                this.logError('getJobExecutions', new Error('Database not available, using worker'), { cause: dbError });
                const executions = await this.fetchExecutionsWithWorker(jobId, timeWindow);
                // Try to cache the results even if DB was not initially available
                try {
                    await this.cacheExecutions(jobId, executions, timeWindow);
                } catch (cacheError) {
                    this.log('getJobExecutions', 'Could not cache executions after worker fetch', { error: cacheError.message });
                }
                return executions;
            }
            
            // Check if this job has ROI metrics
            // For jobs without ROI metrics, we should always manage their executions ourselves
            const hasRoiMetrics = await this.checkJobHasRoiMetrics(jobId);
            
            // Build the date range for this request
            const dateRange = {
                begin: moment().startOf('day').subtract(timeWindow, 'days').format('YYYY-MM-DD'),
                end: moment().endOf('day').format('YYYY-MM-DD')
            };
            
            // First check our own cache
            const executionCacheKey = jobId;
            let cachedData = null;
            
            try {
                // Try to get cached data from our executionCache
                cachedData = await this.get(this.DB_CONFIG.stores.executionCache, executionCacheKey);
                
                // if (cachedData) {
                //     console.log(`DEBUG: Found cached data for ${jobId} in our cache`, {
                //         hasData: Array.isArray(cachedData.data) && cachedData.data.length > 0,
                //         entryCount: Array.isArray(cachedData.data) ? cachedData.data.length : 0,
                //         timestamp: cachedData.timestamp ? new Date(cachedData.timestamp).toISOString() : 'none'
                //     });
                // }

                // If still not found in our cache, try the ROI plugin's cache
                // but ONLY if this job has ROI metrics
                if (!cachedData && hasRoiMetrics) {
                    this.log('getJobExecutions', `No cached data found in our DB, checking ROI plugin cache`);
                    cachedData = await this.get(this.ROI_DB_CONFIG.stores.executionCache, executionCacheKey);
                    
                    // If found in ROI plugin cache, copy it to our cache for future use
                    if (cachedData && cachedData.data && Array.isArray(cachedData.data)) {
                        this.log('getJobExecutions', `Found data in ROI plugin cache, copying to our cache`);
                        
                        // Make a copy to avoid reference issues
                        const copiedData = {
                            id: jobId,
                            jobId: jobId,
                            data: [...cachedData.data],
                            timestamp: cachedData.timestamp || Date.now(),
                            dateRange: cachedData.dateRange || dateRange,
                            hasRoi: cachedData.hasRoi !== undefined ? cachedData.hasRoi : hasRoiMetrics
                        };
                        
                        // Store in our cache asynchronously
                        this.set(this.DB_CONFIG.stores.executionCache, copiedData)
                            .catch(err => this.logError('getJobExecutions:copyCache', err, { jobId }));
                    }
                }
            } catch (error) {
                this.logError('getJobExecutions:cacheCheck', error, { jobId });
                // Continue execution - we'll try fetching data next
            }
            
            // For jobs without ROI metrics, we need our own caching logic
            // since we can't rely on the ROI plugin
            if (!hasRoiMetrics) {
                this.log('getJobExecutions', `Job ${jobId} has no ROI metrics`, {
                    hasRoiMetrics,
                    hasCachedData: !!cachedData,
                    cachedDataDetails: cachedData ? {
                        id: cachedData.id,
                        timestamp: cachedData.timestamp,
                        hasEntries: Array.isArray(cachedData.data) && cachedData.data.length > 0,
                        entryCount: Array.isArray(cachedData.data) ? cachedData.data.length : 0,
                        source: cachedData.source || 'unknown',
                        fromRoiCache: !!cachedData.fromRoiCache
                    } : null
                });
                
                // If we have cached data already for this job
                if (cachedData && cachedData.data && Array.isArray(cachedData.data)) {
                    const now = Date.now();
                    const dataAge = now - cachedData.timestamp;
                    
                    // Check if our own cache is fresh enough and covers the date range
                    // Skip ROI cache check since this job doesn't have ROI metrics
                    if (dataAge < this.EXECUTION_CACHE_TTL) {
                        // Only check the date range
                        let needsRefresh = false;
                        
                        // Check if date range is covered
                        if (dateRange && cachedData.dateRange) {
                            // Normalize dates by explicitly setting to start/end of day to ensure consistent comparison
                            const requestedBegin = moment(dateRange.begin).startOf('day');
                            const requestedEnd = moment(dateRange.end).endOf('day');
                            const cachedBegin = moment(cachedData.dateRange.begin).startOf('day');
                            const cachedEnd = moment(cachedData.dateRange.end).endOf('day');
                            
                            // Use isSameOrAfter/isSameOrBefore for more reliable date comparison
                            const isBeginCovered = requestedBegin.isSameOrAfter(cachedBegin, 'day');
                            const isEndCovered = requestedEnd.isSameOrBefore(cachedEnd, 'day');
                            
                            // If cached date range doesn't fully contain requested range, needs refresh
                            if (!isBeginCovered || !isEndCovered) {
                                this.log('getJobExecutions', 'Non-ROI job needs refresh: Date range not covered', {
                                    requestedRange: `${dateRange.begin} to ${dateRange.end}`,
                                    cachedRange: `${cachedData.dateRange.begin} to ${cachedData.dateRange.end}`,
                                    requestedMoment: `${requestedBegin.format('YYYY-MM-DD')} to ${requestedEnd.format('YYYY-MM-DD')}`,
                                    cachedMoment: `${cachedBegin.format('YYYY-MM-DD')} to ${cachedEnd.format('YYYY-MM-DD')}`,
                                    isBeginCovered,
                                    isEndCovered,
                                    jobId
                                });
                                needsRefresh = true;
                            }
                        }
                        
                        // Also check the age threshold
                        if (dataAge >= (this.CACHE_FRESHNESS_THRESHOLD * 60 * 60 * 1000)) {
                            // console.log(`DEBUG: Non-ROI job ${jobId} cache age ${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours exceeds threshold of ${this.CACHE_FRESHNESS_THRESHOLD} hours`);
                            this.log('getJobExecutions', 'Non-ROI job needs refresh: Cache exceeds freshness threshold', {
                                cacheAge: `${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours`,
                                threshold: `${this.CACHE_FRESHNESS_THRESHOLD} hours`,
                                jobId
                            });
                            needsRefresh = true;
                        }
                        
                        // If our cache is fresh enough and covers the date range, use it
                        if (!needsRefresh) {
                            // console.log(`DEBUG: Cache hit for non-ROI job ${jobId} - should not happen on clean cache`, {
                            //     dataAge: `${(dataAge / (1000 * 60)).toFixed(1)} minutes`,
                            //     cacheTTL: `${(this.EXECUTION_CACHE_TTL / (1000 * 60 * 60)).toFixed(1)} hours`,
                            //     refreshThreshold: `${this.CACHE_FRESHNESS_THRESHOLD} hours`
                            // });
                            // Log the cache hit with extra debug info
                            this.logGroup('getJobExecutions:cacheHit:nonRoi', {
                                jobId,
                                dataAge: `${(dataAge / (1000 * 60)).toFixed(1)} minutes`,
                                executionCount: cachedData.data.length,
                                timeWindow,
                                cachedDateRange: cachedData.dateRange || 'unknown',
                                requestedDateRange: dateRange
                            });

                            // Filter by date if needed
                            let result;
                            if (timeWindow && timeWindow > 0) {
                                const cutoffDate = moment().startOf('day').subtract(timeWindow, 'days');
                                result = this.filterExecutionsByDate(cachedData.data, cutoffDate);
                            } else {
                                result = cachedData.data;
                            }
                            
                            // console.log(`DEBUG: Returning ${result.length} cached executions for non-ROI job ${jobId} - should not happen on first load`);
                            return result;
                        }
                    }
                    
                    // If we get here, we need to refresh the cache
                    this.log('getJobExecutions', `Cache needs refresh for non-ROI job ${jobId}`, {
                        age: `${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours`
                    });
                    
                    // Use the worker to get new data for the job without ROI
                    const freshExecutions = await this.fetchExecutionsWithWorker(jobId, timeWindow);
                    
                    // If we got fresh data, merge with any existing cached data
                    if (freshExecutions && freshExecutions.length > 0) {
                        this.log('getJobExecutions', `Got ${freshExecutions.length} fresh executions for non-ROI job, merging with cached`);
                        
                        try {
                            // Create a map to deduplicate executions by ID
                            const executionMap = new Map();
                            
                            // Add cached executions to the map
                            cachedData.data.forEach(exec => {
                                executionMap.set(exec.id, exec);
                            });
                            
                            // Add fresh executions (will overwrite if same ID)
                            freshExecutions.forEach(exec => {
                                executionMap.set(exec.id, exec);
                            });
                            
                            // Convert back to array
                            const mergedExecutions = Array.from(executionMap.values());
                            
                            // Update cache with merged data
                            await this.cacheExecutions(jobId, mergedExecutions, timeWindow);
                            
                            // Filter by date range if needed
                            if (timeWindow && timeWindow > 0) {
                                const cutoffDate = moment().startOf('day').subtract(timeWindow, 'days');
                                return this.filterExecutionsByDate(mergedExecutions, cutoffDate);
                            }
                            
                            return mergedExecutions;
                        } catch (mergeError) {
                            this.logError('getJobExecutions:merge', mergeError, { jobId });
                            // If merge fails, return just the fresh data
                            return freshExecutions;
                        }
                    } else {
                        this.log('getJobExecutions', `No fresh executions found for non-ROI job ${jobId}, using cached data`);
                        // If no fresh data, use the cached data even if it's stale
                        return cachedData.data;
                    }
                } else {
                    // No cached data at all for a job without ROI, we must fetch it
                    // console.log(`DEBUG: No cached data for non-ROI job ${jobId}, SHOULD be fetching via API`);
                    this.log('getJobExecutions', `No cached data for non-ROI job ${jobId}, fetching for the first time`);
                    return await this.fetchExecutionsWithWorker(jobId, timeWindow);
                }
            }
            
            // For jobs with ROI metrics, proceed with normal cache/refresh logic
            // Check if we have valid cached data
            if (cachedData && cachedData.data && Array.isArray(cachedData.data)) {
                const now = Date.now();
                const dataAge = now - cachedData.timestamp;
                
                // Check if cache is fresh enough and covers the requested date range
                // NOTE: needsCacheRefresh is now async and checks ROI's cache as well
                if (dataAge < this.EXECUTION_CACHE_TTL && 
                    !(await this.needsCacheRefresh(cachedData, dateRange))) {
                    
                    // Log the cache hit
                    this.logGroup('getJobExecutions:cacheHit', {
                        jobId,
                        cacheKey: executionCacheKey,
                        dataAge: `${(dataAge / (1000 * 60)).toFixed(1)} minutes`,
                        executionCount: cachedData.data.length,
                        timeWindow,
                        cachedDateRange: cachedData.dateRange || 'unknown',
                        requestedDateRange: dateRange,
                        hasRoiMetrics
                    });

                    // Filter by date if needed
                    if (timeWindow && timeWindow > 0) {
                        const cutoffDate = moment().startOf('day').subtract(timeWindow, 'days');
                        return this.filterExecutionsByDate(cachedData.data, cutoffDate);
                    }
                    
                    return cachedData.data;
                } else {
                    this.log('getJobExecutions', `Cache needs refresh for job ${jobId}, age: ${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours`);
                    
                    // Use the worker to get new data - no direct API calls
                    const freshExecutions = await this.fetchExecutionsWithWorker(jobId, timeWindow);
                        
                    // If we got fresh data, merge with cached data
                    if (freshExecutions && freshExecutions.length > 0) {
                        this.log('getJobExecutions', `Got ${freshExecutions.length} fresh executions, merging with cached`);
                        
                        try {
                            // Create a map to deduplicate executions by ID
                            const executionMap = new Map();
                            
                            // Add cached executions to the map
                            cachedData.data.forEach(exec => {
                                executionMap.set(exec.id, exec);
                            });
                            
                            // Add fresh executions (will overwrite if same ID)
                            freshExecutions.forEach(exec => {
                                executionMap.set(exec.id, exec);
                            });
                            
                            // Convert back to array
                            const mergedExecutions = Array.from(executionMap.values());
                            
                            // Update cache with merged data
                            await this.cacheExecutions(jobId, mergedExecutions, timeWindow);
                            
                            // Filter by date range if needed
                            if (timeWindow && timeWindow > 0) {
                                const cutoffDate = moment().startOf('day').subtract(timeWindow, 'days');
                                return this.filterExecutionsByDate(mergedExecutions, cutoffDate);
                            }
                            
                            return mergedExecutions;
                        } catch (mergeError) {
                            this.logError('getJobExecutions:merge', mergeError, { jobId });
                            // If merge fails, return just the fresh data
                            return freshExecutions;
                        }
                    } else {
                        this.log('getJobExecutions', `No fresh executions found for job ${jobId}, using cached data`);
                        // If no fresh data, use the cached data even if it's stale
                        return cachedData.data;
                    }
                }
            }
            this.log('getJobExecutions', `Cache miss for job ${jobId}, using worker to fetch data`);
            return await this.fetchExecutionsWithWorker(jobId, timeWindow);
        } catch (error) {
            this.logError('getJobExecutions', error, { jobId, timeWindow });
            
            // Always use worker even on errors
            return await this.fetchExecutionsWithWorker(jobId, timeWindow);
        }
    }
    
    // We've removed direct API fetching and are only using the worker
    // This method is kept as a stub for compatibility, but redirects to worker implementation
    async fetchExecutions(jobId, timeWindow) {
        // console.log(`DEBUG: fetchExecutions called for job ${jobId} - this is where we should fetch fresh data for non-ROI jobs`);
        this.log('fetchExecutions', `Direct API fetch is disabled - redirecting to worker for job ${jobId}`);
        return this.fetchExecutionsWithWorker(jobId, timeWindow);
    }
    
    /**
     * Synchronize time windows with ROI Summary plugin
     * This helps keep both plugins showing consistent data
     */
    synchronizeTimeWindowWithRoi(timeWindow) {
        try {
            // Make sure timeWindow is a valid number
            if (typeof timeWindow !== 'number' || isNaN(timeWindow)) {
                this.log('synchronizeTimeWindowWithRoi', 'Invalid time window value', { timeWindow });
                return false;
            }
            
            // Check ROI plugin's time window setting
            const roiTimeWindowValue = localStorage.getItem('rundeck.plugin.roisummary.queryMax');
            const roiTimeWindow = parseInt(roiTimeWindowValue, 10);
            
            // If values don't match (with proper number comparison), update ROI's value to match ours
            if (isNaN(roiTimeWindow) || roiTimeWindow !== timeWindow) {
                this.log('synchronizeTimeWindowWithRoi', `Syncing time window with ROI summary plugin: ${timeWindow} days`, {
                    metrics: timeWindow,
                    roi: roiTimeWindowValue,
                    roiParsed: roiTimeWindow
                });
                
                localStorage.setItem('rundeck.plugin.roisummary.queryMax', timeWindow.toString());
                
                // Also ensure our cache will respect this timeWindow
                this.log('synchronizeTimeWindowWithRoi', 'Updated time window, adjusting cache thresholds');
                
                return true;
            }
        } catch (e) {
            // Ignore localStorage errors
            this.log('synchronizeTimeWindowWithRoi', `Error syncing time window: ${e.message}`);
        }
        return false;
    }
    
    // Store fetched executions in cache - preserves existing ROI data
    async cacheExecutions(jobId, executions, timeWindow) {
        // Always cache executions, even if empty
        if (!executions) {
            executions = [];
        }
        
        try {
            // Make sure DB is available
            if (!this.dbInitialized) {
                try {
                    await this.ensureDbConnection();
                } catch (error) {
                    this.logError('cacheExecutions', new Error('Cannot cache executions - database not available'), { cause: error });
                    return;
                }
            }
            
            // First check if we already have cached data for this job that we can merge with
            let existingData = null;
            let existingRoiData = null;
            
            // Check if any execution has the hasRoi property already set from the worker
            let hasRoiFromExecution = executions.length > 0 && 'hasRoi' in executions[0] ? 
                !!executions[0].hasRoi : null;
            
            // Use hasRoi from executions if available as our primary source
            let hasRoiMetrics = hasRoiFromExecution; // Will be determined or overridden during the process
            
            try {
                // Check our own cache first
                const executionCacheKey = jobId;
                existingData = await this.get(this.DB_CONFIG.stores.executionCache, executionCacheKey);
                
                if (existingData) {
                    this.log('cacheExecutions', `Found existing cached executions for job ${jobId}, will merge with new data`);
                }
                
                // First check our own job cache for ROI status
                const ourJobCache = await this.get(this.DB_CONFIG.stores.jobCache, jobId);
                if (ourJobCache && ('hasRoi' in ourJobCache)) {
                    existingRoiData = { hasRoi: ourJobCache.hasRoi };
                    hasRoiMetrics = ourJobCache.hasRoi;
                    this.log('cacheExecutions', `Found existing ROI status in our cache for job ${jobId}`, {
                        hasRoi: hasRoiMetrics
                    });
                } else {
                    // If not in our cache, check the ROI plugin's cache
                    const roiJobCache = await this.get(this.ROI_DB_CONFIG.stores.jobCache, jobId);
                    if (roiJobCache && ('hasRoi' in roiJobCache)) {
                        existingRoiData = { hasRoi: roiJobCache.hasRoi };
                        hasRoiMetrics = roiJobCache.hasRoi;
                        this.log('cacheExecutions', `Found existing ROI data in ROI cache for job ${jobId}`, {
                            hasRoi: hasRoiMetrics
                        });
                    }
                }
                
                // Only check ROI cache for jobs with hasRoi=true
                // This implements the request to not use ROI cache for non-ROI jobs
                if (hasRoiMetrics === true && this.roiDb) {
                    try {
                        // Try to get execution data directly from ROI cache
                        const roiExecutionData = await this.getFromDb(this.roiDb, this.ROI_DB_CONFIG.stores.executionCache, executionCacheKey);
                        
                        if (roiExecutionData && roiExecutionData.data && roiExecutionData.data.length > 0) {
                            this.log('cacheExecutions', `Found execution data in ROI cache for job ${jobId} with ROI metrics, copying to our cache`, {
                                executions: roiExecutionData.data.length
                            });
                            
                            // For ROI jobs, always use the ROI data as the source of truth
                            // This helps maintain consistency between the plugins
                            if (!existingData) {
                                existingData = roiExecutionData;
                            } else {
                                // If we already have data but ROI data is newer, use ROI data
                                if (roiExecutionData.timestamp && (!existingData.timestamp || roiExecutionData.timestamp > existingData.timestamp)) {
                                    this.log('cacheExecutions', `ROI cache has newer data for job ${jobId}, using it instead`, {
                                        roiTimestamp: new Date(roiExecutionData.timestamp).toISOString(),
                                        ourTimestamp: existingData.timestamp ? new Date(existingData.timestamp).toISOString() : 'none'
                                    });
                                    existingData = roiExecutionData;
                                }
                            }
                        }
                    } catch (error) {
                        this.logError('cacheExecutions:roiCacheLookup', error, { jobId });
                        // Continue without ROI data
                    }
                } else if (hasRoiMetrics === false) {
                    this.log('cacheExecutions', `Job ${jobId} has no ROI metrics, not checking ROI cache`);
                }
                
                // If we still don't know ROI status, analyze executions to detect it
                if (hasRoiMetrics === null) {
                    // Try to detect based on ROI hours in executions
                    const hasRoiHours = executions.some(exec => 
                        exec.roiHours !== undefined && exec.roiHours !== null);
                    
                    // If we find any execution with ROI hours, it's a ROI job
                    if (hasRoiHours) {
                        hasRoiMetrics = true;
                        this.log('cacheExecutions', `Detected ROI metrics in executions for job ${jobId}`);
                    } else {
                        // If we have executions but none with ROI hours, mark as non-ROI
                        // But only if we have a reasonable number of executions to check
                        if (executions.length >= 5) {
                            hasRoiMetrics = false;
                            this.log('cacheExecutions', `No ROI metrics found in ${executions.length} executions for job ${jobId}, marking as non-ROI`);
                        } else {
                            this.log('cacheExecutions', `Not enough executions (${executions.length}) to determine ROI status for job ${jobId}`);
                            // Leave as null/undetermined
                        }
                    }
                }
            } catch (error) {
                this.log('cacheExecutions', `Error checking existing cache data: ${error.message}`);
                // Continue without existing data
            }
            
            // Determine the effective date range
            let dateRange = {
                begin: moment().startOf('day').subtract(timeWindow, 'days').format('YYYY-MM-DD'),
                end: moment().endOf('day').format('YYYY-MM-DD')
            };
            
            // If we have existing data with a date range, calculate the widest date range
            if (existingData && existingData.dateRange) {
                const existingDateRange = existingData.dateRange;
                
                // Find the earliest begin date
                const oldestDate = moment.min([
                    moment(dateRange.begin),
                    moment(existingDateRange.begin)
                ]).format('YYYY-MM-DD');
                
                // Find the latest end date
                const newestDate = moment.max([
                    moment(dateRange.end),
                    moment(existingDateRange.end)
                ]).format('YYYY-MM-DD');
                
                dateRange = {
                    begin: oldestDate,
                    end: newestDate
                };
                
                this.logGroup('cacheExecutions:mergedDateRange', {
                    jobId,
                    newDateRange: dateRange,
                    existingDateRange: existingDateRange,
                    mergedDateRange: dateRange
                });
            }
            
            // Prepare the data to store
            let dataToStore = executions;
            
            // If we have existing data, merge it with new executions
            if (existingData && existingData.data && Array.isArray(existingData.data)) {
                // Create a map to deduplicate executions by ID
                const executionMap = new Map();
                
                // Add existing executions to the map
                existingData.data.forEach(exec => {
                    executionMap.set(exec.id, exec);
                });
                
                // Add new executions, overwriting any with the same ID
                executions.forEach(exec => {
                    executionMap.set(exec.id, exec);
                });
                
                // Convert back to array
                dataToStore = Array.from(executionMap.values());
                
                this.log('cacheExecutions', `Merged ${existingData.data.length} existing and ${executions.length} new executions, total: ${dataToStore.length}`);
            }
            
            // Use the same format and key that ROI plugin would use - the raw jobId
            const cacheEntry = {
                id: jobId,
                jobId: jobId,
                data: dataToStore,
                timestamp: Date.now(),
                dateRange: dateRange,
                hasRoi: hasRoiMetrics // Add hasRoi flag to cache entry to match ROI plugin structure
            };
            
            // Store the merged data in cache
            await this.set(this.DB_CONFIG.stores.executionCache, cacheEntry);
            
            // Also update job registry with all available information
            const jobInfo = {
                id: jobId,
                timestamp: Date.now()
            };
            
            // Add ROI status if we know it
            if (existingRoiData && 'hasRoi' in existingRoiData) {
                jobInfo.hasRoi = existingRoiData.hasRoi;
            } else if (hasRoiMetrics !== null) {
                jobInfo.hasRoi = hasRoiMetrics;
                // If we determined this from execution analysis, mark it
                if (executions.length > 0) {
                    jobInfo.detectedFrom = 'executions';
                }
            }
            
            // Update the job registry in our own DB
            await this.set(this.DB_CONFIG.stores.jobCache, jobInfo);
            
            
            this.log('cacheExecutions', `Cached ${dataToStore.length} executions for job ${jobId} in Job Metrics database`, {
                hasRoiMetrics: jobInfo.hasRoi !== undefined ? !!jobInfo.hasRoi : 'undetermined'
            });
        } catch (error) {
            this.logError('cacheExecutions', error, { jobId });
        }
    }
    
    // Helper to filter executions by date
    filterExecutionsByDate(executions, cutoffDate) {
        if (!executions || !executions.length || !cutoffDate) {
            return executions;
        }
        
        // Ensure cutoff date is normalized to the start of day for consistent comparison
        const cutoffMoment = moment(cutoffDate).startOf('day');
        
        const filteredExecutions = executions.filter(function (execution) {
            var dateStarted = execution['date-started']?.date || execution.dateStarted;
            // Make sure execution date is consistently normalized to start of day
            var executionDate = moment(dateStarted).startOf('day');
            // Use isSameOrAfter for consistent date comparison
            return executionDate.isSameOrAfter(cutoffMoment, 'day');
        });
        
        this.log('filterExecutionsByDate', `Filtered executions by date: ${executions.length} → ${filteredExecutions.length}`, {
            cutoffDate: cutoffMoment.format('YYYY-MM-DD'),
            retained: filteredExecutions.length,
            filtered: executions.length - filteredExecutions.length
        });
        
        return filteredExecutions;
    }

    /**
     * Initialize web worker for processing with locking mechanism
     * to prevent concurrent initializations
     */
    initWorker() {
        // If worker is already initialized, return it immediately
        if (this.worker && this.workerInitialized) {
            return Promise.resolve(this.worker);
        }

        // If there's already an initialization in progress, return that promise
        if (this.workerInitLock && this.workerInitPromise) {
            this.log('initWorker', 'Worker initialization already in progress, waiting...');
            return this.workerInitPromise;
        }

        // Terminate any existing failed worker before creating a new one
        if (this.worker && !this.workerInitialized) {
            this.terminateWorker();
        }

        // Set the lock to prevent concurrent initializations
        this.workerInitLock = true;
        
        // Create a new initialization promise
        this.workerInitPromise = this._doInitWorker()
            .finally(() => {
                // Always release the lock when done
                this.workerInitLock = false;
                this.workerInitPromise = null;
            });
            
        return this.workerInitPromise;
    }
    
    /**
     * Private method that handles the actual worker initialization
     * This is separated to support the locking mechanism
     */
    _doInitWorker() {
        return new Promise((resolve, reject) => {
            try {
                this.log('_doInitWorker', 'Initializing JobMetrics Worker');
                
                // Track init attempts for retry limiting
                this.workerInitFailCount++;
                if (this.workerInitFailCount > this.maxWorkerInitRetries) {
                    const tooManyRetriesError = new Error(`Worker initialization failed ${this.workerInitFailCount} times, exceeding max retries (${this.maxWorkerInitRetries})`);
                    this.logError('_doInitWorker:tooManyRetries', tooManyRetriesError);
                    reject(tooManyRetriesError);
                    return;
                }
                
                // Use same approach as ROI summary plugin to determine the worker path
                let workerUrl = '';
                
                try {
                    // Use the same path derivation as ROI plugin
                    workerUrl = '/assets/pro/ui-job-metrics/lib/jobMetricsWorker.js'
                    // Create worker
                    this.worker = new Worker(workerUrl);
                } catch (workerError) {
                    this.logError('_doInitWorker:createWorker', workerError, {
                        workerUrl,
                        attempts: this.workerInitFailCount
                    });
                    throw workerError;
                }
                
                // Set up error handler
                this.worker.onerror = (error) => {
                    this.logError('worker:error', error);
                    this.workerInitialized = false;
                    reject(error);
                };
                
                // Set up message handler
                this.worker.onmessage = (e) => {
                    // The permanent message handler is for normal operations
                    this.handleWorkerMessage(e);
                    
                    // Special handling for initialization confirmation
                    if (e.data.type === 'initialized') {
                        clearTimeout(initTimeout);
                        this.workerInitialized = true;
                        this.workerInitFailCount = 0; // Reset failure counter on success
                        this.log('_doInitWorker', 'Worker initialized successfully');
                        
                        // Removed health checks to improve performance
                        
                        resolve(this.worker);
                    }
                };
                
                // Set a timeout to avoid hanging indefinitely - use the configured timeout
                const initTimeout = setTimeout(() => {
                    if (!this.workerInitialized) {
                        const timeoutError = new Error('Worker initialization timed out');
                        this.logError('_doInitWorker:timeout', timeoutError);
                        reject(timeoutError);
                    }
                }, this.WORKER_INIT_TIMEOUT);
                
                // Send initialization message with app data
                this.worker.postMessage({
                    type: 'init',
                    data: {
                        rdBase: window.location.origin + '/',
                        projectName: this.projectName
                    }
                });
                
            } catch (error) {
                this.logError('_doInitWorker', error);
                reject(error);
            }
        });
    }
    
    /**
     * Handle messages from the worker
     */
    handleWorkerMessage(event) {
        const { type, requestId, results, error } = event.data;
        
        // Look up the pending request by ID
        const pendingRequest = this.pendingRequests.get(requestId);
        if (!pendingRequest && requestId) {
            this.log('handleWorkerMessage', `No pending request found for ID ${requestId}`);
            return;
        }
        
        switch (type) {
            case 'jobProcessed':
                this.log('handleWorkerMessage:jobProcessed', `Job ${results.jobId} processed`, {
                    executionCount: results.executions.length
                });
                
                // Store results in cache with a retry mechanism
                this.cacheExecutions(results.jobId, results.executions, pendingRequest?.timeWindow)
                    .catch(err => {
                        this.logError('cacheExecutions', err);
                        
                        // Try again after a short delay (helps with concurrent write issues)
                        setTimeout(() => {
                            this.cacheExecutions(results.jobId, results.executions, pendingRequest?.timeWindow)
                                .catch(retryErr => this.logError('cacheExecutions:retry', retryErr));
                        }, 500);
                    });
                
                // Resolve the pending request
                if (pendingRequest) {
                    pendingRequest.resolve(results.executions);
                    this.pendingRequests.delete(requestId);
                }
                break;
                
            case 'error':
                this.logError('handleWorkerMessage:error', new Error(error));
                
                // Reject the pending request
                if (pendingRequest) {
                    pendingRequest.reject(new Error(error));
                    this.pendingRequests.delete(requestId);
                }
                break;
                
            case 'metrics':
                this.log('handleWorkerMessage:metrics', 'Received metrics from worker', event.data.data);
                
                // If this was a health check request, resolve it
                if (pendingRequest && pendingRequest.type === 'healthCheck') {
                    pendingRequest.resolve(event.data.data);
                    this.pendingRequests.delete(requestId);
                }
                break;
                
            case 'initialized':
                this.log('handleWorkerMessage:initialized', 'Worker initialized successfully');
                break;
                
            case 'progress':
                this.log('handleWorkerMessage:progress', `Processing progress: ${event.data.processed}/${event.data.total}`);
                break;
                
            default:
                this.log('handleWorkerMessage:unknown', `Unknown message type: ${type}`);
        }
    }
    
    /**
     * Get a new request ID for worker communication
     */
    getNextRequestId() {
        this.requestCounter++;
        return `req_${Date.now()}_${this.requestCounter}`;
    }
    
    /**
     * Terminate the worker and clean up resources
     * This will terminate the worker thread and handle pending requests
     */
    terminateWorker() {
        if (!this.worker) {
            return;
        }
        
        this.log('terminateWorker', 'Terminating worker thread');
        
        try {
            // Health check functionality removed
            
            // Handle all pending requests
            if (this.pendingRequests.size > 0) {
                const error = new Error('Worker terminated while requests were pending');
                
                this.log('terminateWorker', `Rejecting ${this.pendingRequests.size} pending requests`);
                
                // Reject all pending requests
                for (const [requestId, requestInfo] of this.pendingRequests.entries()) {
                    try {
                        requestInfo.reject(error);
                    } catch (e) {
                        this.logError('terminateWorker:rejectRequest', e, { requestId });
                    }
                }
                
                // Clear the pending requests map
                this.pendingRequests.clear();
            }
            
            // Remove event listeners
            this.worker.onmessage = null;
            this.worker.onerror = null;
            
            // Terminate the worker thread
            this.worker.terminate();
            
            // Reset worker state
            this.worker = null;
            this.workerInitialized = false;
            
            this.log('terminateWorker', 'Worker terminated successfully');
        } catch (error) {
            this.logError('terminateWorker', error);
            // Reset worker state even if termination fails
            this.worker = null;
            this.workerInitialized = false;
        }
    }

    /**
     * Check if a job has ROI metrics or not
     * This allows us to decide whether to rely on ROI plugin data or fetch our own
     * @param {string} jobId The job ID to check
     * @return {Promise<boolean>} Whether the job has ROI metrics
     */
    async checkJobHasRoiMetrics(jobId) {
        // First check the window flag to see if ROI plugin is even installed
        if (window.RDPRO && 
            window.RDPRO["ui-jobmetrics"] && 
            window.RDPRO["ui-jobmetrics"].hasRoiSummary === false) {
            // If ROI Summary is not installed, no job can have ROI metrics
            this.log('checkJobHasRoiMetrics', `ROI Summary plugin is not installed, job ${jobId} cannot have ROI metrics`);
            return false;
        }
        

        // Next check if job cache has this info
        try {
            // Check our own DB first
            const ourJobCache = await this.get(this.DB_CONFIG.stores.jobCache, jobId);
            if (ourJobCache && ('hasRoi' in ourJobCache)) {
                // Only use if not assumed or not too old - assumptions should be rechecked periodically
                const isCacheStale = !ourJobCache.timestamp || 
                    (Date.now() - ourJobCache.timestamp > 8 * 60 * 60 * 1000); // 8 hours
                
                const isAssumed = !!ourJobCache.assumed;
                
                if (!isAssumed && !isCacheStale) {
                    
                    this.log('checkJobHasRoiMetrics', `Found ROI status in our job cache for ${jobId}`, {
                        hasRoi: !!ourJobCache.hasRoi,
                        fromOurCache: true,
                        age: ourJobCache.timestamp ? 
                            `${((Date.now() - ourJobCache.timestamp) / (1000 * 60)).toFixed(1)} minutes` : 'unknown'
                    });
                    
                    return !!ourJobCache.hasRoi;
                } else {
                    this.log('checkJobHasRoiMetrics', `Cached ROI status for job ${jobId} is stale or assumed, checking ROI cache`, {
                        isAssumed,
                        isCacheStale,
                        age: ourJobCache.timestamp ? 
                            `${((Date.now() - ourJobCache.timestamp) / (1000 * 60 * 60)).toFixed(1)} hours` : 'unknown'
                    });
                    // Fall through to check ROI cache
                }
            }
            
            // If not in our cache or data is stale, check ROI plugin's cache
            // But first verify ROI plugin is installed
            const roiSummaryInstalled = window.RDPRO && 
                window.RDPRO["ui-jobmetrics"] && 
                window.RDPRO["ui-jobmetrics"].hasRoiSummary !== false;
                
            if (roiSummaryInstalled && this.roiDb) {
                try {
                    // Check if the required store exists in the ROI database
                    if (!this.roiDb.objectStoreNames.contains(this.ROI_DB_CONFIG.stores.jobCache)) {
                        this.log('checkJobHasRoiMetrics', `Required store ${this.ROI_DB_CONFIG.stores.jobCache} doesn't exist in ROI database`);
                    } else {
                        // It's safe to access the store
                        const roiJobCache = await this.getFromDb(this.roiDb, this.ROI_DB_CONFIG.stores.jobCache, jobId);
                        if (roiJobCache && ('hasRoi' in roiJobCache)) {
                            const hasRoi = !!roiJobCache.hasRoi;
                            
                            // Update our DB cache
                            const jobInfo = {
                                id: jobId,
                                timestamp: Date.now(),
                                hasRoi: hasRoi
                            };
                            
                            // Store asynchronously to not block
                            this.set(this.DB_CONFIG.stores.jobCache, jobInfo)
                                .catch(err => this.logError('checkJobHasRoiMetrics:cacheError', err, { jobId }));
                            
                            this.log('checkJobHasRoiMetrics', `Found ROI status in ROI job cache for ${jobId}`, {
                                hasRoi: hasRoi,
                                fromRoiCache: true
                            });
                            
                            return hasRoi;
                        }
                    }
                } catch (error) {
                    this.log('checkJobHasRoiMetrics', `Error checking ROI cache: ${error.message}`);
                }
            } else if (!roiSummaryInstalled) {
                this.log('checkJobHasRoiMetrics', 'ROI Summary plugin is not installed, skipping ROI cache check');
            } else if (!this.roiDb) {
                this.log('checkJobHasRoiMetrics', 'ROI database connection not available');
            }
            
            // If we reach here, we don't have cached info about this job's ROI status
            // Since we don't want to make extra API calls just to check ROI status,
            // we'll assume it doesn't have ROI and let the fetch proceed normally
            
            this.log('checkJobHasRoiMetrics', `No cached ROI status for job ${jobId}, assuming no ROI metrics`);
            
            const jobInfo = {
                id: jobId,
                timestamp: Date.now(),
                hasRoi: false,
                assumed: true
            };
            
            // Store asynchronously
            this.set(this.DB_CONFIG.stores.jobCache, jobInfo)
                .catch(err => this.logError('checkJobHasRoiMetrics:cacheError', err, { jobId }));
            
            return false;
            
        } catch (error) {
            this.logError('checkJobHasRoiMetrics', error, { jobId });
            // On error, assume no ROI to be safe
            return false;
        }
    }

    /**
     * Check if we need to refresh the cache, considering both our cache and ROI's cache
     */
    async needsCacheRefresh(cachedData, dateRange) {
        if (!cachedData) return true;
        
        const now = Date.now();
        const dataAge = now - cachedData.timestamp;
        const jobId = cachedData.jobId || cachedData.id;
        
        // First check if this job has ROI metrics
        // If it doesn't, we shouldn't rely on ROI plugin cache and should handle it ourselves
        const hasRoiMetrics = await this.checkJobHasRoiMetrics(jobId);
        
        // Get ROI cache info if the job has ROI metrics
        let roiCacheData = null;
        let roiDataFresh = false;
        
        // First check if ROI Summary is installed using window flag
        const roiSummaryInstalled = window.RDPRO && 
            window.RDPRO["ui-jobmetrics"] && 
            window.RDPRO["ui-jobmetrics"].hasRoiSummary !== false;
        
        if (hasRoiMetrics && roiSummaryInstalled) {
            try {
                // Check if we have a roiDb connection and if it exists, check ROI's cache
                if (this.roiDb) {
                    // Check ROI's execution cache for this job
                    const roiCached = await this.getFromDb(this.roiDb, this.ROI_DB_CONFIG.stores.executionCache, jobId);
                    
                    if (roiCached && roiCached.data && roiCached.timestamp) {
                        const roiDataAge = now - roiCached.timestamp;
                        
                        // Check if ROI's data is fresh (within 1 hour)
                        if (roiDataAge < (1 * 60 * 60 * 1000)) {  // 1 hour
                            this.log('needsCacheRefresh', 'ROI cache is very fresh', {
                                jobId,
                                roiCacheAge: `${(roiDataAge / (1000 * 60)).toFixed(1)} minutes`,
                                executionCount: roiCached.data.length,
                                hasRoiMetrics
                            });
                            
                            // If ROI has very fresh data (within 1 hour), use it without refreshing
                            roiCacheData = roiCached;
                            roiDataFresh = true;
                            
                            // If our data is stale but ROI's is fresh, copy their data to our cache
                            if (dataAge >= (this.CACHE_FRESHNESS_THRESHOLD * 60 * 60 * 1000)) {
                                this.log('needsCacheRefresh', 'Copying fresh ROI data to our cache', {
                                    jobId,
                                    roiCacheAge: `${(roiDataAge / (1000 * 60)).toFixed(1)} minutes`,
                                    ourCacheAge: `${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours`
                                });
                                
                                // Make a copy to avoid reference issues
                                const copiedData = {
                                    id: jobId,
                                    jobId: jobId,
                                    data: [...roiCached.data],
                                    timestamp: now,  // Use current time as we're refreshing our cache
                                    dateRange: roiCached.dateRange || dateRange,
                                    hasRoi: roiCached.hasRoi !== undefined ? roiCached.hasRoi : hasRoiMetrics
                                };
                                
                                // Store in our cache asynchronously
                                this.set(this.DB_CONFIG.stores.executionCache, copiedData)
                                    .catch(err => this.logError('needsCacheRefresh:copyCache', err, { jobId }));
                            }
                        }
                    }
                }
            } catch (error) {
                // Non-fatal, continue with normal cache check
                this.logError('needsCacheRefresh:roiCheck', error);
            }
        } else if (!roiSummaryInstalled) {
            this.log('needsCacheRefresh', 'ROI Summary plugin is not installed (checked window flag)');
        } else {
            this.log('needsCacheRefresh', `Job ${jobId} has no ROI metrics, will use our own cache`, {
                jobId,
                hasRoiMetrics
            });
        }
        
        // If ROI data isn't available, not fresh, or job has no ROI metrics, check our cache age
        if (dataAge >= (this.CACHE_FRESHNESS_THRESHOLD * 60 * 60 * 1000)) {
            this.log('needsCacheRefresh', 'Cache exceeds freshness threshold', {
                cacheAge: `${(dataAge / (1000 * 60 * 60)).toFixed(1)} hours`,
                threshold: `${this.CACHE_FRESHNESS_THRESHOLD} hours`,
                hasRoiMetrics
            });
            return true;
        }
        
        // If the requested date range is not fully covered by cache, it needs refresh
        if (dateRange && cachedData.dateRange) {
            // Normalize dates by explicitly setting to start/end of day to ensure consistent comparison
            // Use 'YYYY-MM-DD' as the format to strip time parts and ensure proper comparison
            const requestedBegin = moment(dateRange.begin).startOf('day');
            const requestedEnd = moment(dateRange.end).endOf('day');
            const cachedBegin = moment(cachedData.dateRange.begin).startOf('day');
            const cachedEnd = moment(cachedData.dateRange.end).endOf('day');
            
            // Compare the dates using moment methods to ensure proper date comparison
            const isBeginCovered = requestedBegin.isSameOrAfter(cachedBegin, 'day');
            const isEndCovered = requestedEnd.isSameOrBefore(cachedEnd, 'day');
            
            // If cached date range doesn't fully contain requested range, needs refresh
            if (!isBeginCovered || !isEndCovered) {
                this.log('needsCacheRefresh', 'Requested date range not fully covered by cache', {
                    requestedRange: `${dateRange.begin} to ${dateRange.end}`,
                    cachedRange: `${cachedData.dateRange.begin} to ${cachedData.dateRange.end}`,
                    requestedMoment: `${requestedBegin.format('YYYY-MM-DD')} to ${requestedEnd.format('YYYY-MM-DD')}`,
                    cachedMoment: `${cachedBegin.format('YYYY-MM-DD')} to ${cachedEnd.format('YYYY-MM-DD')}`,
                    isBeginCovered,
                    isEndCovered,
                    hasRoiMetrics
                });
                return true;
            }
        }
        
        return false;
    }

    /**
     * Fetch executions using the worker
     */
    async fetchExecutionsWithWorker(jobId, timeWindow) {
        // console.log(`DEBUG: fetchExecutionsWithWorker called for job ${jobId} - THIS IS THE ACTUAL FETCH IMPLEMENTATION`);
        // Check if there's already a fetch in progress for this job with similar timeWindow
        const inProgressKey = `worker_${jobId}_${timeWindow}`;
        if (this.fetchOperationsInProgress.has(inProgressKey)) {
            this.log('fetchExecutionsWithWorker', `Worker fetch already in progress for job ${jobId}, reusing promise`);
            return this.fetchOperationsInProgress.get(inProgressKey);
        }
        
        // Create a new fetch promise
        const fetchPromise = this._doFetchExecutionsWithWorker(jobId, timeWindow, inProgressKey);
        
        // Store the promise for potential reuse
        this.fetchOperationsInProgress.set(inProgressKey, fetchPromise);
        
        return fetchPromise;
    }
    
    /**
     * Internal method to perform the actual worker fetch
     * This separation allows for proper cleanup of the in-progress tracking
     */
    async _doFetchExecutionsWithWorker(jobId, timeWindow, inProgressKey) {
        try {
            // Try to initialize worker if not already done
            try {
                await this.initWorker();
            } catch (workerInitError) {
                // If worker fails to initialize, log and fall back to direct API
                this.logError('fetchExecutionsWithWorker:initFailed', workerInitError);
                this.log('fetchExecutionsWithWorker', 'Falling back to direct API due to worker init failure');
                this.fetchOperationsInProgress.delete(inProgressKey); // Clean up tracking
                return await this.fetchExecutions(jobId, timeWindow);
            }
            
            // Double-check if worker is initialized before proceeding
            if (!this.workerInitialized) {
                this.log('fetchExecutionsWithWorker', 'Worker still not initialized after init attempt, falling back to API');
                this.fetchOperationsInProgress.delete(inProgressKey); // Clean up tracking
                return await this.fetchExecutions(jobId, timeWindow);
            }

            // Calculate date range from timeWindow using moment to ensure consistent format with other methods
            const dateRange = {
                begin: moment().startOf('day').subtract(timeWindow, 'days').format('YYYY-MM-DD'),
                end: moment().endOf('day').format('YYYY-MM-DD')
            };
            
            // Check if we already have data in cache before making the request
            try {
                // Try to get cached data from executionCache
                const executionCacheKey = jobId;
                const cachedData = await this.get(this.DB_CONFIG.stores.executionCache, executionCacheKey);
                
                // Check if we have valid and fresh cached data
                if (cachedData && cachedData.data && Array.isArray(cachedData.data) && 
                    !this.needsCacheRefresh(cachedData, dateRange)) {
                    
                    this.logGroup('fetchExecutionsWithWorker:cacheHit', {
                        jobId,
                        cacheKey: executionCacheKey,
                        dataAge: `${((Date.now() - cachedData.timestamp) / (1000 * 60)).toFixed(1)} minutes`,
                        executionCount: cachedData.data.length,
                        dateRange
                    });
                    this.fetchOperationsInProgress.delete(inProgressKey); // Clean up tracking
                    return cachedData.data;
                }
            } catch (cacheError) {
                // Non-fatal, continue with worker request
                this.logError('fetchExecutionsWithWorker:cacheCheck', cacheError, { jobId });
            }
            
            // Create a unique request ID
            const requestId = this.getNextRequestId();
            
            // Create a promise that will be resolved when the worker responds
            const promise = new Promise((resolve, reject) => {
                this.pendingRequests.set(requestId, {
                    jobId,
                    timeWindow,
                    dateRange,
                    timestamp: Date.now(),
                    resolve,
                    reject
                });
                
                // Set a timeout to avoid hanging indefinitely
                setTimeout(() => {
                    if (this.pendingRequests.has(requestId)) {
                        const error = new Error(`Request timeout for job ${jobId}`);
                        this.logError('fetchExecutionsWithWorker:timeout', error);
                        this.pendingRequests.get(requestId).reject(error);
                        this.pendingRequests.delete(requestId);
                        this.fetchOperationsInProgress.delete(inProgressKey); // Clean up tracking
                    }
                }, 30000);
            });
            
            // Send the request to the worker
            this.worker.postMessage({
                type: 'fetchAndProcessJob',
                id: requestId,
                data: {
                    jobId,
                    timeWindow,
                    dateRange
                }
            });
            
            this.log('fetchExecutionsWithWorker', `Request sent to worker for job ${jobId}`, {
                requestId,
                timeWindow,
                dateRange
            });
            
            try {
                // Get the executions from the worker
                const executions = await promise;
                
                // Explicitly cache the results before returning
                await this.cacheExecutions(jobId, executions, timeWindow);
                
                // Clean up the in-progress tracking
                setTimeout(() => {
                    this.fetchOperationsInProgress.delete(inProgressKey);
                }, 500); // Short delay to handle closely-timed duplicates
                
                return executions;
            } catch (error) {
                // Clean up tracking on error
                this.fetchOperationsInProgress.delete(inProgressKey);
                throw error; // Re-throw to be caught by outer catch
            }
        } catch (error) {
            this.logError('fetchExecutionsWithWorker', error, { jobId, timeWindow });
            // Clean up tracking before falling back
            this.fetchOperationsInProgress.delete(inProgressKey);
            // Fall back to standard fetch if worker fails
            return await this.fetchExecutions(jobId, timeWindow);
        }
    }
}