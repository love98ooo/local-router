import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';
import type { LogMetricsWindow, LogMetricsSeriesPoint, LogMetricsResponse } from './log-metrics';
import { isLogMetricsWindow } from './log-metrics';
import { getDbConnection } from './log-query-duckdb';

// Re-export for compatibility
export { isLogMetricsWindow };
export type { LogMetricsWindow, LogMetricsSeriesPoint, LogMetricsResponse };

const WINDOW_MS: Record<LogMetricsWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const BUCKET_MS: Record<LogMetricsWindow, number> = {
  '1h': 5 * 60 * 1000,      // 5 min buckets
  '6h': 15 * 60 * 1000,     // 15 min buckets
  '24h': 30 * 60 * 1000,    // 30 min buckets
  '7d': 2 * 60 * 60 * 1000, // 2 hour buckets
  '30d': 12 * 60 * 60 * 1000, // 12 hour buckets
};

const TOP_LIMIT = 5;

function toPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number(((numerator / denominator) * 100).toFixed(2));
}

function toDayStart(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function listDateStrings(fromMs: number, toMs: number): string[] {
  const result: string[] = [];
  for (let day = toDayStart(fromMs); day <= toDayStart(toMs); day += 24 * 60 * 60 * 1000) {
    result.push(new Date(day).toISOString().slice(0, 10));
  }
  return result;
}

function createEmptyMetrics(
  window: LogMetricsWindow,
  nowMs: number,
  source: LogMetricsResponse['source'],
  warnings: string[] = []
): LogMetricsResponse {
  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const series: LogMetricsSeriesPoint[] = Array.from({ length: bucketCount }, (_, i) => ({
    ts: new Date(fromMs + i * bucketMs).toISOString(),
    requests: 0,
    errors: 0,
    avgLatencyMs: 0,
  }));

  return {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    generatedAt: new Date(nowMs).toISOString(),
    source,
    summary: {
      totalRequests: 0,
      successRequests: 0,
      errorRequests: 0,
      successRate: 0,
      avgLatencyMs: 0,
      p95LatencyMs: 0,
      totalRequestBytes: 0,
      totalResponseBytes: 0,
    },
    series,
    topProviders: [],
    topRouteTypes: [],
    statusClasses: {
      '2xx': 0,
      '4xx': 0,
      '5xx': 0,
      network_error: 0,
    },
    warnings,
  };
}

export async function getLogMetricsDuck(options: {
  logConfig?: LogConfig;
  window?: LogMetricsWindow;
  refresh?: boolean;
  nowMs?: number;
}): Promise<LogMetricsResponse> {
  const window = options.window ?? '24h';
  const nowMs = options.nowMs ?? Date.now();

  const logEnabled = options.logConfig?.enabled !== false && !!options.logConfig;
  if (!logEnabled) {
    return createEmptyMetrics(
      window,
      nowMs,
      {
        logEnabled: false,
        baseDir: null,
        filesScanned: 0,
        linesScanned: 0,
        partial: false,
      },
      ['日志未启用']
    );
  }

  const baseDir = resolveLogBaseDir(options.logConfig);
  const eventsDir = join(baseDir, 'events');

  if (!existsSync(eventsDir)) {
    return createEmptyMetrics(
      window,
      nowMs,
      {
        logEnabled: true,
        baseDir,
        filesScanned: 0,
        linesScanned: 0,
        partial: false,
      },
      ['日志目录不存在，暂无可分析数据']
    );
  }

  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const dates = listDateStrings(fromMs, nowMs);
  const files = dates
    .map((date) => join(baseDir, 'events', `${date}.jsonl`))
    .filter(existsSync);

  if (files.length === 0) {
    return createEmptyMetrics(
      window,
      nowMs,
      {
        logEnabled: true,
        baseDir,
        filesScanned: 0,
        linesScanned: 0,
        partial: false,
      },
      ['无日志文件']
    );
  }

  const conn = await getDbConnection();
  const fileList = files.map((f) => `'${f}'`).join(', ');

  // Create temp view
  const viewName = `metrics_view_${Date.now()}`;
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW ${viewName} AS
    SELECT * FROM read_json_auto([${fileList}], maximum_depth=1, ignore_errors=true)
  `);

  try {
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(nowMs).toISOString();

    // Build bucket intervals
    const bucketIntervals: string[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = fromMs + i * bucketMs;
      const bucketEnd = Math.min(bucketStart + bucketMs, nowMs);
      bucketIntervals.push(`
        SELECT
          '${new Date(bucketStart).toISOString()}' as bucket_start,
          '${new Date(bucketEnd).toISOString()}' as bucket_end
      `);
    }

    // Query summary stats
    const summarySql = `
      SELECT
        COUNT(*)::INTEGER as total_requests,
        SUM(CASE WHEN error_type IS NULL AND upstream_status >= 200 AND upstream_status < 400 THEN 1 ELSE 0 END)::INTEGER as success_requests,
        SUM(CASE WHEN error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400 THEN 1 ELSE 0 END)::INTEGER as error_requests,
        AVG(latency_ms) as avg_latency,
        QUANTILE_CONT(latency_ms, 0.95) as p95_latency,
        SUM(request_bytes)::BIGINT as total_request_bytes,
        SUM(COALESCE(response_bytes, 0) + COALESCE(stream_bytes, 0))::BIGINT as total_response_bytes,
        SUM(CASE WHEN upstream_status >= 200 AND upstream_status < 300 AND error_type IS NULL THEN 1 ELSE 0 END)::INTEGER as count_2xx,
        SUM(CASE WHEN upstream_status >= 400 AND upstream_status < 500 AND error_type IS NULL THEN 1 ELSE 0 END)::INTEGER as count_4xx,
        SUM(CASE WHEN upstream_status >= 500 AND error_type IS NULL THEN 1 ELSE 0 END)::INTEGER as count_5xx,
        SUM(CASE WHEN error_type IS NOT NULL THEN 1 ELSE 0 END)::INTEGER as count_network_error
      FROM ${viewName}
      WHERE ts_start >= '${fromIso}' AND ts_start <= '${toIso}'
    `;

    // Query time series
    const seriesSql = `
      SELECT
        time_bucket(INTERVAL '${Math.floor(bucketMs / 1000)} seconds', ts_start::TIMESTAMP) as bucket,
        COUNT(*)::INTEGER as requests,
        SUM(CASE WHEN error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400 THEN 1 ELSE 0 END)::INTEGER as errors,
        AVG(latency_ms) as avg_latency
      FROM ${viewName}
      WHERE ts_start >= '${fromIso}' AND ts_start <= '${toIso}'
      GROUP BY bucket
      ORDER BY bucket
    `;

    // Query top providers
    const providersSql = `
      SELECT
        COALESCE(provider, 'unknown') as key,
        COUNT(*)::INTEGER as requests,
        SUM(CASE WHEN error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400 THEN 1 ELSE 0 END)::INTEGER as errors,
        AVG(latency_ms) as avg_latency
      FROM ${viewName}
      WHERE ts_start >= '${fromIso}' AND ts_start <= '${toIso}'
      GROUP BY COALESCE(provider, 'unknown')
      ORDER BY requests DESC
      LIMIT ${TOP_LIMIT}
    `;

    // Query top route types
    const routeTypesSql = `
      SELECT
        COALESCE(route_type, 'unknown') as key,
        COUNT(*)::INTEGER as requests,
        SUM(CASE WHEN error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400 THEN 1 ELSE 0 END)::INTEGER as errors
      FROM ${viewName}
      WHERE ts_start >= '${fromIso}' AND ts_start <= '${toIso}'
      GROUP BY COALESCE(route_type, 'unknown')
      ORDER BY requests DESC
      LIMIT ${TOP_LIMIT}
    `;

    // Execute all queries in parallel
    const [summaryResult, seriesResult, providersResult, routeTypesResult] = await Promise.all([
      conn.run(summarySql),
      conn.run(seriesSql),
      conn.run(providersSql),
      conn.run(routeTypesSql),
    ]);

    const summaryRow = (await summaryResult.getRowObjects())[0] || {};
    const seriesRows = await seriesResult.getRowObjects();
    const providerRows = await providersResult.getRowObjects();
    const routeTypeRows = await routeTypesResult.getRowObjects();

    const totalRequests = Number(summaryRow.total_requests || 0);
    const successRequests = Number(summaryRow.success_requests || 0);
    const errorRequests = Number(summaryRow.error_requests || 0);

    // Build series array with all buckets
    const seriesMap = new Map<string, LogMetricsSeriesPoint>();
    for (const row of seriesRows) {
      const ts = new Date(row.bucket).toISOString();
      seriesMap.set(ts, {
        ts,
        requests: Number(row.requests || 0),
        errors: Number(row.errors || 0),
        avgLatencyMs: Math.round(Number(row.avg_latency || 0)),
      });
    }

    // Fill in missing buckets with zeros
    const series: LogMetricsSeriesPoint[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = fromMs + i * bucketMs;
      const ts = new Date(bucketStart).toISOString();
      series.push(
        seriesMap.get(ts) || {
          ts,
          requests: 0,
          errors: 0,
          avgLatencyMs: 0,
        }
      );
    }

    const topProviders = providerRows.map((row: any) => ({
      key: String(row.key || 'unknown'),
      requests: Number(row.requests || 0),
      errorRate: toPercent(Number(row.errors || 0), Number(row.requests || 0)),
      avgLatencyMs: Math.round(Number(row.avg_latency || 0)),
    }));

    const topRouteTypes = routeTypeRows.map((row: any) => ({
      key: String(row.key || 'unknown'),
      requests: Number(row.requests || 0),
      errorRate: toPercent(Number(row.errors || 0), Number(row.requests || 0)),
    }));

    return {
      window,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      generatedAt: new Date(nowMs).toISOString(),
      source: {
        logEnabled: true,
        baseDir,
        filesScanned: files.length,
        linesScanned: totalRequests, // DuckDB doesn't give exact scanned lines
        partial: false,
      },
      summary: {
        totalRequests,
        successRequests,
        errorRequests,
        successRate: toPercent(successRequests, totalRequests),
        avgLatencyMs: Math.round(Number(summaryRow.avg_latency || 0)),
        p95LatencyMs: Math.round(Number(summaryRow.p95_latency || 0)),
        totalRequestBytes: Number(summaryRow.total_request_bytes || 0),
        totalResponseBytes: Number(summaryRow.total_response_bytes || 0),
      },
      series,
      topProviders,
      topRouteTypes,
      statusClasses: {
        '2xx': Number(summaryRow.count_2xx || 0),
        '4xx': Number(summaryRow.count_4xx || 0),
        '5xx': Number(summaryRow.count_5xx || 0),
        network_error: Number(summaryRow.count_network_error || 0),
      },
      warnings: [],
    };
  } finally {
    await conn.run(`DROP VIEW IF EXISTS ${viewName}`).catch(() => {});
  }
}
