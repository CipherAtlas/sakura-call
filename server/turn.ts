import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type TurnPhase =
  | "disabled"
  | "idle"
  | "checking"
  | "starting-vm"
  | "waiting-vm"
  | "waiting-ssh"
  | "starting-turn"
  | "ready"
  | "stopping"
  | "error";

export type TurnStatus = {
  phase: TurnPhase;
  progress: number;
  message: string;
  host?: string;
  urls?: string[];
  updatedAt: number;
};

const sshOptions = [
  "-o",
  "StrictHostKeyChecking=accept-new",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=10",
];

let status: TurnStatus = {
  phase: "idle",
  progress: 0,
  message: "TURN relay is off",
  updatedAt: Date.now(),
};
let operation: Promise<TurnStatus> | null = null;
let ociConfigFile = "";
let turnHost = "";
let turnUsername = "";
let turnCredential = "";
let startedByServer = false;

function envValue(key: string) {
  return process.env[key]?.trim() ?? "";
}

function envValueAny(...keys: string[]) {
  for (const key of keys) {
    const value = envValue(key);

    if (value) {
      return value;
    }
  }

  return "";
}

function setStatus(next: Omit<TurnStatus, "updatedAt">) {
  status = {
    ...next,
    updatedAt: Date.now(),
  };
  return status;
}

function randomSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function isConfigured() {
  return Boolean(
    envValue("OCI_TURN_INSTANCE_ID") &&
      envValue("OCI_TURN_SSH_USER") &&
      envValue("OCI_TURN_SSH_KEY_FILE") &&
      envValueAny("OCI_USER_OCID", "oci_user") &&
      envValueAny("OCI_FINGERPRINT", "oci_fingerprint") &&
      envValueAny("OCI_TENANCY_OCID", "oci_tenancy") &&
      envValueAny("OCI_REGION", "oci_region") &&
      envValueAny("OCI_PRIVATE_KEY_FILE", "oci_key_file"),
  );
}

