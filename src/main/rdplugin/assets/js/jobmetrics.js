//= require ./lib/support
//= require ./lib/executionDataManager
function initJobMetrics () {
  console.log('Check if Job Metrics should be initialized')

  const currentUi = !!document.querySelector('.ui-type-current')
  if (currentUi) {
    console.log('Initializing Job Metrics')
    var jobListSupport = new JobListSupport()
    let dataManager;

    jQuery(function () {
      var DEBUG = true
      function log (...args) {
        if (DEBUG) console.log(...args)
      }

      function _genUrl (template, data) {
        var url = template
        for (var k in data) {
          url = url.replace('${' + k + '}', encodeURIComponent(data[k]))
        }
        return url
      }

      function filterExecutionsByDate (executions, cutoffDate) {
        var executionsByDate = {}
        executions.forEach(function (execution) {
          var dateStarted =
            execution['date-started']?.date || execution.dateStarted

          if (typeof dateStarted === 'string') {
            var executionDate = moment(dateStarted).format('YYYY-MM-DD')
            if (!executionsByDate[executionDate]) {
              executionsByDate[executionDate] = []
            }
            executionsByDate[executionDate].push(execution)
          }
        })

        return executions.filter(function (execution) {
          var dateStarted =
            execution['date-started']?.date || execution.dateStarted
          var executionDate = moment(dateStarted).startOf('day')
          var cutoffMoment = moment(cutoffDate).startOf('day')
          return (
            executionDate.isAfter(cutoffMoment) ||
            executionDate.isSame(cutoffMoment, 'day')
          )
        })
      }

      function GraphOptions (data) {
        var self = this

        // Initialize timeWindow with saved value or default
        const savedTimeWindow = localStorage.getItem(
          'rundeck.plugin.ui-jobmetrics.timeWindow'
        )
        self.queryMax = ko.observable(
          savedTimeWindow ? parseInt(savedTimeWindow) : 10
        )

        // Add validation and persistence for queryMax
        self.queryMax.subscribe(function (newValue) {
          // Convert to integer and validate
          var days = parseInt(newValue)
          if (isNaN(days) || days < 1) {
            console.log('Invalid days value. Must be a positive whole number.')
            self.queryMax(10)
            return
          }
          // Ensure it's a whole number
          if (days !== parseFloat(newValue)) {
            console.log(
              'Days value must be a whole number. Rounding to nearest integer.'
            )
            self.queryMax(days)
            return
          }
          // Save to localStorage
          localStorage.setItem(
            'rundeck.plugin.ui-jobmetrics.timeWindow',
            days.toString()
          )
        })

        // Initialize showZeroExecutions with saved value or default to false
        const savedShowZeroExecutions = localStorage.getItem(
          'rundeck.plugin.ui-jobmetrics.showZeroExecutions'
        )
        self.showZeroExecutions = ko.observable(
          savedShowZeroExecutions ? savedShowZeroExecutions === 'true' : false
        )

        // Add persistence for showZeroExecutions
        self.showZeroExecutions.subscribe(function (newValue) {
          localStorage.setItem(
            'rundeck.plugin.ui-jobmetrics.showZeroExecutions',
            newValue.toString()
          )
        })
      }

      function getChartThemeColors () {
        const isDarkMode =
          document.documentElement.getAttribute('data-color-theme') === 'dark'
        return {
          textColor: isDarkMode ? '#ffffff' : '#666666',
          gridColor: isDarkMode
            ? 'rgba(160, 160, 160, 0.1)'
            : 'rgba(0, 0, 0, 0.1)',
          borderColor: isDarkMode
            ? 'rgba(160, 160, 160, 0.2)'
            : 'rgba(0, 0, 0, 0.2)'
        }
      }

      // Initialize data manager
      dataManager = new ExecutionDataManager(window._rundeck?.projectName || rundeckPage.project());
      log('Data manager initialized:', dataManager);
      
      // Initialize worker in the background
      dataManager.initWorker().then(() => {
        log('Worker initialized successfully');
      }).catch(err => {
        log('Worker initialization failed:', err.message);
      });

      function JobMetricsListView (pluginName) {
        var self = this
        self.project = ko.observable(rundeckPage.project())
        self.jobs = ko.observableArray([])
        self.loading = ko.observable(false)
        self.jobmap = {}
        self.successRateChart = null
        self.timeHeatMapChart = null

        // Initialize with GraphOptions
        self.graphOptions = ko.observable(new GraphOptions())

        self.graphOptions().queryMax.subscribe(function (newValue) {
          // Only log in one place
          if (DEBUG) {
            console.log('Time window changed:', {
              newValue: parseInt(newValue),
              type: typeof parseInt(newValue)
            })
          }
          self.graphOptions().queryMax(parseInt(newValue))
          self.refreshExecData()
        })
        
        // Listen for showZeroExecutions changes
        self.graphOptions().showZeroExecutions.subscribe(function (newValue) {
          if (DEBUG) {
            console.log('Show zero executions changed:', newValue)
          }
          // No need to refresh data, just trigger UI update
          self.jobs.valueHasMutated()
        })

        // Time window for metrics
        self.timeWindow = ko.computed(function () {
          return parseInt(self.graphOptions().queryMax())
        })

        // Metrics tracking
        self.totalExecutions = ko.observable(0)
        self.successRate = ko.observable(0)
        self.avgDuration = ko.observable(0)
        self.failureCount = ko.observable(0)

        self.sortField = ko.observable('name')
        self.sortDirection = ko.observable('asc')

        // Computed for sorted jobs
        self.sortedJobs = ko.computed(function () {
          var jobs = self.jobs();
          var sortField = self.sortField();
          var sortDirection = self.sortDirection();
          
          // Filter jobs based on showZeroExecutions setting
          var filteredJobs = jobs.filter(function(job) {
              return job.executionCount() > 0 || self.graphOptions().showZeroExecutions();
          });
      
          return filteredJobs.sort(function (a, b) {
              var aValue, bValue;
              switch (sortField) {
                  case 'name':
                      aValue = a.name().toLowerCase();
                      bValue = b.name().toLowerCase();
                      break;
                  case 'executions':
                      aValue = a.executionCount();
                      bValue = b.executionCount();
                      break;
                  case 'success': // Correctly handle 'success' field
                      aValue = a.successRate();
                      bValue = b.successRate();
                      break;
                  case 'duration':
                      aValue = a.avgDuration();
                      bValue = b.avgDuration();
                      break;
                  default:
                      return 0; // Don't sort if the field is not recognized
              }
      
              if (sortDirection === 'asc') {
                  return aValue < bValue ? -1 : (aValue > bValue ? 1 : 0); // Correct comparison
              } else {
                  return aValue > bValue ? -1 : (aValue < bValue ? 1 : 0); // Correct comparison
              }
          });
      });

        // Get Header Icons in table
        self.getSortIcon = function (field) {
          if (self.sortField() !== field) {
            return 'glyphicon glyphicon-sort'
          }
          return self.sortDirection() === 'asc'
            ? 'glyphicon glyphicon-sort-by-attributes'
            : 'glyphicon glyphicon-sort-by-attributes-alt'
        }

        // Summary metrics computed
        self.summaryMetrics = ko.computed(function () {
          var jobs = self.sortedJobs()
          if (jobs.length === 0) return null

          // Filter jobs to only include those with executions
          var jobsWithExecutions = jobs.filter(job => job.executionCount() > 0)

          return {
            totalJobs: jobs.length,
            totalExecutions: jobs.reduce(
              (sum, job) => sum + job.executionCount(),
              0
            ),
            avgSuccessRate:
              jobsWithExecutions.length > 0
                ? jobsWithExecutions.reduce(
                    (sum, job) => sum + job.successRate(),
                    0
                  ) / jobsWithExecutions.length
                : 0,
            avgDuration:
              jobsWithExecutions.length > 0
                ? jobsWithExecutions.reduce(
                    (sum, job) => sum + job.avgDuration(),
                    0
                  ) / jobsWithExecutions.length
                : 0,
            jobsWithNoExecutions:
              self.jobs().length - jobsWithExecutions.length
          }
        })

        // Updated to use dataManager
        self.refreshExecData = function () {
          if (self.loading()) return

          self.loading(true)
          var jobs = self.jobs()
          var currentProject = self.project()
          var completedRequests = 0
          var timeWindow = parseInt(self.graphOptions().queryMax())

          // Match ROI summary date range logic - subtract days from today (including today)
          const beginDate = moment()
            .startOf('day')
            .subtract(timeWindow, 'days')
            .format('YYYY-MM-DD')
          const endDate = moment().endOf('day').format('YYYY-MM-DD')

          log('Date range for executions:', {
            timeWindow: timeWindow,
            begin: beginDate,
            end: endDate,
            daysRequested: moment(endDate).diff(moment(beginDate), 'days') + 1
          })

          if (!currentProject) {
            console.error('Project name is undefined')
            self.loading(false)
            return
          }

          // Use Promise.all to handle all jobs in parallel
          const promises = jobs.map(job => 
            dataManager.getJobExecutions(job.id, timeWindow)
              .then(executions => {
                if (executions && executions.length > 0) {
                  var cutoffDate = moment()
                    .startOf('day')
                    .subtract(self.timeWindow(), 'days')
                  var filteredExecutions = filterExecutionsByDate(
                    executions,
                    cutoffDate
                  )
                  job.processExecutions(filteredExecutions)
                }
              })
              .catch(error => {
                console.error('Error fetching executions:', {
                  project: currentProject,
                  jobId: job.id,
                  error: error
                });
              })
          );
          
          // When all jobs are processed, create the charts
          Promise.all(promises)
            .then(() => {
              self.loading(false);
              self.createCharts();
            })
            .catch(error => {
              console.error('Error processing jobs:', error);
              self.loading(false);
            });
        }

        self.loadJobs = function () {
          var foundJobs = jQuery('.jobname[data-job-id]')
          var jobsArr = []

          foundJobs.each(function (idx, el) {
            var jel = jQuery(el)
            var job = new JobMetrics({
              id: jel.data('jobId'),
              name: jel.data('jobName'),
              group: jel.data('jobGroup'),
              project: self.project()
            })
            jobsArr.push(job)
            self.jobmap[job.id] = job
          })

          self.jobs(jobsArr)
        }

        // Sort handling
        self.sort = function (field) {
          if (self.sortField() === field) {
              self.sortDirection(self.sortDirection() === 'asc' ? 'desc' : 'asc');
          } else {
              self.sortField(field);
              self.sortDirection('asc');
          }
  
          self.jobs.valueHasMutated(); // This line triggers the table update
      };
        self.getSuccessRateOverTime = function () {
          var timeData = {}
          //console.log('Getting success rate data for jobs:', self.jobs().length)
          self.jobs().forEach(function (job) {
            //console.log('Job executions:', job.executions?.length || 0)
            job.executions.forEach(function (execution) {
              var date = moment(
                execution['date-started']?.date || execution.dateStarted
              ).format('YYYY-MM-DD')
              if (!timeData[date]) {
                timeData[date] = { total: 0, success: 0 }
              }
              timeData[date].total++
              if (execution.status === 'succeeded') {
                timeData[date].success++
              }
            })
          })

          // Convert to arrays for Chart.js
          var dates = Object.keys(timeData).sort()
          var rates = dates.map(
            date => (timeData[date].success / timeData[date].total) * 100
          )
          // Check if there's only one date
          if (dates.length === 1) {
            const firstDate = dates[0]
            const prevDate = moment(firstDate)
              .subtract(1, 'day')
              .format('YYYY-MM-DD')

            dates.unshift(prevDate)
            rates.unshift(null) // Add null for the rate
          }

          console.log('Chart data:', { dates, rates })
          return {
            labels: dates,
            data: rates
          }
        }

        self.getTimeOfDayData = function () {
          var hourData = Array(24).fill(0)
          var totalExecutions = 0

          self.jobs().forEach(function (job) {
            job.executions.forEach(function (execution) {
              var hour = moment(
                execution['date-started']?.date || execution.dateStarted
              ).hour()
              hourData[hour]++
              totalExecutions++
            })
          })

          return {
            labels: Array.from({ length: 24 }, (_, i) => i),
            data: hourData
          }
        }

        // Add function to create charts
        self.createCharts = function () {
          const themeColors = getChartThemeColors()

          // Success Rate Over Time Chart
          var successRateData = self.getSuccessRateOverTime()
          if (self.successRateChart) {
            self.successRateChart.destroy()
          }

          self.successRateChart = new Chart(
            document.getElementById('successRateChart'),
            {
              type: 'bar',
              data: {
                labels: successRateData.labels,
                datasets: [
                  {
                    label: 'Success Rate %',
                    data: successRateData.data,
                    borderColor: '#28a745',
                    backgroundColor: 'rgba(40, 167, 69, 0.1)',
                    fill: true,
                    tension: 0.4
                  }
                ]
              },
              options: {
                responsive: true,
                scales: {
                  y: {
                    beginAtZero: true,
                    max: 100,
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Success Rate (%)',
                      color: themeColors.textColor
                    }
                  },
                  x: {
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Date',
                      color: themeColors.textColor
                    }
                  }
                },
                plugins: {
                  title: {
                    display: true,
                    text: 'Job Success Rate Over Time',
                    color: themeColors.textColor
                  },
                  legend: {
                    labels: {
                      color: themeColors.textColor
                    }
                  }
                }
              }
            }
          )

          // Time Heat Map
          var timeData = self.getTimeOfDayData()
          if (self.timeHeatMapChart) {
            self.timeHeatMapChart.destroy()
          }

          self.timeHeatMapChart = new Chart(
            document.getElementById('timeHeatMap'),
            {
              type: 'bar',
              data: {
                labels: timeData.labels.map(hour => `${hour}:00`),
                datasets: [
                  {
                    label: 'Executions',
                    data: timeData.data,
                    backgroundColor: timeData.data.map(
                      value =>
                        `rgba(40, 167, 69, ${
                          value / Math.max(...timeData.data)
                        })`
                    )
                  }
                ]
              },
              options: {
                responsive: true,
                scales: {
                  y: {
                    beginAtZero: true,
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Number of Executions',
                      color: themeColors.textColor
                    }
                  },
                  x: {
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Hour of Day',
                      color: themeColors.textColor
                    }
                  }
                },
                plugins: {
                  title: {
                    display: true,
                    text: 'Job Executions by Hour Heatmap',
                    color: themeColors.textColor
                  },
                  legend: {
                    labels: {
                      color: themeColors.textColor
                    }
                  }
                }
              }
            }
          )
        }
      }

      function JobMetricsViewModel () {
        var self = this

        // Basic observables
        self.loading = ko.observable(true)
        self.executionCount = ko.observable(0)
        self.successCount = ko.observable(0)
        self.failureCount = ko.observable(0)
        self.successRate = ko.observable(0)
        self.avgDuration = ko.observable(0)

        // Time window options
        self.graphOptions = ko.observable(
          new GraphOptions({
            queryMax: 10
          })
        )

        // Chart instances
        self.successRateChart = null
        self.statusPieChart = null

        // Updated to use dataManager
        self.loadMetricsData = function () {
          // Check if chart elements exist
          if (
            !document.getElementById('jobSuccessRateChart') ||
            !document.getElementById('jobStatusPieChart')
          ) {
            console.log('Chart elements not ready, retrying in 100ms...')
            setTimeout(() => self.loadMetricsData(), 100)
            return
          }

          self.loading(true)
          var jobDetail = loadJsonData('jobDetail')
          var jobId = jobDetail.id
          var timeWindow = self.graphOptions().queryMax()

          // Use data manager to get executions
          dataManager.getJobExecutions(jobId, timeWindow)
            .then(executions => {
              if (executions && executions.length > 0) {
                var cutoffDate = moment()
                  .startOf('day')
                  .subtract(self.graphOptions().queryMax(), 'days')
                var filteredExecutions = filterExecutionsByDate(
                  executions,
                  cutoffDate
                )

                self.processExecutions(filteredExecutions)

                // Double check elements exist before updating charts
                if (
                  document.getElementById('jobSuccessRateChart') &&
                  document.getElementById('jobStatusPieChart')
                ) {
                  self.updateCharts(filteredExecutions)
                }
              }
              self.loading(false)
            })
            .catch(error => {
              console.error('Error loading executions:', error)
              self.loading(false)
            });
        }

        self.processExecutions = function (executions) {
          var successful = 0
          var totalDuration = 0
          var mostRecentExec = null

          executions.forEach(function (execution) {
            if (execution.status === 'succeeded') {
              successful++
            }
            
            // Track the most recent execution for job.averageDuration
            if (!mostRecentExec || (execution['date-started'] && mostRecentExec['date-started'] && 
                execution['date-started'].date > mostRecentExec['date-started'].date)) {
              mostRecentExec = execution
            }
          })

          self.executionCount(executions.length)
          self.successCount(successful)
          self.failureCount(executions.length - successful)
          self.successRate(
            executions.length > 0 ? (successful / executions.length) * 100 : 0
          )
          
          // Use job.averageDuration if available from most recent execution
          if (mostRecentExec && mostRecentExec.job && mostRecentExec.job.averageDuration) {
            self.avgDuration(mostRecentExec.job.averageDuration)
          } else {
            // Fallback to calculating from executions if necessary
            executions.forEach(function (execution) {
              if (execution.duration) {
                totalDuration += execution.duration
              }
            })
            self.avgDuration(
              executions.length > 0 ? totalDuration / executions.length : 0
            )
          }
        }

        self.updateCharts = function (executions) {
          const themeColors = getChartThemeColors()

          // Prepare data for success rate over time
          var timeData = {}
          executions.forEach(function (execution) {
            var date = moment(
              execution['date-started']?.date || execution.dateStarted
            ).format('YYYY-MM-DD')
            if (!timeData[date]) {
              timeData[date] = { total: 0, success: 0 }
            }
            timeData[date].total++
            if (execution.status === 'succeeded') {
              timeData[date].success++
            }
          })

          var dates = Object.keys(timeData).sort()
          var successRates = dates.map(
            date => (timeData[date].success / timeData[date].total) * 100
          )

          if (dates.length === 1) {
            const firstDate = dates[0]
            const prevDate = moment(firstDate)
              .subtract(1, 'day')
              .format('YYYY-MM-DD')

            dates.unshift(prevDate)
            successRates.unshift(null) // Add null for the success rate
          }

          // Update success rate chart
          if (self.successRateChart) {
            self.successRateChart.destroy()
          }

          self.successRateChart = new Chart(
            document.getElementById('jobSuccessRateChart'),
            {
              type: 'bar',
              data: {
                labels: dates,
                datasets: [
                  {
                    label: 'Success Rate %',
                    data: successRates,
                    borderColor: '#28a745',
                    backgroundColor: 'rgba(40, 167, 69, 0.1)',
                    fill: true,
                    tension: 0.4
                  }
                ]
              },
              options: {
                responsive: true,
                scales: {
                  y: {
                    beginAtZero: true,
                    max: 100,
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Success Rate (%)',
                      color: themeColors.textColor
                    }
                  },
                  x: {
                    grid: {
                      color: themeColors.gridColor,
                      borderColor: themeColors.borderColor
                    },
                    ticks: {
                      color: themeColors.textColor
                    },
                    title: {
                      display: true,
                      text: 'Date',
                      color: themeColors.textColor
                    }
                  }
                },
                plugins: {
                  title: {
                    display: true,
                    text: 'Job Success Rate Over Time',
                    color: themeColors.textColor
                  },
                  legend: {
                    labels: {
                      color: themeColors.textColor
                    }
                  }
                }
              }
            }
          )

          // Update pie chart
          if (self.statusPieChart) {
            self.statusPieChart.destroy()
          }

          self.statusPieChart = new Chart(
            document.getElementById('jobStatusPieChart'),
            {
              type: 'pie',
              data: {
                labels: ['Successful', 'Failed'],
                datasets: [
                  {
                    data: [self.successCount(), self.failureCount()],
                    backgroundColor: [
                      'rgba(75, 192, 192, 0.8)',
                      'rgba(255, 99, 132, 0.8)'
                    ]
                  }
                ]
              },
              options: {
                responsive: true,
                plugins: {
                  title: {
                    display: true,
                    text: 'Execution Status Distribution',
                    color: themeColors.textColor
                  },
                  legend: {
                    labels: {
                      color: themeColors.textColor
                    }
                  }
                }
              }
            }
          )
        }

        // Update when time window changes
        self.graphOptions().queryMax.subscribe(function () {
          self.loadMetricsData()
        })
      }

      function JobMetrics (data) {
        var self = this

        // Basic job info
        self.id = data.id
        self.name = ko.observable(data.name)
        self.group = ko.observable(data.group)

        self.executions = []

        // Execution metrics
        self.executionCount = ko.observable(0)
        self.successCount = ko.observable(0)
        self.failureCount = ko.observable(0)
        self.successRate = ko.observable(0)
        self.avgDuration = ko.observable(0)
        self.totalDuration = ko.observable(0)

        // Process executions data
        self.processExecutions = function (executions) {
          self.executions = executions
          var successful = 0
          var totalDuration = 0
          var mostRecentExec = null

          executions.forEach(function (execution) {
            if (execution.status === 'succeeded') {
              successful++
            }

            // Track the most recent execution for job.averageDuration
            if (!mostRecentExec || (execution['date-started'] && mostRecentExec['date-started'] && 
                execution['date-started'].date > mostRecentExec['date-started'].date)) {
              mostRecentExec = execution
            }
          })

          self.executionCount(executions.length)
          self.successCount(successful)
          self.failureCount(executions.length - successful)
          self.successRate(
            executions.length > 0 ? (successful / executions.length) * 100 : 0
          )
          
          // Use job.averageDuration if available from most recent execution
          if (mostRecentExec && mostRecentExec.job && mostRecentExec.job.averageDuration) {
            self.avgDuration(mostRecentExec.job.averageDuration)
          } else {
            // Fallback to calculating from executions if necessary
            executions.forEach(function (execution) {
              if (execution.duration) {
                totalDuration += execution.duration
              }
            })
            self.avgDuration(
              executions.length > 0 ? totalDuration / executions.length : 0
            )
          }
          self.totalDuration(totalDuration)
        }

        // Format duration for display
        self.formatDuration = function (miliseconds) {
          return moment.duration(miliseconds).humanize()
        }

        // Computed for formatted display values
        self.formattedSuccessRate = ko.computed(function () {
          return self.successRate().toFixed(1) + '%'
        })

        self.formattedAvgDuration = ko.computed(function () {
          return self.formatDuration(self.avgDuration())
        })
      }

      jQuery(function () {
        var pagePath = rundeckPage.path()

        if (pagePath === 'menu/jobs') {
          let pluginId = 'ui-jobmetrics'
          let pluginUrl = rundeckPage.pluginBaseUrl(pluginId)
          let pluginName = RDPRO[pluginId]
          jobMetricsView = new JobMetricsListView(pluginName)

          jobListSupport.init_plugin(pluginId, function () {
            jQuery.get(pluginUrl + '/html/table.html', function (templateHtml) {
              let tablink = jobListSupport.initPage(
                '#indexMain',
                'Jobs',
                'jobmetricsview',
                'jobmetricstab',
                'Job Metrics',
                templateHtml,
                function (elem) {
                  jobMetricsView.loadJobs()
                  ko.applyBindings(
                    {
                      jobmetrics: jobMetricsView,
                      jobListSupport: jobListSupport
                    },
                    elem
                  )
                  jobMetricsView.refreshExecData()
                }
              )
            })
          })
        }

        if (pagePath === 'scheduledExecution/show') {
          let pluginId = 'ui-jobmetrics'
          let pluginUrl = rundeckPage.pluginBaseUrl(pluginId)

          jobListSupport.setup_ko_loader(pluginId, pluginUrl, pluginId)

          jobMetricsView = new JobMetricsViewModel()

          // Create container
          let container = jQuery(
            '<div class="col-sm-12 job-metrics-section"></div>'
          )
          let statsTab = jQuery('#stats')
          if (statsTab.length) {
            container.prependTo(statsTab)
          }

          jobListSupport.init_plugin(pluginId, function () {
            jQuery.get(
              pluginUrl + '/html/job-metrics.html',
              function (templateHtml) {
                container.html(templateHtml)
                ko.applyBindings(jobMetricsView, container[0])
                // Only load metrics after template is loaded and bound
                setTimeout(() => {
                  jobMetricsView.loadMetricsData()
                }, 100)
              }
            )
          })
        }

        if (jobMetricsView) {
          const observer = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
              if (mutation.attributeName === 'data-color-theme') {
                // Refresh charts when theme changes
                if (
                  pagePath === 'menu/jobs' &&
                  jobMetricsView.refreshExecData
                ) {
                  jobMetricsView.refreshExecData()
                } else if (
                  pagePath === 'scheduledExecution/show' &&
                  jobMetricsView.loadMetricsData
                ) {
                  jobMetricsView.loadMetricsData()
                }
              }
            })
          })

          observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-color-theme']
          })
        }
      })
    })
  }
}

