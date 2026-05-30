import crypto from "node:crypto";

const cloudflareTurnEndpointBase = "https://rtc.live.cloudflare.com/v1/turn/keys";
const cloudflareTurnHost = "turn.cloudflare.com";
const cloudflareTurnProvider = "Cloudflare Realtime TURN";
const defaultCredentialTtlSeconds = 86_400;
const browserBlockedPortPattern = /:53(?:[/?]|$)/;

type TurnPhase = "disabled" | "ready" | "error";

export type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  provider?: string;
  host?: string;
  expiresAt?: number;
  updatedAt: number;
};

type CloudflareIceServerResponse = {
  iceServers?: unknown;
};

type CredentialCacheEntry = {
  expiresAt: number;
  iceServers: RTCIceServer[];
};

const credentialCache = new Map<string, CredentialCacheEntry>();
const pendingCredentials = new Map<string, Promise<CredentialCacheEntry>>();

let statusUpdatedAt = Date.now();
let lastError = "";
let lastCredentialExpiresAt = 0;

function envValue(key: string) {
  return process.env[key]?.trim() ?? "";
}

function cloudflareTurnKeyId() {
  return (
    envValue("CLOUDFLARE_TURN_TOKEN_ID") ||
    envValue("CLOUDFLARE_TURN_KEY_ID") ||
    envValue("TURN_TOKEN_ID") ||
    envValue("TURN_KEY_ID")
  );
}

function cloudflareTurnKeyApiToken() {
  return (
    envValue("CLOUDFLARE_TURN_API_TOKEN") ||
    envValue("CLOUDFLARE_TURN_KEY_API_TOKEN") ||
    envValue("TURN_API_TOKEN") ||
    envValue("TURN_KEY_API_TOKEN")
  );
}

function isConfigured() {
  return Boolean(cloudflareTurnKeyId() && cloudflareTurnKeyApiToken());
}

function credentialTtlSeconds() {
  const value = Number(envValue("CLOUDFLARE_TURN_TTL_SECONDS"));

  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return defaultCredentialTtlSeconds;
}

function cacheRefreshBufferMs(ttlSeconds: number) {
  return Math.min(5 * 60_000, Math.max(30_000, ttlSeconds * 1000 * 0.1));
}

function credentialCacheKey(
  roomId: string,
  participantId: string,
  participantSessionToken: string,
) {
  const sessionHash = crypto
    .createHash("sha256")
    .update(participantSessionToken)
    .digest("base64url");

  return `${roomId}:${participantId}:${sessionHash}`;
}

function normalizeIceUrls(value: unknown) {
  const urls = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];

  return urls
    .filter((url): url is string => typeof url === "string")
    .map((url) => url.trim())
    .filter(Boolean)
    .filter((url) => !browserBlockedPortPattern.test(url));
}

function normalizeIceServer(value: unknown): RTCIceServer | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const urls = normalizeIceUrls(record.urls);

  if (urls.length === 0) {
    return null;
  }

  const iceServer: RTCIceServer = { urls };

  if (typeof record.username === "string" && record.username) {
    iceServer.username = record.username;
  }

  if (typeof record.credential === "string" && record.credential) {
    iceServer.credential = record.credential;
  }

  return iceServer;
}

function normalizeIceServers(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeIceServer(item))
    .filter((item): item is RTCIceServer => Boolean(item));
}

function hasTurnServer(iceServers: RTCIceServer[]) {
  return iceServers.some((server) => {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];

    return urls.some((url) => /^turns?:/i.test(url));
  });
}

function setReady(expiresAt: number) {
  lastError = "";
  lastCredentialExpiresAt = expiresAt;
  statusUpdatedAt = Date.now();
}

function setError(error: unknown) {
  lastError = error instanceof Error ? error.message : "Could not generate TURN credentials";
  statusUpdatedAt = Date.now();
}

async function generateCloudflareIceServers(): Promise<CredentialCacheEntry> {
  const keyId = cloudflareTurnKeyId();
  const token = cloudflareTurnKeyApiToken();

  if (!keyId || !token) {
    throw new Error("Cloudflare TURN is not configured");
  }

  const ttl = credentialTtlSeconds();
  const response = await fetch(
    `${cloudflareTurnEndpointBase}/${encodeURIComponent(
      keyId,
    )}/credentials/generate-ice-servers`,
    {
      body: JSON.stringify({ ttl }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(`Cloudflare TURN credential request failed (${response.status})`);
  }

  const body = (await response.json()) as CloudflareIceServerResponse;
  const iceServers = normalizeIceServers(body.iceServers);

  if (!hasTurnServer(iceServers)) {
    throw new Error("Cloudflare TURN response did not include a TURN server");
  }

  return {
    expiresAt: Date.now() + ttl * 1000,
    iceServers,
  };
}

export async function getCloudflareTurnIceServers({
  roomId,
  participantId,
  participantSessionToken,
}: {
  roomId: string;
  participantId: string;
  participantSessionToken: string;
}) {
  if (!isConfigured()) {
    return null;
  }

  const ttl = credentialTtlSeconds();
  const key = credentialCacheKey(roomId, participantId, participantSessionToken);
  const cached = credentialCache.get(key);

  if (cached && cached.expiresAt - Date.now() > cacheRefreshBufferMs(ttl)) {
    return cached.iceServers;
  }

  const pending = pendingCredentials.get(key);

  if (pending) {
    return (await pending).iceServers;
  }

  const nextCredential = generateCloudflareIceServers();
  pendingCredentials.set(key, nextCredential);

  try {
    const credential = await nextCredential;
    credentialCache.set(key, credential);
    setReady(credential.expiresAt);
    return credential.iceServers;
  } catch (error) {
    credentialCache.delete(key);
    setError(error);
    throw error;
  } finally {
    pendingCredentials.delete(key);
  }
}

export function getTurnStatus(): TurnStatus {
  if (!isConfigured()) {
    return {
      phase: "disabled",
      progress: 0,
      message: "Cloudflare TURN is not configured",
      provider: cloudflareTurnProvider,
      updatedAt: statusUpdatedAt,
    };
  }

  if (lastError) {
    return {
      phase: "error",
      progress: 0,
      message: lastError,
      provider: cloudflareTurnProvider,
      host: cloudflareTurnHost,
      updatedAt: statusUpdatedAt,
    };
  }

  return {
    phase: "ready",
    progress: 100,
    message: "Cloudflare TURN is configured",
    provider: cloudflareTurnProvider,
    host: cloudflareTurnHost,
    expiresAt: lastCredentialExpiresAt || undefined,
    updatedAt: statusUpdatedAt,
  };
}
