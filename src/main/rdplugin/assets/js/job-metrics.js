var DEBUG = false;
function log(...args) {
    if (DEBUG) console.log(...args);
}

let message = jobListSupport.i18Message('ui-jobmetrics', 'message.key');

function filterExecutionsByDate(executions, cutoffDate) {
    var executionsByDate = {};
    executions.forEach(function(execution) {
        var dateStarted = execution['date-started']?.date || execution.dateStarted;
        
        if (typeof dateStarted === 'string') {
            var executionDate = moment(dateStarted).format('YYYY-MM-DD');
            if (!executionsByDate[executionDate]) {
                executionsByDate[executionDate] = [];
            }
            executionsByDate[executionDate].push(execution);
        }
    });

    return executions.filter(function(execution) {
        var dateStarted = execution['date-started']?.date || execution.dateStarted;
        var executionDate = moment(dateStarted).startOf('day');
        var cutoffMoment = moment(cutoffDate).startOf('day');
        return executionDate.isAfter(cutoffMoment) || 
               executionDate.isSame(cutoffMoment, 'day');
    });
}

function JobMetricsListView() {
    var self = this;
    self.project = ko.observable(window.projectName || jQuery('#projectSelect').val());
    self.jobs = ko.observableArray([]);
    self.loading = ko.observable(false);
    self.jobmap = {};

    // Time window for metrics
    self.timeWindow = ko.observable(30);
    
    // Metrics tracking
    self.totalExecutions = ko.observable(0);
    self.successRate = ko.observable(0);
    self.avgDuration = ko.observable(0);
    self.failureCount = ko.observable(0);

    self.sortField = ko.observable('name');
    self.sortDirection = ko.observable('asc');

    // Computed for sorted jobs
    self.sortedJobs = ko.computed(function() {
        return self.jobs().sort(function(a, b) {
            var aValue, bValue;
            switch (self.sortField()) {
                case 'name':
                    return (self.sortDirection() === 'asc') ? 
                           a.name().localeCompare(b.name()) : 
                           b.name().localeCompare(a.name());
                case 'executions':
                    return (self.sortDirection() === 'asc') ? 
                           a.executionCount() - b.executionCount() : 
                           b.executionCount() - a.executionCount();
                case 'success':
                    return (self.sortDirection() === 'asc') ? 
                           a.successRate() - b.successRate() : 
                           b.successRate() - a.successRate();
                case 'duration':
                    return (self.sortDirection() === 'asc') ? 
                           a.avgDuration() - b.avgDuration() : 
                           b.avgDuration() - a.avgDuration();
            }
        });
    });

    // Summary metrics computed
    self.summaryMetrics = ko.computed(function() {
        var jobs = self.sortedJobs();
        if (jobs.length === 0) return null;

        return {
            totalJobs: jobs.length,
            totalExecutions: jobs.reduce((sum, job) => sum + job.executionCount(), 0),
            avgSuccessRate: jobs.reduce((sum, job) => sum + job.successRate(), 0) / jobs.length,
            avgDuration: jobs.reduce((sum, job) => sum + job.avgDuration(), 0) / jobs.length
        };
    });

    self.refreshExecData = function() {
        if (self.loading()) return;
        
        self.loading(true);
        var jobs = self.jobs();

        jobs.forEach(function(job) {
            var execUrl = _genUrl(appLinks.scheduledExecutionJobExecutionsAjax, {
                id: job.id,
                max: 1000,
                format: 'json',
                recentFilter: 'false',
                begin: moment().startOf('day')
                    .subtract(self.timeWindow() - 1, 'days')
                    .format('YYYY-MM-DD'),
                end: moment().endOf('day').format('YYYY-MM-DD')
            });

            jQuery.ajax({
                url: execUrl,
                method: 'GET',
                success: function(data) {
                    if (data.executions && data.executions.length > 0) {
                        var cutoffDate = moment().startOf('day')
                            .subtract(self.timeWindow() - 1, 'days');
                        var filteredExecutions = filterExecutionsByDate(
                            data.executions, 
                            cutoffDate
                        );
                        
                        job.processExecutions(filteredExecutions);
                    }
                },
                complete: function() {
                    self.loading(false);
                }
            });
        });
    };

    self.loadJobs = function() {
        var foundJobs = jQuery('.jobname[data-job-id]');
        var jobsArr = [];

        foundJobs.each(function(idx, el) {
            var jel = jQuery(el);
            var job = new JobMetrics({
                id: jel.data('jobId'),
                name: jel.data('jobName'),
                group: jel.data('jobGroup'),
                project: self.project()
            });
            jobsArr.push(job);
            self.jobmap[job.id] = job;
        });

        self.jobs(jobsArr);
    };

    // Sort handling
    self.sort = function(field) {
        if (self.sortField() === field) {
            self.sortDirection(self.sortDirection() === 'asc' ? 'desc' : 'asc');
        } else {
            self.sortField(field);
            self.sortDirection('asc');
        }
    };
}

function JobMetrics(data) {
    var self = this;
    
    // Basic job info
    self.id = data.id;
    self.name = ko.observable(data.name);
    self.group = ko.observable(data.group);
    
    // Execution metrics
    self.executionCount = ko.observable(0);
    self.successCount = ko.observable(0);
    self.failureCount = ko.observable(0);
    self.successRate = ko.observable(0);
    self.avgDuration = ko.observable(0);
    self.totalDuration = ko.observable(0);
    
    // Process executions data
    self.processExecutions = function(executions) {
        var successful = 0;
        var totalDuration = 0;
        
        executions.forEach(function(execution) {
            if (execution.status === 'succeeded') {
                successful++;
            }
            
            if (execution.duration) {
                totalDuration += execution.duration;
            }
        });

        self.executionCount(executions.length);
        self.successCount(successful);
        self.failureCount(executions.length - successful);
        self.successRate(executions.length > 0 ? 
            (successful / executions.length) * 100 : 0);
        self.avgDuration(executions.length > 0 ? 
            totalDuration / executions.length : 0);
        self.totalDuration(totalDuration);
    };

    // Format duration for display
    self.formatDuration = function(seconds) {
        return moment.duration(seconds, 'seconds').humanize();
    };

    // Computed for formatted display values
    self.formattedSuccessRate = ko.computed(function() {
        return self.successRate().toFixed(1) + '%';
    });

    self.formattedAvgDuration = ko.computed(function() {
        return self.formatDuration(self.avgDuration());
    });
}

// Initialize on document ready
jQuery(function() {
    var pagePath = rundeckPage.path();
    
    if (pagePath === 'menu/jobs') {
        var metricsView = new JobMetricsListView();
        
        // Initialize plugin
        jobListSupport.init_plugin('ui-jobmetrics', function() {
            var pluginUrl = rundeckPage.pluginBaseUrl('ui-jobmetrics');
            
            jQuery.get(pluginUrl + '/html/table.html', function(templateHtml) {
                let tablink = jobListSupport.initPage(
                    '#indexMain',
                    'Job Metrics',
                    'jobmetricsview',
                    'jobmetricstab',
                    'Execution Metrics',
                    templateHtml,
                    function(elem) {
                        metricsView.loadJobs();
                        ko.applyBindings({ jobmetrics: metricsView }, elem);
                        metricsView.refreshExecData();
                    }
                );
            });
        });
    }
});