import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppConfig, LogConfig } from './config';
import { resolveLogBaseDir } from './config';
import type { UsageMetricsWindow, UsageMetricsResponse } from './usage-metrics';
import { isUsageMetricsWindow } from './usage-metrics';
import { getDbConnection } from './log-query-duckdb';

// Re-export for compatibility
export { isUsageMetricsWindow };
export type { UsageMetricsWindow, UsageMetricsResponse };

const WINDOW_MS: Record<UsageMetricsWindow, number> = {
  '1h': 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const BUCKET_MS: Record<UsageMetricsWindow, number> = {
  '1h': 5 * 60 * 1000,      // 5 min buckets
  '6h': 15 * 60 * 1000,     // 15 min buckets
  '24h': 30 * 60 * 1000,    // 30 min buckets
  '7d': 2 * 60 * 60 * 1000, // 2 hour buckets
  '30d': 12 * 60 * 60 * 1000, // 12 hour buckets
};

interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

function buildPricingMap(config: AppConfig): Map<string, ModelPricing> {
  const map = new Map<string, ModelPricing>();
  for (const [, provider] of Object.entries(config.providers)) {
    for (const [modelName, capabilities] of Object.entries(provider.models)) {
      if (capabilities.pricing) {
        map.set(modelName, {
          input: capabilities.pricing.input ?? 0,
          output: capabilities.pricing.output ?? 0,
          cacheRead: capabilities.pricing.cacheRead ?? 0,
          cacheCreation: capabilities.pricing.cacheCreation ?? 0,
        });
      }
    }
  }
  return map;
}

function computeCost(
  pricing: ModelPricing | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheCreationTokens: number
): number {
  if (!pricing) return 0;
  return (
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheReadTokens * pricing.cacheRead +
      cacheCreationTokens * pricing.cacheCreation) /
    1_000_000
  );
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

function createEmptyResponse(window: UsageMetricsWindow, nowMs: number): UsageMetricsResponse {
  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  return {
    window,
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    summary: {
      totalRequests: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCost: 0,
    },
    byProvider: [],
    byModel: [],
    series: Array.from({ length: bucketCount }, (_, i) => ({
      ts: new Date(fromMs + i * bucketMs).toISOString(),
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    })),
  };
}

export async function getUsageMetricsDuck(options: {
  config: AppConfig;
  logConfig?: LogConfig;
  window?: UsageMetricsWindow;
  refresh?: boolean;
  nowMs?: number;
}): Promise<UsageMetricsResponse> {
  const window = options.window ?? '24h';
  const nowMs = options.nowMs ?? Date.now();

  const logEnabled = options.logConfig?.enabled !== false && !!options.logConfig;
  if (!logEnabled) {
    return createEmptyResponse(window, nowMs);
  }

  const baseDir = resolveLogBaseDir(options.logConfig);
  const eventsDir = join(baseDir, 'events');

  if (!existsSync(eventsDir)) {
    return createEmptyResponse(window, nowMs);
  }

  const fromMs = nowMs - WINDOW_MS[window];
  const bucketMs = BUCKET_MS[window];
  const bucketCount = Math.max(1, Math.ceil((nowMs - fromMs) / bucketMs));

  const dates = listDateStrings(fromMs, nowMs);
  const files = dates
    .map((date) => join(baseDir, 'events', `${date}.jsonl`))
    .filter(existsSync);

  if (files.length === 0) {
    return createEmptyResponse(window, nowMs);
  }

  const conn = await getDbConnection();
  const fileList = files.map((f) => `'${f}'`).join(', ');

  // Create temp view
  const viewName = `usage_view_${Date.now()}`;
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW ${viewName} AS
    SELECT * FROM read_json_auto([${fileList}], maximum_depth=1, ignore_errors=true)
  `);

  try {
    const fromIso = new Date(fromMs).toISOString();
    const toIso = new Date(nowMs).toISOString();

    // Query summary stats - filter out errors and events with no tokens
    const summarySql = `
      SELECT
        COUNT(*)::INTEGER as total_requests,
        SUM(COALESCE(usage_input_tokens::BIGINT, 0))::BIGINT as total_input_tokens,
        SUM(COALESCE(usage_output_tokens::BIGINT, 0))::BIGINT as total_output_tokens,
        SUM(COALESCE(usage_cache_read_tokens::BIGINT, 0))::BIGINT as total_cache_read_tokens,
        SUM(COALESCE(usage_cache_creation_tokens::BIGINT, 0))::BIGINT as total_cache_creation_tokens
      FROM ${viewName}
      WHERE ts_start::TIMESTAMP >= '${fromIso}'::TIMESTAMP AND ts_start::TIMESTAMP <= '${toIso}'::TIMESTAMP
        AND error_type IS NULL
        AND upstream_status >= 200 AND upstream_status < 300
        AND (COALESCE(usage_input_tokens::BIGINT, 0) > 0 OR COALESCE(usage_output_tokens::BIGINT, 0) > 0)
    `;

    // Query time series
    const seriesSql = `
      SELECT
        time_bucket(INTERVAL '${Math.floor(bucketMs / 1000)} seconds', ts_start::TIMESTAMP) as bucket,
        COUNT(*)::INTEGER as requests,
        SUM(COALESCE(usage_input_tokens::BIGINT, 0))::BIGINT as input_tokens,
        SUM(COALESCE(usage_output_tokens::BIGINT, 0))::BIGINT as output_tokens
      FROM ${viewName}
      WHERE ts_start::TIMESTAMP >= '${fromIso}'::TIMESTAMP AND ts_start::TIMESTAMP <= '${toIso}'::TIMESTAMP
        AND error_type IS NULL
        AND upstream_status >= 200 AND upstream_status < 300
        AND (COALESCE(usage_input_tokens::BIGINT, 0) > 0 OR COALESCE(usage_output_tokens::BIGINT, 0) > 0)
      GROUP BY bucket
      ORDER BY bucket
    `;

    // Query by provider
    const providerSql = `
      SELECT
        COALESCE(provider, 'unknown') as provider_key,
        COUNT(*)::INTEGER as requests,
        SUM(COALESCE(usage_input_tokens::BIGINT, 0))::BIGINT as input_tokens,
        SUM(COALESCE(usage_output_tokens::BIGINT, 0))::BIGINT as output_tokens,
        SUM(COALESCE(usage_cache_read_tokens::BIGINT, 0))::BIGINT as cache_read_tokens,
        SUM(COALESCE(usage_cache_creation_tokens::BIGINT, 0))::BIGINT as cache_creation_tokens
      FROM ${viewName}
      WHERE ts_start::TIMESTAMP >= '${fromIso}'::TIMESTAMP AND ts_start::TIMESTAMP <= '${toIso}'::TIMESTAMP
        AND error_type IS NULL
        AND upstream_status >= 200 AND upstream_status < 300
        AND (COALESCE(usage_input_tokens::BIGINT, 0) > 0 OR COALESCE(usage_output_tokens::BIGINT, 0) > 0)
      GROUP BY COALESCE(provider, 'unknown')
      ORDER BY requests DESC
    `;

    // Query by model
    const modelSql = `
      SELECT
        COALESCE(provider, 'unknown') as provider_key,
        COALESCE(model_out, 'unknown') as model_key,
        COUNT(*)::INTEGER as requests,
        SUM(COALESCE(usage_input_tokens::BIGINT, 0))::BIGINT as input_tokens,
        SUM(COALESCE(usage_output_tokens::BIGINT, 0))::BIGINT as output_tokens,
        SUM(COALESCE(usage_cache_read_tokens::BIGINT, 0))::BIGINT as cache_read_tokens,
        SUM(COALESCE(usage_cache_creation_tokens::BIGINT, 0))::BIGINT as cache_creation_tokens
      FROM ${viewName}
      WHERE ts_start::TIMESTAMP >= '${fromIso}'::TIMESTAMP AND ts_start::TIMESTAMP <= '${toIso}'::TIMESTAMP
        AND error_type IS NULL
        AND upstream_status >= 200 AND upstream_status < 300
        AND (COALESCE(usage_input_tokens::BIGINT, 0) > 0 OR COALESCE(usage_output_tokens::BIGINT, 0) > 0)
      GROUP BY COALESCE(provider, 'unknown'), COALESCE(model_out, 'unknown')
      ORDER BY requests DESC
    `;

    // Execute all queries in parallel
    const [summaryResult, seriesResult, providerResult, modelResult] = await Promise.all([
      conn.run(summarySql),
      conn.run(seriesSql),
      conn.run(providerSql),
      conn.run(modelSql),
    ]);

    const summaryRow = (await summaryResult.getRowObjects())[0] || {};
    const seriesRows = await seriesResult.getRowObjects();
    const providerRows = await providerResult.getRowObjects();
    const modelRows = await modelResult.getRowObjects();

    const pricingMap = buildPricingMap(options.config);

    // Build series array with all buckets
    const seriesMap = new Map<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }>();
    for (const row of seriesRows) {
      const ts = new Date(row.bucket).toISOString();
      const inputTokens = Number(row.input_tokens || 0);
      const outputTokens = Number(row.output_tokens || 0);
      seriesMap.set(ts, {
        requests: Number(row.requests || 0),
        inputTokens,
        outputTokens,
        cost: 0, // Will compute later if needed
      });
    }

    const series: UsageMetricsResponse['series'] = [];
    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = fromMs + i * bucketMs;
      const ts = new Date(bucketStart).toISOString();
      const bucket = seriesMap.get(ts) || { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 };
      series.push({
        ts,
        requests: bucket.requests,
        inputTokens: Number(bucket.inputTokens),
        outputTokens: Number(bucket.outputTokens),
        cost: Number(bucket.cost.toFixed(6)),
      });
    }

    // Build byProvider
    const byProvider: UsageMetricsResponse['byProvider'] = providerRows.map((row: any) => {
      const inputTokens = Number(row.input_tokens || 0);
      const outputTokens = Number(row.output_tokens || 0);
      const cacheReadTokens = Number(row.cache_read_tokens || 0);
      const cacheCreationTokens = Number(row.cache_creation_tokens || 0);

      // Compute cost using pricing from all models under this provider
      let providerCost = 0;
      for (const [modelName, pricing] of pricingMap.entries()) {
        providerCost += computeCost(pricing, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
      }

      return {
        provider: String(row.provider_key || 'unknown'),
        requests: Number(row.requests || 0),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cost: Number(providerCost.toFixed(6)),
      };
    });

    // Build byModel
    const byModel: UsageMetricsResponse['byModel'] = modelRows.map((row: any) => {
      const model = String(row.model_key || 'unknown');
      const inputTokens = Number(row.input_tokens || 0);
      const outputTokens = Number(row.output_tokens || 0);
      const cacheReadTokens = Number(row.cache_read_tokens || 0);
      const cacheCreationTokens = Number(row.cache_creation_tokens || 0);
      const pricing = pricingMap.get(model);
      const cost = computeCost(pricing, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);

      return {
        provider: String(row.provider_key || 'unknown'),
        model,
        requests: Number(row.requests || 0),
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        cost: Number(cost.toFixed(6)),
        pricing: pricing
          ? {
              input: pricing.input,
              output: pricing.output,
              cacheRead: pricing.cacheRead,
              cacheCreation: pricing.cacheCreation,
            }
          : null,
      };
    });

    // Calculate total cost
    const totalInputTokens = Number(summaryRow.total_input_tokens || 0);
    const totalOutputTokens = Number(summaryRow.total_output_tokens || 0);
    const totalCacheReadTokens = Number(summaryRow.total_cache_read_tokens || 0);
    const totalCacheCreationTokens = Number(summaryRow.total_cache_creation_tokens || 0);

    // For total cost, we sum up all model costs
    let totalCost = 0;
    for (const model of byModel) {
      totalCost += model.cost;
    }

    return {
      window,
      from: new Date(fromMs).toISOString(),
      to: new Date(nowMs).toISOString(),
      summary: {
        totalRequests: Number(summaryRow.total_requests || 0),
        totalInputTokens,
        totalOutputTokens,
        totalCacheReadTokens,
        totalCacheCreationTokens,
        totalCost: Number(totalCost.toFixed(6)),
      },
      byProvider,
      byModel,
      series,
    };
  } finally {
    await conn.run(`DROP VIEW IF EXISTS ${viewName}`).catch(() => {});
  }
}
