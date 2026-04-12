import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { LogConfig } from './config';
import { resolveLogBaseDir } from './config';
import type {
  LogSessionSummary,
  LogUserSummary,
  LogSessionsSummary,
  LogSessionsMeta,
  LogSessionsResult,
  QueryLogSessionsInput,
} from './log-sessions';
import { getDbConnection } from './log-query-duckdb';

// Re-export types
export type {
  LogSessionSummary,
  LogUserSummary,
  LogSessionsSummary,
  LogSessionsMeta,
  LogSessionsResult,
  QueryLogSessionsInput,
};

export interface LogSessionsContext {
  logConfig?: LogConfig;
}

const MAX_Q_LENGTH = 200;

interface NormalizedQueryInput {
  fromMs: number;
  toMs: number;
  users: string[];
  sessions: string[];
  q: string;
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

function normalizeInput(input: QueryLogSessionsInput): NormalizedQueryInput {
  const qRaw = (input.q ?? '').trim();
  return {
    fromMs: input.fromMs,
    toMs: input.toMs,
    users: (input.users ?? []).map((item) => item.trim()).filter(Boolean),
    sessions: (input.sessions ?? []).map((item) => item.trim()).filter(Boolean),
    q: qRaw.length > MAX_Q_LENGTH ? qRaw.slice(0, MAX_Q_LENGTH) : qRaw,
  };
}

function createEmptyResult(fromMs: number, toMs: number): LogSessionsResult {
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    summary: {
      totalRequests: 0,
      metadataRequests: 0,
      uniqueUsers: 0,
      uniqueSessions: 0,
    },
    users: [],
    meta: {
      scannedFiles: 0,
      scannedLines: 0,
      parseErrors: 0,
      truncated: false,
    },
  };
}

interface RawEventRow {
  request_id: string;
  ts_start: string;
  provider: string;
  route_type: string;
  model_in: string;
  model_out: string;
  request_body: unknown;
}

// Parse user/session identity from request_body (same logic as log-session-identity.ts)
function extractIdentity(requestBody: unknown): {
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
  hasMetadata: boolean;
} {
  if (!requestBody || typeof requestBody !== 'object' || Array.isArray(requestBody)) {
    return { userIdRaw: null, userKey: null, sessionId: null, hasMetadata: false };
  }

  const record = requestBody as Record<string, unknown>;
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return { userIdRaw: null, userKey: null, sessionId: null, hasMetadata: false };
  }

  const metaRecord = metadata as Record<string, unknown>;
  const userId = typeof metaRecord.user_id === 'string' ? metaRecord.user_id.trim() : null;
  if (!userId) {
    return { userIdRaw: null, userKey: null, sessionId: null, hasMetadata: true };
  }

  // Try JSON format first
  if (userId.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(userId) as Record<string, unknown>;
      const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id.trim() : '';
      if (!sessionId) {
        return { userIdRaw: userId, userKey: null, sessionId: null, hasMetadata: true };
      }
      const userKey =
        (typeof parsed.account_uuid === 'string' ? parsed.account_uuid.trim() : '') ||
        (typeof parsed.device_id === 'string' ? parsed.device_id.trim() : '') ||
        sessionId;
      return { userIdRaw: userId, userKey, sessionId, hasMetadata: true };
    } catch {
      // Fall through to legacy format
    }
  }

  // Legacy format: {userKey}_account__session_{sessionId}
  const delimiter = '_account__session_';
  const index = userId.indexOf(delimiter);
  if (index <= 0) {
    return { userIdRaw: userId, userKey: null, sessionId: null, hasMetadata: true };
  }

  const userKey = userId.slice(0, index).trim();
  const sessionId = userId.slice(index + delimiter.length).trim();
  if (!userKey || !sessionId) {
    return { userIdRaw: userId, userKey: null, sessionId: null, hasMetadata: true };
  }

  return { userIdRaw: userId, userKey, sessionId, hasMetadata: true };
}

function shouldIncludeByKeyword(
  row: RawEventRow,
  identity: { userIdRaw: string | null; userKey: string | null; sessionId: string | null },
  keyword: string
): boolean {
  if (!keyword) return true;
  const lowerKeyword = keyword.toLowerCase();
  const haystack = [
    identity.userIdRaw ?? '',
    identity.userKey ?? '',
    identity.sessionId ?? '',
    row.provider,
    row.route_type,
    row.model_in,
    row.model_out,
  ]
    .join(' ')
    .toLowerCase();
  return haystack.includes(lowerKeyword);
}

