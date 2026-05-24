import type { IncomingMessage, ServerResponse } from "node:http";

const mutationMethods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseList(value: string | undefined) {
  return value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? [];
}

function originFromHostname(hostname: string | undefined) {
  const trimmed = hostname?.trim();

  if (!trimmed) {
    return [];
  }

  return [`https://${trimmed.toLowerCase()}`];
}

function normalizeOrigin(value: string) {
  try {
    return new URL(value).origin.toLowerCase();
  } catch {
    return "";
  }
}

function isDevelopmentLocalOrigin(origin: string) {
  if (process.env.NODE_ENV === "production") {
    return false;
  }

  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1"
    );
  } catch {
    return false;
  }
}

export function allowedOrigins() {
  const port = process.env.PORT || "3000";
  const configuredOrigins = parseList(process.env.APP_ALLOWED_ORIGINS).map(
    normalizeOrigin,
  );

  return new Set(
    [
      ...configuredOrigins,
      ...originFromHostname(process.env.CLOUDFLARE_HOSTNAME),
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      `http://[::1]:${port}`,
    ].filter(Boolean),
  );
}

export function isAllowedOrigin(origin: string | undefined) {
  if (!origin) {
    return process.env.NODE_ENV !== "production";
  }

  const normalizedOrigin = normalizeOrigin(origin);

  if (!normalizedOrigin) {
    return false;
  }

  return (
    allowedOrigins().has(normalizedOrigin) ||
    isDevelopmentLocalOrigin(normalizedOrigin)
  );
}

export function enforceMutationOrigin(
  request: IncomingMessage,
  response: ServerResponse,
) {
  if (!mutationMethods.has(request.method ?? "")) {
    return true;
  }

  if (isAllowedOrigin(request.headers.origin)) {
    return true;
  }

  response.writeHead(403, {
    "content-type": "application/json",
  });
  response.end(JSON.stringify({ error: "origin-not-allowed" }));
  return false;
}
