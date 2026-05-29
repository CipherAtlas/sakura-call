import crypto from "node:crypto";
import fs from "node:fs";
import { spawn } from "node:child_process";

const mode = process.argv[2] || "setup";
const fileEnv = {
  ...parseEnvFile(".env"),
  ...parseEnvFile(".env.local")
};
const env = {
  ...fileEnv,
  ...process.env
};

const token = env.CLOUDFLARE_API_TOKEN || env.CLOUDFARE_API_TOKEN;
const accountId = env.CLOUDFLARE_ACCOUNT_ID;
const zoneId = env.CLOUDFLARE_ZONE_ID;
const hostname = env.CLOUDFLARE_HOSTNAME;
const tunnelName = env.CLOUDFLARE_TUNNEL_NAME || "sakura-call";
const serviceUrl = env.CLOUDFLARE_SERVICE_URL || "http://localhost:3010";
const tunnelProtocol = env.TUNNEL_TRANSPORT_PROTOCOL || "http2";
const tunnelEdgeIpVersion = env.TUNNEL_EDGE_IP_VERSION || "4";

if (!token || !accountId || !zoneId || !hostname) {
  throw new Error(
    "Missing Cloudflare env. Required: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, CLOUDFLARE_HOSTNAME."
  );
}

function parseEnvFile(path) {
  const output = {};

  if (!fs.existsSync(path)) {
    return output;
  }

  for (const rawLine of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const index = line.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    output[key] = value;
  }

  return output;
}

async function cloudflare(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers || {})
    }
  });
  const json = await response.json().catch(() => ({}));

  if (!response.ok || json.success === false) {
    throw new Error(
      JSON.stringify(
        {
          status: response.status,
          errors: json.errors || []
        },
        null,
        2
      )
    );
  }

  return json.result;
}

async function findTunnel() {
  const tunnels = await cloudflare(
    `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(
      tunnelName
    )}&is_deleted=false&per_page=50`
  );

  return Array.isArray(tunnels) ? tunnels[0] : null;
}

async function ensureTunnel() {
  const existing = await findTunnel();

  if (existing) {
    return existing;
  }

  return cloudflare(`/accounts/${accountId}/cfd_tunnel`, {
    method: "POST",
    body: JSON.stringify({
      name: tunnelName,
      config_src: "cloudflare",
      tunnel_secret: crypto.randomBytes(32).toString("base64")
    })
  });
}

async function configureTunnel(tunnelId) {
  return cloudflare(
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: [
            {
              hostname,
              service: serviceUrl,
              originRequest: {}
            },
            {
              service: "http_status:404"
            }
          ]
        }
      })
    }
  );
}

async function replaceDnsRecord(tunnelId) {
  const existingRecords = await cloudflare(
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`
  );

  for (const record of existingRecords || []) {
    await cloudflare(`/zones/${zoneId}/dns_records/${record.id}`, {
      method: "DELETE"
    });
  }

  return cloudflare(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "CNAME",
      name: hostname,
      content: `${tunnelId}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: "Local Japanese-English WebRTC MVP via Cloudflare Tunnel"
    })
  });
}

async function getTunnelToken(tunnelId) {
  return cloudflare(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);
}

async function setup() {
  const [verify, zone] = await Promise.all([
    cloudflare("/user/tokens/verify"),
    cloudflare(`/zones/${zoneId}`)
  ]);
  const tunnel = await ensureTunnel();
  await configureTunnel(tunnel.id);
  const dnsRecord = await replaceDnsRecord(tunnel.id);

  console.log(
    JSON.stringify(
      {
        tokenStatus: verify.status,
        zone: zone.name,
        zoneStatus: zone.status,
        nameservers: zone.name_servers || [],
        hostname,
        serviceUrl,
        tunnelName: tunnel.name,
        tunnelId: tunnel.id,
        dnsRecord: {
          type: dnsRecord.type,
          name: dnsRecord.name,
          content: dnsRecord.content,
          proxied: dnsRecord.proxied
        }
      },
      null,
      2
    )
  );
}

async function run() {
  const tunnel = await ensureTunnel();
  const tunnelToken = await getTunnelToken(tunnel.id);
  let isStopping = false;
  console.log(
    `Starting Cloudflare tunnel with protocol=${tunnelProtocol} edge-ip-version=${tunnelEdgeIpVersion}`
  );

  const child = spawn(
    "cloudflared",
    [
      "tunnel",
      "--no-autoupdate",
      "--protocol",
      tunnelProtocol,
      "--edge-ip-version",
      tunnelEdgeIpVersion,
      "run",
      "--token",
      tunnelToken
    ],
    {
      env,
      stdio: "inherit"
    }
  );

  function stopChild() {
    if (isStopping) {
      return;
    }

    isStopping = true;
    child.kill("SIGTERM");

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 5_000);
    timeout.unref();

    child.once("exit", () => {
      clearTimeout(timeout);
      process.exit(0);
    });
  }

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, stopChild);
  }

  child.on("exit", (code, signal) => {
    if (isStopping) {
      return;
    }

    if (signal) {
      process.exit(1);
    }

    process.exit(code ?? 0);
  });
}

if (mode === "setup") {
  await setup();
} else if (mode === "run") {
  await run();
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
