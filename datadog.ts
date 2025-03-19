import { env } from 'bun'
import { RateLimitedLogger } from './utils/logger'

const DD_API_KEY = env.DD_API_KEY
if (!DD_API_KEY) {
  throw new Error('Missing DD_API_KEY environment variable')
}

const DD_URL = `https://us5.datadoghq.com/api/v1/series?api_key=${DD_API_KEY}`

/**
 * Sends a custom metric to Datadog.
 * @param metricName - The name of the metric.
 * @param metricType - Type of the metric ('gauge' or 'count').
 * @param value - Numeric value to send.
 * @param tags - List of tags for Datadog.
 */
export async function sendDatadogMetric(
  metricName: string,
  metricType: 'gauge' | 'count',
  value: number,
  tags: string[] = [],
  logger: RateLimitedLogger
): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000) // Unix timestamp (seconds)
    const payload = {
      series: [
        {
          metric: metricName,
          points: [[now, value]],
          type: metricType,
          tags: [...tags, `service_name:perennial-solver-ts`, `env:${env.NODE_ENV ?? 'staging'}`],
          host: 'cloud-run',
        },
      ],
    }

    const response = await fetch(DD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!response.ok) {
        logger.error(`Datadog metric failed: ${response.statusText} / ${response.status}`)
    } else {
        logger.debug(`Datadog metric type ${metricType} sent: ${metricName}=${value}`)
    }
  } catch (error) {
    logger.error(`Error sending metric to Datadog: ${error}`)
  }
}
