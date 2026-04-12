import duckdb from '@duckdb/node-api';
import { join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

import type {
  LogEventSummary,
  LogQueryStats,
  LogQueryMeta,
  LogQueryResult,
  LogQueryParams,
  LogEventDetail,
  LogQueryContext,
  NormalizedLogQueryInput,
  LogLevel,
  StatusClass,
  LogQueryWindow,
} from './log-query';
import {
  normalizeQuery,
  encodeCursor,
  decodeCursor,
  listDateStrings,
  resolveLogQueryRange,
  validateLogLevel,
  validateStatusClass,
  validateSort,
  parseCommaSeparated,
  parseBooleanFlag,
  exportLogEvents,
} from './log-query';
import { resolveLogBaseDir } from './config';
import { resolveLogSessionIdentity } from './log-session-identity';
import type { LogEvent } from './logger';

// Re-export utilities and types for compatibility
export {
  resolveLogQueryRange,
  validateLogLevel,
  validateStatusClass,
  validateSort,
  parseCommaSeparated,
  parseBooleanFlag,
  exportLogEvents,
};

// Re-export isLogQueryWindow from log-query to keep consistency
export { isLogQueryWindow } from './log-query';

// Re-export LogQueryWindow type
export type { LogQueryWindow };

// Singleton DuckDB instance
let globalInstance: duckdb.DuckDBInstance | null = null;
let globalConnection: duckdb.DuckDBConnection | null = null;

export async function getDbConnection(): Promise<duckdb.DuckDBConnection> {
  if (!globalInstance) {
    globalInstance = await duckdb.DuckDBInstance.create(':memory:', { threads: '4' });
    globalConnection = await globalInstance.connect();
  }
  return globalConnection!;
}

export async function closeDbConnection(): Promise<void> {
  if (globalConnection) {
    await globalConnection.close();
    globalConnection = null;
  }
  if (globalInstance) {
    await globalInstance.close();
    globalInstance = null;
  }
}

// Encode event ID for pagination (using date + request_id since we don't have line numbers)
function encodeEventId(date: string, requestId: string): string {
  return Buffer.from(JSON.stringify({ d: date, r: requestId })).toString('base64url');
}

function decodeEventId(id: string): { date: string; requestId: string } {
  const parsed = JSON.parse(Buffer.from(id, 'base64url').toString('utf-8'));
  if (typeof parsed.d !== 'string' || typeof parsed.r !== 'string') {
    throw new Error('id 非法');
  }
  return { date: parsed.d, requestId: parsed.r };
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function escapeStringArray(arr: string[]): string {
  return arr.map((s) => `'${escapeSqlString(s)}'`).join(', ');
}

function getLevelFromRow(row: { error_type: string | null; upstream_status: number }): LogLevel {
  const hasError = row.error_type != null || row.upstream_status < 200 || row.upstream_status >= 400;
  return hasError ? 'error' : 'info';
}

function getStatusClassFromRow(row: { error_type: string | null; upstream_status: number }): StatusClass {
  if (row.error_type) return 'network_error';
  const status = row.upstream_status ?? 0;
  if (status >= 200 && status < 300) return '2xx';
  if (status >= 400 && status < 500) return '4xx';
  if (status >= 500) return '5xx';
  return 'network_error';
}

function buildMessageFromRow(row: {
  error_message: string | null;
  error_type: string | null;
  method: string;
  path: string;
  upstream_status: number;
}): string {
  if (row.error_message) return row.error_message;
  if (row.error_type) return row.error_type;
  return `${row.method} ${row.path} -> ${row.upstream_status ?? 0}`;
}

function readStreamContent(
  baseDir: string,
  streamFile: string | null | undefined
): { content: string | null; warning: string | null } {
  if (!streamFile) return { content: null, warning: null };

  try {
    const resolvedBase = resolve(baseDir);
    const resolvedFromFile = resolve(streamFile);
    const looksLikeStreamFile = resolvedFromFile.endsWith('.sse.raw');

    if (!looksLikeStreamFile) {
      return { content: null, warning: 'stream_file 不是 .sse.raw 文件，已跳过读取。' };
    }

    if (existsSync(resolvedFromFile)) {
      return { content: readFileSync(resolvedFromFile, 'utf-8'), warning: null };
    }

    const fallbackPath = resolve(resolvedBase, streamFile);
    if (!fallbackPath.startsWith(`${resolvedBase}/`) && fallbackPath !== resolvedBase) {
      return { content: null, warning: 'stream_file 路径非法，已拒绝读取。' };
    }
    if (!existsSync(fallbackPath)) {
      return { content: null, warning: 'stream_file 不存在，可能已被清理。' };
    }

    return { content: readFileSync(fallbackPath, 'utf-8'), warning: null };
  } catch (err) {
    return {
      content: null,
      warning: `stream_file 读取失败: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function detectBodyPolicy(event: LogEvent): 'off' | 'masked' | 'full' | 'unknown' {
  const hasRequestBody = event.request_body !== undefined;
  const hasResponseBody = event.response_body !== undefined;

  if (!hasRequestBody && !hasResponseBody) return 'off';

  if (hasResponseBody) {
    const sample = String(event.response_body ?? '');
    if (sample.includes('****')) return 'masked';
    return 'full';
  }

  const serialized = JSON.stringify(event.request_body);
  if (typeof serialized === 'string' && serialized.includes('****')) return 'masked';

  if (hasRequestBody) return 'full';
  return 'unknown';
}

function buildTruncatedHints(
  event: LogEvent,
  bodyPolicy: 'off' | 'masked' | 'full' | 'unknown'
): string[] {
  const hints: string[] = [];

  if (bodyPolicy === 'off') {
    hints.push('bodyPolicy=off，request/response body 未采集。');
  }

  if (event.request_body === undefined) {
    hints.push('request body 不可用。');
  }

  if (event.response_body === undefined) {
    hints.push('response body 不可用。');
  }

  if (event.stream_file?.endsWith('.sse.raw')) {
    hints.push('stream 文件可能因 maxBytesPerRequest 被截断，尾部会包含 [TRUNCATED] 标记。');
  }

  if (event.is_stream && !event.stream_file) {
    hints.push('本次为流式请求，但未生成 stream 文件（可能是 streams.enabled=false 或写入失败）。');
  }

  if (!event.is_stream) {
    hints.push('非流式请求，无 stream 数据。');
  }

  if (event.is_stream && event.stream_bytes != null && event.stream_bytes > 0) {
    hints.push(`已记录 stream 字节数: ${event.stream_bytes}`);
  }

  return hints;
}

async function buildLogEventDetail(
  id: string,
  event: LogEvent,
  location: { date: string; file: string },
  context: LogQueryContext
): Promise<LogEventDetail> {
  const level = getLevelFromRow({
    error_type: event.error_type,
    upstream_status: event.upstream_status,
  });
  const statusClass = getStatusClassFromRow({
    error_type: event.error_type,
    upstream_status: event.upstream_status,
  });
  const bodyPolicy = detectBodyPolicy(event);
  const requestBodyAvailable = event.request_body !== undefined;
  const responseBodyAvailable = event.response_body !== undefined;
  const streamCaptured = Boolean(event.stream_file);
  const { content: streamContent, warning: streamWarning } = readStreamContent(
    resolveLogBaseDir(context.logConfig),
    event.stream_file
  );

  // Build plugin-related info
  const hasPluginData =
    event.plugins_request ||
    event.plugins_response ||
    event.request_body_after_plugins !== undefined ||
    event.request_url_after_plugins !== undefined ||
    event.response_body_before_plugins !== undefined ||
    event.response_body_after_plugins !== undefined;

  const pluginsSection = hasPluginData
    ? {
        request: event.plugins_request,
        response: event.plugins_response,
        requestBodyAfterPlugins: event.request_body_after_plugins,
        requestUrlAfterPlugins: event.request_url_after_plugins,
        responseBodyBeforePlugins: event.response_body_before_plugins,
        responseBodyAfterPlugins: event.response_body_after_plugins,
      }
    : undefined;

  return {
    id,
    summary: {
      id,
      ts: event.ts_start,
      level,
      provider: event.provider,
      routeType: event.route_type,
      routeRuleKey: event.route_rule_key,
      requestId: event.request_id,
      latencyMs: Math.max(0, event.latency_ms ?? 0),
      upstreamStatus: event.upstream_status ?? 0,
      statusClass,
      hasError: level === 'error',
      model: event.model_out || event.model_in,
      modelIn: event.model_in,
      modelOut: event.model_out,
    },
    request: {
      method: event.method,
      path: event.path,
      contentType: event.content_type_req,
      requestHeaders: event.request_headers,
      requestBody: event.request_body ?? null,
    },
    response: {
      upstreamStatus: event.upstream_status ?? 0,
      contentType: event.content_type_res,
      responseHeaders: event.response_headers,
      responseBody: event.response_body ?? null,
    },
    upstream: {
      targetUrl: event.target_url,
      proxyUrl: event.proxy_url ?? null,
      providerRequestId: event.provider_request_id,
      errorType: event.error_type,
      errorMessage: event.error_message,
      isStream: event.is_stream,
      streamFile: event.stream_file ?? null,
      streamContent,
    },
    capture: {
      bodyPolicy: context.logConfig?.bodyPolicy ?? bodyPolicy,
      requestBodyAvailable,
      responseBodyAvailable,
      streamCaptured,
      truncatedHints: [
        ...buildTruncatedHints(event, context.logConfig?.bodyPolicy ?? bodyPolicy),
        ...(streamWarning ? [streamWarning] : []),
      ],
    },
    ...(pluginsSection && { plugins: pluginsSection }),
    rawEvent: event,
    location: {
      ...location,
      line: 0, // DuckDB doesn't track line numbers
    },
  };
}

function mapRowToSummary(row: any, date: string): LogEventSummary {
  const level = getLevelFromRow({
    error_type: row.error_type,
    upstream_status: Number(row.upstream_status || 0),
  });
  const statusClass = getStatusClassFromRow({
    error_type: row.error_type,
    upstream_status: Number(row.upstream_status || 0),
  });

  // Parse request_body for identity
  let requestBody: unknown;
  try {
    requestBody =
      typeof row.request_body === 'string' ? JSON.parse(row.request_body) : row.request_body;
  } catch {
    requestBody = undefined;
  }
  const identity = resolveLogSessionIdentity(requestBody);

  const message = buildMessageFromRow({
    error_message: row.error_message,
    error_type: row.error_type,
    method: row.method,
    path: row.path,
    upstream_status: Number(row.upstream_status || 0),
  });

  return {
    id: encodeEventId(date, String(row.request_id)),
    ts: row.ts_start,
    level,
    provider: row.provider,
    routeType: row.route_type,
    model: row.model_out || row.model_in,
    modelIn: row.model_in,
    modelOut: row.model_out,
    path: row.path,
    requestId: String(row.request_id),
    latencyMs: Math.max(0, Number(row.latency_ms || 0)),
    upstreamStatus: Number(row.upstream_status || 0),
    statusClass,
    hasError: level === 'error',
    message,
    errorType: row.error_type || null,
    hasMetadata: identity.hasMetadata,
    userIdRaw: identity.userIdRaw,
    userKey: identity.userKey,
    sessionId: identity.sessionId,
  };
}

function buildSqlFilters(query: LogQueryParams): string {
  const filters: string[] = [];

  // Time range
  const fromIso = new Date(query.fromMs).toISOString();
  const toIso = new Date(query.toMs).toISOString();
  filters.push(`ts_start >= '${fromIso}' AND ts_start <= '${toIso}'`);

  // Levels
  if (query.levels.length > 0) {
    const isError = query.levels.includes('error');
    const isInfo = query.levels.includes('info');
    if (isError && !isInfo) {
      filters.push(
        "(error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400)"
      );
    } else if (isInfo && !isError) {
      filters.push(
        "(error_type IS NULL AND upstream_status >= 200 AND upstream_status < 400)"
      );
    }
  }

  // Providers
  if (query.providers.length > 0) {
    filters.push(`provider IN (${escapeStringArray(query.providers)})`);
  }

  // Route types
  if (query.routeTypes.length > 0) {
    filters.push(`route_type IN (${escapeStringArray(query.routeTypes)})`);
  }

  // Models (model_out or model_in)
  if (query.models.length > 0) {
    filters.push(`COALESCE(NULLIF(model_out, ''), model_in) IN (${escapeStringArray(query.models)})`);
  }

  // Model ins
  if (query.modelIns.length > 0) {
    filters.push(`model_in IN (${escapeStringArray(query.modelIns)})`);
  }

  // Model outs
  if (query.modelOuts.length > 0) {
    filters.push(`model_out IN (${escapeStringArray(query.modelOuts)})`);
  }

  // Status classes
  if (query.statusClasses.length > 0) {
    const classConditions: string[] = [];
    if (query.statusClasses.includes('2xx')) {
      classConditions.push('(upstream_status >= 200 AND upstream_status < 300 AND error_type IS NULL)');
    }
    if (query.statusClasses.includes('4xx')) {
      classConditions.push('(upstream_status >= 400 AND upstream_status < 500 AND error_type IS NULL)');
    }
    if (query.statusClasses.includes('5xx')) {
      classConditions.push('(upstream_status >= 500 AND error_type IS NULL)');
    }
    if (query.statusClasses.includes('network_error')) {
      classConditions.push('error_type IS NOT NULL');
    }
    if (classConditions.length > 0) {
      filters.push(`(${classConditions.join(' OR ')})`);
    }
  }

  // hasError
  if (query.hasError !== null) {
    if (query.hasError) {
      filters.push("(error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400)");
    } else {
      filters.push("(error_type IS NULL AND upstream_status >= 200 AND upstream_status < 400)");
    }
  }

  // Keyword search (q)
  if (query.q) {
    const searchStr = escapeSqlString(query.q.toLowerCase());
    filters.push(`(
      lower(request_id) LIKE '%${searchStr}%' OR
      lower(path) LIKE '%${searchStr}%' OR
      lower(provider) LIKE '%${searchStr}%' OR
      lower(model_in) LIKE '%${searchStr}%' OR
      lower(model_out) LIKE '%${searchStr}%' OR
      lower(route_type) LIKE '%${searchStr}%' OR
      lower(error_type) LIKE '%${searchStr}%' OR
      lower(error_message) LIKE '%${searchStr}%'
    )`);
  }

  return filters.join(' AND ');
}

export async function queryLogEventsDuck(
  context: LogQueryContext,
  input: NormalizedLogQueryInput
): Promise<LogQueryResult> {
  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  const emptyResult: LogQueryResult = {
    items: [],
    nextCursor: null,
    hasMore: false,
    stats: { total: 0, errorCount: 0, errorRate: 0, avgLatencyMs: 0, p95LatencyMs: 0 },
    meta: { scannedFiles: 0, scannedLines: 0, parseErrors: 0, truncated: false },
  };

  if (!logEnabled) return emptyResult;

  const baseDir = resolveLogBaseDir(context.logConfig);
  const query = normalizeQuery(input);
  const offset = query.cursor ? decodeCursor(query.cursor).offset : 0;

  const dates = listDateStrings(query.fromMs, query.toMs);
  const files = dates
    .map((date) => join(baseDir, 'events', `${date}.jsonl`))
    .filter(existsSync);

  if (files.length === 0) return emptyResult;

  const conn = await getDbConnection();

  // Build file list for SQL
  const fileList = files.map((f) => `'${f}'`).join(', ');
  const sqlFilters = buildSqlFilters(query);
  const sortDir = query.sort === 'time_asc' ? 'ASC' : 'DESC';

  // Create a temp view for the JSONL files
  const viewName = `events_view_${Date.now()}`;
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW ${viewName} AS
    SELECT * FROM read_json_auto([${fileList}], maximum_depth=1, ignore_errors=true)
  `);

  try {
    // Query items with pagination
    const sqlItems = `
      SELECT
        request_id,
        ts_start,
        provider,
        route_type,
        model_in,
        model_out,
        path,
        latency_ms,
        upstream_status,
        error_type,
        error_message,
        method,
        request_body
      FROM ${viewName}
      WHERE ${sqlFilters}
      ORDER BY ts_start ${sortDir}, request_id ${sortDir}
      LIMIT ${query.limit + 1}
      OFFSET ${offset}
    `;

    // Query stats
    const sqlStats = `
      SELECT
        COUNT(*)::INTEGER as total,
        SUM(CASE WHEN error_type IS NOT NULL OR upstream_status < 200 OR upstream_status >= 400 THEN 1 ELSE 0 END)::INTEGER as error_count,
        AVG(latency_ms) as avg_latency,
        QUANTILE_CONT(latency_ms, 0.95) as p95_latency
      FROM ${viewName}
      WHERE ${sqlFilters}
    `;

    const [itemsResult, statsResult] = await Promise.all([
      conn.run(sqlItems),
      conn.run(sqlStats),
    ]);

    const rawItems = await itemsResult.getRowObjects();
    const statsRow = (await statsResult.getRowObjects())[0] || {};

    const total = Number(statsRow.total || 0);
    const errorCount = Number(statsRow.error_count || 0);

    const hasMore = rawItems.length > query.limit;
    const pageItemsRaw = rawItems.slice(0, query.limit);

    // Map to summary format
    const items: LogEventSummary[] = pageItemsRaw.map((row: any) => {
      // Extract date from ts_start
      const date = row.ts_start ? row.ts_start.slice(0, 10) : 'unknown';
      return mapRowToSummary(row, date);
    });

    return {
      items,
      nextCursor: hasMore ? encodeCursor({ offset: offset + pageItemsRaw.length }) : null,
      hasMore,
      stats: {
        total,
        errorCount,
        errorRate: total > 0 ? Number(((errorCount / total) * 100).toFixed(2)) : 0,
        avgLatencyMs: Math.round(Number(statsRow.avg_latency || 0)),
        p95LatencyMs: Math.round(Number(statsRow.p95_latency || 0)),
      },
      meta: {
        scannedFiles: files.length,
        scannedLines: total, // DuckDB doesn't give us exact scanned lines
        parseErrors: 0,
        truncated: false,
      },
    };
  } finally {
    // Clean up view
    await conn.run(`DROP VIEW IF EXISTS ${viewName}`).catch(() => {});
  }
}

export async function getLogEventDetailByIdDuck(
  context: LogQueryContext,
  id: string
): Promise<LogEventDetail | null> {
  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  if (!logEnabled) return null;

  const { date, requestId } = decodeEventId(id);
  const baseDir = resolveLogBaseDir(context.logConfig);
  const filePath = join(baseDir, 'events', `${date}.jsonl`);

  if (!existsSync(filePath)) return null;

  const conn = await getDbConnection();

  const result = await conn.run(`
    SELECT * FROM read_json_auto('${filePath}', maximum_depth=1, ignore_errors=true)
    WHERE request_id = '${escapeSqlString(requestId)}'
    LIMIT 1
  `);

  const rows = await result.getRowObjects();
  if (rows.length === 0) return null;

  const row = rows[0];

  // Convert row to LogEvent format
  const event: LogEvent = {
    request_id: String(row.request_id),
    ts_start: String(row.ts_start),
    ts_end: String(row.ts_end),
    latency_ms: Number(row.latency_ms || 0),
    method: String(row.method),
    path: String(row.path),
    route_type: String(row.route_type),
    route_rule_key: String(row.route_rule_key),
    provider: String(row.provider),
    model_in: String(row.model_in || ''),
    model_out: String(row.model_out || ''),
    target_url: String(row.target_url),
    proxy_url: row.proxy_url ? String(row.proxy_url) : null,
    is_stream: Boolean(row.is_stream),
    upstream_status: Number(row.upstream_status || 0),
    content_type_req: row.content_type_req ? String(row.content_type_req) : null,
    content_type_res: row.content_type_res ? String(row.content_type_res) : null,
    user_agent: row.user_agent ? String(row.user_agent) : null,
    request_headers: row.request_headers || {},
    response_headers: row.response_headers || {},
    request_bytes: Number(row.request_bytes || 0),
    response_bytes: row.response_bytes != null ? Number(row.response_bytes) : null,
    stream_bytes: row.stream_bytes != null ? Number(row.stream_bytes) : null,
    provider_request_id: row.provider_request_id ? String(row.provider_request_id) : null,
    error_type: row.error_type ? String(row.error_type) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    request_body: row.request_body,
    response_body: row.response_body != null ? String(row.response_body) : undefined,
    stream_file: row.stream_file ? String(row.stream_file) : undefined,
    plugins_request: row.plugins_request,
    request_body_after_plugins: row.request_body_after_plugins,
    request_url_after_plugins: row.request_url_after_plugins ? String(row.request_url_after_plugins) : undefined,
    plugins_response: row.plugins_response,
    response_body_before_plugins: row.response_body_before_plugins != null ? String(row.response_body_before_plugins) : undefined,
    response_body_after_plugins: row.response_body_after_plugins != null ? String(row.response_body_after_plugins) : undefined,
  };

  return buildLogEventDetail(id, event, { date, file: filePath }, context);
}
