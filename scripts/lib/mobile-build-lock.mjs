import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_MOBILE_BUILD_WAIT_MS = 15 * 60 * 1000;
export const DEFAULT_MOBILE_BUILD_LOCK_PORT = 46_781;

export function resolveMobileBuildLockPath(env = process.env, homeDir = homedir()) {
  const stateRoot = env.XDG_STATE_HOME || join(homeDir, ".local/state");
  return env.MOBILE_BUILD_LOCK || join(stateRoot, "shared-mobile/mobile-preview-build.lock");
}

export function resolveMobileBuildLockPort(env = process.env) {
  const raw = env.MOBILE_BUILD_LOCK_PORT ?? String(DEFAULT_MOBILE_BUILD_LOCK_PORT);
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`MOBILE_BUILD_LOCK_PORT must be an integer from 1 to 65535, got: ${raw}`);
  }
  return port;
}

function readMetadata(lockPath) {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return null;
  }
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isPortHeld(host, port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    let settled = false;
    const settle = (held) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(held);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function tryListen(host, port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        resolvePromise(null);
        return;
      }
      rejectPromise(error);
    });
    server.listen({ host, port, exclusive: true }, () => resolvePromise(server));
  });
}

async function closeServer(server) {
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

export async function acquireMobileBuildLock({
  label,
  owner,
  env = process.env,
  lockPath = resolveMobileBuildLockPath(env),
  host = "127.0.0.1",
  port = resolveMobileBuildLockPort(env),
  waitMs = DEFAULT_MOBILE_BUILD_WAIT_MS,
  pid = process.pid,
  now = () => Date.now(),
} = {}) {
  if (env.MOBILE_BUILD_LOCK_DISABLED === "1") return async () => {};

  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = now() + waitMs;
  let announced = false;
  let server = null;

  while (!server) {
    server = await tryListen(host, port);
    if (server) break;
    if (!(await isPortHeld(host, port))) continue;

    const holder = readMetadata(lockPath);
    if (now() >= deadline) {
      throw new Error(
        `Timed out waiting for the mobile preview build slot on ${host}:${port}` +
          `${holder?.pid ? ` held by PID ${holder.pid}` : ""}` +
          `${holder?.label ? ` (${holder.label})` : ""}.`,
      );
    }

    if (!announced) {
      process.stdout.write(
        `Another mobile preview build is running${holder?.label ? ` (${holder.label})` : ""}; ` +
          "waiting so emulators are not starved.\n",
      );
      announced = true;
    }
    await delay(Math.min(1000, Math.max(1, deadline - now())));
  }

  const boundPort = server.address().port;
  const token = randomUUID();
  try {
    writeFileSync(
      lockPath,
      `${JSON.stringify({ token, pid, owner, label, host, port: boundPort, acquiredAt: new Date(now()).toISOString() }, null, 2)}\n`,
    );
  } catch (error) {
    await closeServer(server);
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await closeServer(server);
    const current = readMetadata(lockPath);
    if (current?.token === token) rmSync(lockPath, { force: true });
  };
}

export function describeMobileBuildLock(lockPath = resolveMobileBuildLockPath()) {
  if (!existsSync(lockPath)) return null;
  return readMetadata(lockPath);
}