// Main initialization for Job Metrics
window.addEventListener('DOMContentLoaded', function() {
  // Ensure RDPRO exists
  if (typeof window.RDPRO !== 'object') {
    window.RDPRO = {};
  }
  
  // Ensure our plugin entry exists
  if (!window.RDPRO["ui-jobmetrics"]) {
    window.RDPRO["ui-jobmetrics"] = {
      name: "ui-jobmetrics",
      initialized: false
    };
  }
  
  // Prevent duplicate initialization
  if (window.RDPRO["ui-jobmetrics"].initialized) return;

  // Wait for ROI plugin's data loading events
  const initializeOnRoiDataLoaded = function() {
    const scripts = Array.from(document.scripts);

    const roiSummaryScript = scripts.some(script =>
        script.src.includes('ui-roisummary')
    );

    // Set a global flag that can be checked by both plugins to determine if ROI Summary is installed
    window.RDPRO["ui-jobmetrics"].hasRoiSummary = !!roiSummaryScript;
    console.log('Job Metrics detection - ROI Summary installed:', window.RDPRO["ui-jobmetrics"].hasRoiSummary);

    if(!roiSummaryScript) {
      // If ROI Summary is not installed, initialize immediately and fetch our own data
      window.RDPRO["ui-jobmetrics"].initialized = true;
      initJobMetrics();
    } else {
      // Listen for the job list ROI data loaded event
      jQuery(document).on('rundeck:plugin:ui-roisummary:data-loaded:joblist', function(event) {
        console.log('ROI Summary job list data loaded event received, initializing Job Metrics');
        if (!window.RDPRO["ui-jobmetrics"].initialized) {
          window.RDPRO["ui-jobmetrics"].initialized = true;
          initJobMetrics();
        }
      });

      // Listen for the job detail ROI data loaded event
      jQuery(document).on('rundeck:plugin:ui-roisummary:data-loaded:jobroi', function(event) {
        console.log('ROI Summary job detail data loaded event received, initializing Job Metrics');
        if (!window.RDPRO["ui-jobmetrics"].initialized) {
          window.RDPRO["ui-jobmetrics"].initialized = true;
          initJobMetrics();
        }
      });
      
      // Also listen for the UI loaded event
      // This will help initialize metrics even when a job doesn't have ROI data
      jQuery(document).on('rundeck:plugin:ui-roisummary:ui-loaded:jobroi', function(event) {
        console.log('ROI Summary job detail UI loaded event received, checking for Job Metrics initialization');
        if (!window.RDPRO["ui-jobmetrics"].initialized) {
          console.log('Job Metrics not yet initialized, initializing from UI loaded event');
          window.RDPRO["ui-jobmetrics"].initialized = true;
          initJobMetrics();
        }
      });
    }
  }

  // Start listening for ROI events
  initializeOnRoiDataLoaded();
});