export async function queryLogSessionsDuck(
  context: LogSessionsContext,
  input: QueryLogSessionsInput
): Promise<LogSessionsResult> {
  const normalized = normalizeInput(input);

  const logEnabled = !!context.logConfig && context.logConfig.enabled !== false;
  if (!logEnabled) {
    return createEmptyResult(normalized.fromMs, normalized.toMs);
  }

  const baseDir = resolveLogBaseDir(context.logConfig);
  const eventsDir = join(baseDir, 'events');
  if (!existsSync(eventsDir)) {
    return createEmptyResult(normalized.fromMs, normalized.toMs);
  }

  const dates = listDateStrings(normalized.fromMs, normalized.toMs);
  const files = dates
    .map((date) => join(baseDir, 'events', `${date}.jsonl`))
    .filter(existsSync);

  if (files.length === 0) {
    return createEmptyResult(normalized.fromMs, normalized.toMs);
  }

  const conn = await getDbConnection();
  const fileList = files.map((f) => `'${f}'`).join(', ');

  // Create temp view
  const viewName = `sessions_view_${Date.now()}`;
  await conn.run(`
    CREATE OR REPLACE TEMP VIEW ${viewName} AS
    SELECT * FROM read_json_auto([${fileList}], maximum_depth=1, ignore_errors=true)
  `);

  try {
    const fromIso = new Date(normalized.fromMs).toISOString();
    const toIso = new Date(normalized.toMs).toISOString();

    // Query all events with necessary fields
    const sql = `
      SELECT
        request_id,
        ts_start,
        provider,
        route_type,
        model_in,
        model_out,
        request_body
      FROM ${viewName}
      WHERE ts_start >= '${fromIso}' AND ts_start <= '${toIso}'
      ORDER BY ts_start
    `;

    const result = await conn.run(sql);
    const rows = await result.getRowObjects();

    // Process in JavaScript (identity parsing is too complex for SQL)
    const usersMap = new Map<string, LogUserSummary>();
    const uniqueUsers = new Set<string>();
    const uniqueSessions = new Set<string>();

    let totalRequests = 0;
    let metadataRequests = 0;

    for (const rawRow of rows) {
      const row: RawEventRow = {
        request_id: String(rawRow.request_id),
        ts_start: String(rawRow.ts_start),
        provider: String(rawRow.provider || ''),
        route_type: String(rawRow.route_type || ''),
        model_in: String(rawRow.model_in || ''),
        model_out: String(rawRow.model_out || ''),
        request_body: rawRow.request_body,
      };

      const identity = extractIdentity(row.request_body);

      // Filter by users
      if (normalized.users.length > 0) {
        const matchedByRaw = identity.userIdRaw ? normalized.users.includes(identity.userIdRaw) : false;
        const matchedByUserKey = identity.userKey ? normalized.users.includes(identity.userKey) : false;
        if (!matchedByRaw && !matchedByUserKey) continue;
      }

      // Filter by sessions
      if (normalized.sessions.length > 0) {
        if (!identity.sessionId || !normalized.sessions.includes(identity.sessionId)) continue;
      }

      // Filter by keyword
      if (!shouldIncludeByKeyword(row, identity, normalized.q)) continue;

      totalRequests++;
      if (identity.hasMetadata) metadataRequests++;

      if (identity.userKey) {
        uniqueUsers.add(identity.userKey);
      }
      if (identity.sessionId) {
        uniqueSessions.add(identity.sessionId);
      }

      if (!identity.userKey || !identity.sessionId) continue;

      const model = row.model_out || row.model_in || 'unknown';
      const tsMs = Date.parse(row.ts_start);

      // Get or create user
      let user = usersMap.get(identity.userKey);
      if (!user) {
        user = {
          userKey: identity.userKey,
          requestCount: 0,
          sessionCount: 0,
          firstSeenAt: row.ts_start,
          lastSeenAt: row.ts_start,
          models: [],
          providers: [],
          routeTypes: [],
          sessions: [],
        };
        usersMap.set(identity.userKey, user);
      }

      user.requestCount++;
      if (tsMs < Date.parse(user.firstSeenAt)) user.firstSeenAt = row.ts_start;
      if (tsMs > Date.parse(user.lastSeenAt)) user.lastSeenAt = row.ts_start;

      // Update user models/providers/routeTypes
      const updateCount = (items: { key: string; count: number }[], key: string) => {
        const item = items.find((i) => i.key === key);
        if (item) {
          item.count++;
        } else {
          items.push({ key, count: 1 });
        }
      };

      updateCount(user.models, model);
      updateCount(user.providers, row.provider);
      updateCount(user.routeTypes, row.route_type);

      // Get or create session
      let session = user.sessions.find((s) => s.sessionId === identity.sessionId);
      if (!session) {
        session = {
          sessionId: identity.sessionId,
          requestCount: 0,
          firstSeenAt: row.ts_start,
          lastSeenAt: row.ts_start,
          models: [],
          latestRequestId: row.request_id,
        };
        user.sessions.push(session);
      }

      session.requestCount++;
      if (tsMs < Date.parse(session.firstSeenAt)) session.firstSeenAt = row.ts_start;
      if (tsMs >= Date.parse(session.lastSeenAt)) {
        session.lastSeenAt = row.ts_start;
        session.latestRequestId = row.request_id;
      }

      updateCount(session.models, model);
    }

    // Sort and finalize
    const users = Array.from(usersMap.values())
      .map((user) => {
        // Sort count items
        const sortItems = (items: { key: string; count: number }[]) =>
          items.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

        sortItems(user.models);
        sortItems(user.providers);
        sortItems(user.routeTypes);

        user.sessionCount = user.sessions.length;

        user.sessions = user.sessions
          .map((session) => {
            sortItems(session.models);
            return session;
          })
          .sort((a, b) => {
            if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
            return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
          });

        return user;
      })
      .sort((a, b) => {
        if (a.requestCount !== b.requestCount) return b.requestCount - a.requestCount;
        return Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt);
      });

    return {
      from: new Date(normalized.fromMs).toISOString(),
      to: new Date(normalized.toMs).toISOString(),
      summary: {
        totalRequests,
        metadataRequests,
        uniqueUsers: uniqueUsers.size,
        uniqueSessions: uniqueSessions.size,
      },
      users,
      meta: {
        scannedFiles: files.length,
        scannedLines: rows.length,
        parseErrors: 0,
        truncated: false,
      },
    };
  } finally {
    await conn.run(`DROP VIEW IF EXISTS ${viewName}`).catch(() => {});
  }
}