async function run(command: string, args: string[]) {
  const { stdout } = await execFileAsync(command, args, {
    env: {
      ...process.env,
      OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING:
        process.env.OCI_CLI_SUPPRESS_FILE_PERMISSIONS_WARNING ?? "True",
      PYTHONWARNINGS:
        process.env.PYTHONWARNINGS ?? "ignore::FutureWarning",
    },
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}

async function writeOciConfig() {
  if (ociConfigFile) {
    return ociConfigFile;
  }

  const configPath = path.join(
    os.tmpdir(),
    `sakura-turn-${process.pid}-${Date.now()}`,
  );
  const contents = [
    "[DEFAULT]",
    `user=${envValueAny("OCI_USER_OCID", "oci_user")}`,
    `fingerprint=${envValueAny("OCI_FINGERPRINT", "oci_fingerprint")}`,
    `tenancy=${envValueAny("OCI_TENANCY_OCID", "oci_tenancy")}`,
    `region=${envValueAny("OCI_REGION", "oci_region")}`,
    `key_file=${envValueAny("OCI_PRIVATE_KEY_FILE", "oci_key_file")}`,
    "",
  ].join("\n");

  await fs.writeFile(configPath, contents, { mode: 0o600 });
  ociConfigFile = configPath;
  return configPath;
}

async function getInstanceState(instanceId: string) {
  return run("oci", [
    "--config-file",
    await writeOciConfig(),
    "compute",
    "instance",
    "get",
    "--instance-id",
    instanceId,
    "--query",
    'data."lifecycle-state"',
    "--raw-output",
  ]);
}

async function waitForInstance(instanceId: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const state = await getInstanceState(instanceId);

    if (state === "RUNNING") {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  throw new Error("Timed out waiting for OCI TURN VM to start");
}

async function getInstancePublicIp(instanceId: string) {
  const configFile = await writeOciConfig();
  const vnicId = await run("oci", [
    "--config-file",
    configFile,
    "compute",
    "instance",
    "list-vnics",
    "--instance-id",
    instanceId,
    "--query",
    "data[0].id",
    "--raw-output",
  ]);

  return run("oci", [
    "--config-file",
    configFile,
    "network",
    "vnic",
    "get",
    "--vnic-id",
    vnicId,
    "--query",
    'data."public-ip"',
    "--raw-output",
  ]);
}

async function waitForSsh(sshUser: string, sshKey: string, host: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await run("ssh", ["-i", sshKey, ...sshOptions, `${sshUser}@${host}`, "true"]);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  throw new Error("Timed out waiting for SSH on OCI TURN VM");
}

async function startTurn() {
  if (!isConfigured()) {
    return setStatus({
      phase: "disabled",
      progress: 0,
      message: "TURN relay is not configured",
    });
  }

  setStatus({
    phase: "checking",
    progress: 10,
    message: "Checking TURN VM",
  });

  const instanceId = envValue("OCI_TURN_INSTANCE_ID");
  const sshUser = envValue("OCI_TURN_SSH_USER");
  const sshKey = envValue("OCI_TURN_SSH_KEY_FILE");
  let state = await getInstanceState(instanceId);

  if (state !== "RUNNING") {
    setStatus({
      phase: "starting-vm",
      progress: 24,
      message: "Starting TURN VM",
    });
    await run("oci", [
      "--config-file",
      await writeOciConfig(),
      "compute",
      "instance",
      "action",
      "--instance-id",
      instanceId,
      "--action",
      "START",
    ]);
    setStatus({
      phase: "waiting-vm",
      progress: 42,
      message: "Waiting for VM",
    });
    await waitForInstance(instanceId);
    state = "RUNNING";
  }

  if (state !== "RUNNING") {
    throw new Error(`TURN VM is ${state}`);
  }

  turnHost = await getInstancePublicIp(instanceId);
  setStatus({
    phase: "waiting-ssh",
    progress: 64,
    message: "Waiting for network",
    host: turnHost,
  });
  await waitForSsh(sshUser, sshKey, turnHost);

  turnUsername =
    envValue("TURN_USERNAME") || envValue("NEXT_PUBLIC_TURN_USERNAME") || "sakura";
  turnCredential =
    envValue("TURN_PASSWORD") || envValue("NEXT_PUBLIC_TURN_CREDENTIAL");

  if (!turnCredential || turnCredential === "change-me") {
    turnCredential = randomSecret();
  }

  setStatus({
    phase: "starting-turn",
    progress: 82,
    message: "Starting relay",
    host: turnHost,
  });

  await run("ssh", [
    "-i",
    sshKey,
    ...sshOptions,
    `${sshUser}@${turnHost}`,
    [
      "sudo",
      "env",
      `TURN_USERNAME=${shellQuote(turnUsername)}`,
      `TURN_PASSWORD=${shellQuote(turnCredential)}`,
      "/opt/sakura-turn/start-turn.sh",
      shellQuote(turnHost),
    ].join(" "),
  ]);

  startedByServer = true;
  return setStatus({
    phase: "ready",
    progress: 100,
    message: "Relay ready",
    host: turnHost,
    urls: [
      `turn:${turnHost}:3478?transport=udp`,
      `turn:${turnHost}:3478?transport=tcp`,
    ],
  });
}

async function stopTurn() {
  if (!startedByServer || !turnHost) {
    return setStatus({
      phase: "idle",
      progress: 0,
      message: "TURN relay is off",
    });
  }

  setStatus({
    phase: "stopping",
    progress: 35,
    message: "Stopping relay",
    host: turnHost,
  });

  const sshUser = envValue("OCI_TURN_SSH_USER");
  const sshKey = envValue("OCI_TURN_SSH_KEY_FILE");
  await run("ssh", [
    "-i",
    sshKey,
    ...sshOptions,
    `${sshUser}@${turnHost}`,
    "sudo /opt/sakura-turn/stop-turn.sh",
  ]).catch(() => "");

  if (envValue("OCI_TURN_STOP_INSTANCE_ON_EXIT") !== "0") {
    setStatus({
      phase: "stopping",
      progress: 72,
      message: "Stopping TURN VM",
      host: turnHost,
    });
    await run("oci", [
      "--config-file",
      await writeOciConfig(),
      "compute",
      "instance",
      "action",
      "--instance-id",
      envValue("OCI_TURN_INSTANCE_ID"),
      "--action",
      "STOP",
    ]).catch(() => "");
  }

  startedByServer = false;
  turnHost = "";
  turnCredential = "";
  return setStatus({
    phase: "idle",
    progress: 0,
    message: "TURN relay is off",
  });
}

export function getTurnStatus() {
  if (!isConfigured() && status.phase === "idle") {
    return {
      ...status,
      phase: "disabled" as const,
      message: "TURN relay is not configured",
    };
  }

  return status;
}

export function startTurnRelay() {
  if (operation) {
    return operation;
  }

  operation = startTurn()
    .catch((error: unknown) =>
      setStatus({
        phase: "error",
        progress: 0,
        message: error instanceof Error ? error.message : "Could not start relay",
        host: turnHost || undefined,
      }),
    )
    .finally(() => {
      operation = null;
    });

  return operation;
}

export function stopTurnRelay() {
  if (operation) {
    return operation;
  }

  operation = stopTurn()
    .catch((error: unknown) =>
      setStatus({
        phase: "error",
        progress: 0,
        message: error instanceof Error ? error.message : "Could not stop relay",
        host: turnHost || undefined,
      }),
    )
    .finally(() => {
      operation = null;
    });

  return operation;
}

export function getActiveTurnIceServer(): RTCIceServer | null {
  if (status.phase !== "ready" || !status.urls || !turnUsername || !turnCredential) {
    return null;
  }

  return {
    urls: status.urls,
    username: turnUsername,
    credential: turnCredential,
  };
}

export async function stopTurnRelayOnExit() {
  if (startedByServer) {
    await stopTurn().catch(() => undefined);
  }
}
