# Job Metrics Plugin for Rundeck

**Transform your job execution data into actionable insights**

The Job Metrics plugin provides comprehensive visualization and analysis of your Rundeck job execution patterns, success rates, and timing trends through an intuitive dashboard interface.

## Versions

Current Stable Version: 1.0.0

| Plugin Version | Rundeck Version | Release Date |
|----|----|----|
| 1.0.0    | 5.0.0+    | 2024-01-29   |

## Key Features

- **Dynamic Metrics Dashboard**: Real-time view of execution statistics across all jobs
- **Interactive Success Rate Tracking**: Visual trends of job success rates over time
- **Time-of-Day Analysis**: Heat map showing execution patterns throughout the day
- **Flexible Time Windows**: Customize analysis periods to match your needs
- **Sortable Job Lists**: Easy filtering and sorting by various metrics

## Visualizations

- **Success Rate Chart**: Track success rates over time with intuitive line graphs
- **Time Heat Map**: Identify peak execution times with color-coded hourly distributions
- **Job List View**: Comprehensive metrics for all jobs including:
  - Total executions
  - Success rate
  - Average duration
  - Failure count

## Business Benefits

- Identify problematic jobs with low success rates
- Optimize scheduling by understanding execution patterns
- Make data-driven decisions about job configurations
- Track performance trends over time
- Quickly spot anomalies in job execution patterns

## Requirements

- Rundeck version 4.0.0 or higher
- Modern web browser with JavaScript enabled
- Access to Rundeck's execution API

## Build

Using gradle:

```bash
./gradlew clean build
```

## Install

```bash
cp build/distributions/ui-jobmetrics-1.0.0.zip $RDECK_BASE/libext
```

## Configuration

The time window for analysis can be configured through either:

1. System Configuration GUI (recommended):
   - Navigate to System Menu > System Configuration
   - Add a configuration parameter:
     ```
     rundeck.ui-plugins.ui-jobmetrics.defaultTimeWindow=30
     ```

2. Properties file:
   - Edit your `rundeck-config.properties`
   - Add the configuration line:
     ```
     rundeck.ui-plugins.ui-jobmetrics.defaultTimeWindow=30
     ```

The `defaultTimeWindow` setting determines how many days of execution history to analyze:
- Default value: 10 days
- Example values:
  - `30` for the last month
  - `7` for the last week
  - `90` for the last quarter

Changes to this setting take effect on the next page load without requiring a restart.

## Support

- Issues: Please report any issues via the GitHub repository as this plugin is Community Supported only.