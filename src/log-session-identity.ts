const USER_SESSION_DELIMITER = '_account__session_';

export interface LogSessionIdentity {
  hasMetadata: boolean;
  userIdRaw: string | null;
  userKey: string | null;
  sessionId: string | null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function extractUserIdRawFromRequestBody(requestBody: unknown): {
  hasMetadata: boolean;
  userIdRaw: string | null;
} {
  const requestBodyRecord = toRecord(requestBody);
  const metadata = toRecord(requestBodyRecord?.metadata);
  if (!metadata) {
    return {
      hasMetadata: false,
      userIdRaw: null,
    };
  }

  const userId = metadata.user_id;
  if (typeof userId !== 'string' || userId.trim() === '') {
    return {
      hasMetadata: true,
      userIdRaw: null,
    };
  }

  return {
    hasMetadata: true,
    userIdRaw: userId,
  };
}

// New format: JSON string with device_id, account_uuid, session_id
function parseUserSessionFromJsonFormat(
  userIdRaw: string
): { userKey: string; sessionId: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(userIdRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const sessionId = typeof obj.session_id === 'string' ? obj.session_id.trim() : '';
  if (!sessionId) return null;

  const userKey =
    (typeof obj.account_uuid === 'string' ? obj.account_uuid.trim() : '') ||
    (typeof obj.device_id === 'string' ? obj.device_id.trim() : '');

  return { userKey: userKey || sessionId, sessionId };
}

export function parseUserSessionFromUserIdRaw(
  userIdRaw: string
): { userKey: string; sessionId: string } | null {
  // Try new JSON format first
  if (userIdRaw.trimStart().startsWith('{')) {
    return parseUserSessionFromJsonFormat(userIdRaw);
  }

  // Legacy format: {userKey}_account__session_{sessionId}
  const index = userIdRaw.indexOf(USER_SESSION_DELIMITER);
  if (index <= 0) return null;

  const userKey = userIdRaw.slice(0, index).trim();
  const sessionId = userIdRaw.slice(index + USER_SESSION_DELIMITER.length).trim();
  if (!userKey || !sessionId) return null;

  return { userKey, sessionId };
}

export function resolveLogSessionIdentity(requestBody: unknown): LogSessionIdentity {
  const { hasMetadata, userIdRaw } = extractUserIdRawFromRequestBody(requestBody);
  if (!userIdRaw) {
    return {
      hasMetadata,
      userIdRaw: null,
      userKey: null,
      sessionId: null,
    };
  }

  const parsed = parseUserSessionFromUserIdRaw(userIdRaw);
  return {
    hasMetadata,
    userIdRaw,
    userKey: parsed?.userKey ?? null,
    sessionId: parsed?.sessionId ?? null,
  };
}
