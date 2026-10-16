#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { connect, createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { makeArgReader } from "./lib/args.mjs";
import { resolveOwner as resolveCallerOwner } from "./lib/owner.mjs";
import { assertSdkTarget } from "./lib/sdk-target.mjs";
import { doctorReport } from "./lib/doctor.mjs";
import { adoptionReport, formatAdoption } from "./lib/adoption-check.mjs";
import { leaseStatus, formatTtl } from "./lib/lease-status.mjs";
import { runLeasedChild } from "./lib/run-leased-child.mjs";
import { runKeepAlive } from "./lib/keep-alive.mjs";
import {
  DEFAULT_TTL_MINUTES,
  DEFAULT_WAIT_SECONDS,
  PLATFORMS,
  androidRecoveryDecision,
  assessAndroidDeviceHealth,
  bootableAvdCandidates,
  formatExportLines,
  isExpired,
  isPlatform,
  isEmulatorProps,
  isLocalEmulatorSerial,
  parseAdbDevices,
  parseAndroidBlockingDialog,
  physicalLeaseMarker,
  selectAndroidEmulatorProcess,
  selectLeasableAndroidSerials,
  parseAvdNames,
  parseSimctlIphones,
  planAcquisition,
  resolveLeaseRoot,
  resolveAvdPoolPrefix,
  resolveDeviceCompatPrefix,
  sameAndroidEmulatorProcess,
} from "./lib/device-lease.mjs";
import {
  leasedDeviceFor,
  lockPath as storeLockPath,
  platformDir as storePlatformDir,
  readLeases as storeReadLeases,
} from "./lib/device-lease-store.mjs";

const separatorIndex = process.argv.indexOf("--");
const leaseArgs = separatorIndex === -1 ? process.argv : process.argv.slice(0, separatorIndex);
const { argValue, hasArg } = makeArgReader(leaseArgs);
const command = process.argv[2];
const platformFlag = argValue("--platform", undefined);
const platformArg = platformFlag ?? process.env.MOBILE_DEVICE_PLATFORM;
const expectedToken = argValue("--token", process.env.MOBILE_DEVICE_TOKEN);
for (const flag of ["--device", "--token", "--avd-prefix", "--app-package-prefixes"]) {
  if (hasArg(flag) && (!argValue(flag, undefined) || argValue(flag, undefined).startsWith("--"))) {
    fail(`${flag} requires an explicit value; no lease was changed.`);
  }
}
function numberFlag(flag, fallback, { allowZero }) {
  const raw = argValue(flag, String(fallback));
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    fail(`${flag} must be a ${allowZero ? "non-negative" : "positive"} number, got: ${raw}`);
  }
  return value;
}
const MIN_TTL_MINUTES = 1;
const ttlMinutes = numberFlag("--ttl-minutes", DEFAULT_TTL_MINUTES, { allowZero: false });

if (ttlMinutes < MIN_TTL_MINUTES) {
  fail(
    `--ttl-minutes must be at least ${MIN_TTL_MINUTES}, got: ${ttlMinutes}. ` +
      "A shorter lease can expire between heartbeats while a command is still running.",
  );
}

const ttlMs = ttlMinutes * 60_000;
const waitMs = numberFlag("--wait-seconds", DEFAULT_WAIT_SECONDS, { allowZero: true }) * 1000;
const pollMs = 5000;
const allowBoot = !hasArg("--no-boot");
const allowPhysical = hasArg("--allow-physical");
let avdPoolPrefix, compatPrefix;
try {
  avdPoolPrefix = resolveAvdPoolPrefix(argValue("--avd-prefix", process.env.MOBILE_AVD_POOL_PREFIX));
  compatPrefix = resolveDeviceCompatPrefix(process.env.MOBILE_DEVICE_COMPAT_PREFIX);
} catch (error) { fail(error.message); }


const leaseRoot = resolveLeaseRoot(process.env, homedir());
function log(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message) {
  log(message);
  if (command === "acquire") process.stdout.write("false\n");

  process.exit(1);
}

function output(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout : null;
}

function boundedCommand(cmd, args, { timeout = 15_000 } = {}) {
  return spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  });
}

function boundedOutput(cmd, args, options) {
  const result = boundedCommand(cmd, args, options);
  return result.status === 0 ? result.stdout : null;
}
function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function resolveOwner() {
  const explicit = argValue("--owner", process.env.MOBILE_DEVICE_OWNER);
  if (explicit) return explicit;

  return resolveCallerOwner();
}
const platformDir = (platform) => storePlatformDir(leaseRoot, platform);
const lockPath = (platform, deviceId) => storeLockPath(leaseRoot, platform, deviceId);
const MUTEX_WAIT_MS = 60_000;

function mutexPathFor(platform) {
  return join(platformDir(platform), ".lease-op.sock");
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
function isMutexHeld(socketPath) {
  return new Promise((resolvePromise) => {
    const socket = connect(socketPath);
    const settle = (held) => {
      socket.destroy();
      resolvePromise(held);
    };
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

function tryListen(socketPath) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", (error) => {
      server.close();
      if (error.code === "EADDRINUSE" || error.code === "EEXIST") return resolvePromise(null);
      rejectPromise(error);
    });
    server.listen(socketPath, () => resolvePromise(server));
  });
}

async function withLeaseMutex(platform, fn, active = () => true) {
  if (!active()) return false;
  mkdirSync(platformDir(platform), { recursive: true });
  const socketPath = mutexPathFor(platform);
  const deadline = Date.now() + MUTEX_WAIT_MS;

  let server = null;
  while (!server) {
    if (!active()) return false;
    server = await tryListen(socketPath);
    if (server) break;
    const takeoverDelayMs = Number(process.env.MOBILE_DEVICE_TEST_TAKEOVER_DELAY_MS ?? 0);
    if (takeoverDelayMs > 0) await delay(takeoverDelayMs);

    if (!(await isMutexHeld(socketPath))) {
      const stale = `${socketPath}.stale-${randomUUID()}`;
      try {
        renameSync(socketPath, stale);
        rmSync(stale, { force: true });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the ${platform} lease mutex at ${socketPath}.\n` +
          "Its holder is still running.",
      );
    }
    await delay(50);
  }

  try {
    return active() ? await fn() : false;
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}
function removeLeaseIf(platform, deviceId, predicate) {
  const from = lockPath(platform, deviceId);
  const staging = `${from}.reclaiming-${randomUUID()}`;

  try {
    renameSync(from, staging);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }

  let meta;
  try {
    meta = JSON.parse(readFileSync(join(staging, "meta.json"), "utf8"));
  } catch {
    meta = { deviceId, owner: "unknown", acquiredAt: mtimeIso(staging) };
  }

  if (predicate(meta)) {
    rmSync(staging, { recursive: true, force: true });
    return true;
  }

  try {
    renameSync(staging, from);
  } catch {
    rmSync(staging, { recursive: true, force: true });
  }
  return false;
}

function mtimeIso(lockDir) {
  try {
    return new Date(statSync(lockDir).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function readLeases(platform) {
  return storeReadLeases(leaseRoot, platform).map((lease) => {
    if (lease.acquiredAt !== null || lease.owner !== "unknown") return lease;
    return { ...lease, acquiredAt: mtimeIso(lockPath(platform, lease.deviceId)) };
  });
}

function reclaimExpired(platform, nowMs) {
  const expired = readLeases(platform).filter((lease) => isExpired(lease, nowMs, ttlMs));
  const delayMs = Number(process.env.MOBILE_DEVICE_TEST_RECLAIM_DELAY_MS ?? 0);
  if (delayMs > 0 && expired.length > 0) sleep(delayMs);

  for (const lease of expired) {
    const removed = removeLeaseIf(platform, lease.deviceId, (current) =>
      isExpired(current, Date.now(), ttlMs),
    );

    if (removed) {
      log(`Reclaimed expired ${platform} lease on ${lease.deviceId} (owner ${lease.owner}).`);
    }
  }
}
function claim(platform, deviceId, owner, label) {
  const dir = lockPath(platform, deviceId);
  mkdirSync(platformDir(platform), { recursive: true });

  try {
    mkdirSync(dir);
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  }

  const token = randomUUID();
  const now = Date.now();
  const meta = {
    deviceId,
    owner,
    token,
    label: label ?? null,
    ...physicalLeaseMarker({ allowPhysical, deviceId }),
    acquiredAt: new Date(now).toISOString(),
    claimedAt: new Date(now).toISOString(),
    lastRenewedAt: null,
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  writeFileSync(join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);

  try {
    return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")).token === token ? token : false;
  } catch {
    return false;
  }
}
function dropOtherLeases(platform, owner, keepDeviceId) {
  for (const lease of readLeases(platform)) {
    if (lease.owner !== owner || lease.deviceId === keepDeviceId) continue;
    const removed = removeLeaseIf(
      platform,
      lease.deviceId,
      (current) => current.owner === owner && current.deviceId !== keepDeviceId,
    );

    if (removed) {
      log(`Dropped this worktree's stale ${platform} lease on ${lease.deviceId}.`);
    }
  }
}
function renewLeaseIfOwned(platform, deviceId, owner, label, tokenFence = expectedToken, renewalTtlMs = ttlMs, active = () => true) {
  const renewDelayMs = Number(process.env.MOBILE_DEVICE_TEST_RENEW_DELAY_MS ?? 0);
  if (renewDelayMs > 0) sleep(renewDelayMs);

  const lockDir = lockPath(platform, deviceId);
  const metaFile = join(lockDir, "meta.json");

  let meta;
  try {
    meta = JSON.parse(readFileSync(metaFile, "utf8"));
  } catch {
    return false;
  }

  const now = Date.now();
  if (
    !active() ||
    meta?.owner !== owner ||
    isExpired(meta, now, ttlMs) ||
    (tokenFence && meta.token !== tokenFence)
  )
    return false;

  const renewed = {
    ...meta,
    label: label ?? meta.label ?? null,
    acquiredAt: new Date(now).toISOString(),
    lastRenewedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + renewalTtlMs).toISOString(),
  };
  const stagingFile = `${metaFile}.renewing-${randomUUID()}`;
  writeFileSync(stagingFile, `${JSON.stringify(renewed, null, 2)}\n`);

  try {
    if (!active()) { rmSync(stagingFile, { force: true }); return false; }
    renameSync(stagingFile, metaFile);
  } catch {
    rmSync(stagingFile, { force: true });
    return false;
  }

  return renewed.token;
}

const reportedUnhealthyAndroidDevices = new Set();

function attachedAndroidSerials({ allowPhysical: allow = false } = {}) {
  const stdout = output("adb", ["devices"]);
  if (stdout === null)
    fail("adb is unavailable. Install Android platform-tools and put adb on PATH.");

  const { leasable, rejected } = selectLeasableAndroidSerials(
    parseAdbDevices(stdout),
    androidDeviceProps,
    { allowPhysical: allow },
  );

  if (leasable.length === 0 && rejected.length > 0) {
    fail(
      `No emulator attached. ${rejected.length} physical device(s) are connected and deliberately not leasable ` +
        `(${rejected.join(", ")}) — installing a debug build over a real app is not something this pool does.\n` +
        "Start one with `pnpm android:avds`, or pass --allow-physical if you genuinely mean to use hardware.",
    );
  }

  return leasable;
}

function androidDeviceHealth(serial) {
  return assessAndroidDeviceHealth({
    bootCompleted: output("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]),
    packagePath: output("adb", ["-s", serial, "shell", "pm", "path", "android"]),
  });
}

function androidRuntimeProbe(serial) {
  const boot = boundedCommand("adb", ["-s", serial, "shell", "getprop", "sys.boot_completed"]);
  const packages = boundedCommand("adb", ["-s", serial, "shell", "pm", "path", "android"]);
  const windows = boundedCommand("adb", ["-s", serial, "shell", "dumpsys", "window", "windows"]);
  return {
    health: assessAndroidDeviceHealth({
      bootCompleted: boot.status === 0 ? boot.stdout : null,
      packagePath: packages.status === 0 ? packages.stdout : null,
    }),
    windowProbeSucceeded: windows.status === 0,
    blockingDialog:
      windows.status === 0 ? parseAndroidBlockingDialog({ windowDump: windows.stdout }) : null,
  };
}

function androidEmulator(serial) {
  return isLocalEmulatorSerial(serial) || isEmulatorProps(androidDeviceProps(serial));
}

function waitForAndroidRuntime(serial) {
  const testPollMs = Number(process.env.MOBILE_DEVICE_TEST_RECOVERY_POLL_MS ?? 0);
  const pollMs = testPollMs > 0 ? testPollMs : 3000;
  const testTimeoutMs = Number(process.env.MOBILE_DEVICE_TEST_RECOVERY_TIMEOUT_MS ?? 0);
  const deadline = Date.now() + (testTimeoutMs > 0 ? testTimeoutMs : 180_000);

  while (Date.now() < deadline) {
    const probe = androidRuntimeProbe(serial);
    if (probe.health.healthy && probe.windowProbeSucceeded && !probe.blockingDialog) return true;
    sleep(pollMs);
  }
  return false;
}

function emulatorProcessForSerial(serial) {
  const port = /^emulator-(\d+)$/.exec(serial)?.[1];
  if (!port) return null;

  const listenerPids = String(
    boundedOutput("lsof", ["-n", "-P", "-t", `-iTCP:${port}`, "-sTCP:LISTEN"]) ?? "",
  )
    .split(/\s+/)
    .filter(Boolean);
  const processCommands = Object.fromEntries(
    listenerPids.map((pid) => [
      pid,
      boundedOutput("ps", ["-p", pid, "-o", "command="])?.trim() ?? "",
    ]),
  );
  const processExecutables = Object.fromEntries(
    listenerPids.map((pid) => [pid, boundedOutput("ps", ["-p", pid, "-o", "comm="])?.trim() ?? ""]),
  );
  const processStartTimes = Object.fromEntries(
    listenerPids.map((pid) => [
      pid,
      boundedOutput("ps", ["-p", pid, "-o", "lstart="])?.trim() ?? "",
    ]),
  );
  const binary = emulatorBinary();

  return selectAndroidEmulatorProcess({
    serial,
    listenerPids,
    processCommands,
    processExecutables,
    processStartTimes,
    canonicalEmulatorDir: binary === "emulator" ? null : dirname(binary),
    availableAvdNames: avdNames(),
  });
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    sleep(250);
  }
  return !processExists(pid);
}

function rebootAndroidEmulator(serial, reason) {
  log(`Restarting leased Android emulator ${serial}: ${reason}.`);
  const testRestart = process.env.MOBILE_DEVICE_TEST_HOST_RESTART;
  if (testRestart) {
    writeFileSync(testRestart, "restarted\n");
  } else {
    const target = emulatorProcessForSerial(serial);
    if (!target) {
      fail(
        `Could not prove which host emulator process owns ${serial}; refusing to signal any process.`,
      );
    }

    const beforeTerm = emulatorProcessForSerial(serial);
    if (!sameAndroidEmulatorProcess(target, beforeTerm)) {
      fail(
        `The proven host process for ${serial} changed before SIGTERM; refusing to signal a stale PID.`,
      );
    }

    try {
      process.kill(target.pid, "SIGTERM");
    } catch (error) {
      fail(`Could not stop leased Android emulator ${serial}: ${error.message}`);
    }

    if (!waitForProcessExit(target.pid, 10_000)) {
      const beforeKill = emulatorProcessForSerial(serial);
      if (!sameAndroidEmulatorProcess(target, beforeKill)) {
        fail(
          `The proven host process or console-port owner for ${serial} changed before SIGKILL; refusing to signal a stale PID.`,
        );
      }
      try {
        process.kill(target.pid, "SIGKILL");
      } catch (error) {
        fail(`Could not force-stop leased Android emulator ${serial}: ${error.message}`);
      }
      if (!waitForProcessExit(target.pid, 5000)) {
        fail(`Leased Android emulator process ${target.pid} did not exit.`);
      }
    }

    const emulatorProcess = spawn(
      emulatorBinary(),
      ["-avd", target.avdName, "-port", String(target.port), "-no-snapshot-save", "-no-boot-anim"],
      { detached: true, stdio: "ignore" },
    );
    emulatorProcess.on("error", (error) => {
      log(`Could not relaunch leased Android emulator ${serial}: ${error.message}`);
    });
    emulatorProcess.unref();
  }

  if (!waitForAndroidRuntime(serial)) {
    fail(
      `Leased Android emulator ${serial} did not become healthy within 180 seconds after one restart.\n` +
        "Recovery stopped after its bounded attempt; release this lease and acquire a spare emulator.",
    );
  }
  log(`Leased Android emulator ${serial} is healthy after restart.`);
  return "restarted";
}

function failAndroidWindowProbe(serial) {
  fail(
    `Recovery could not inspect the focused Android window on reachable emulator ${serial}.\n` +
      "Refusing to dismiss or restart anything because a application crash or ANR may be in front.",
  );
}

function recoverAndroid(serial, { forceReboot = false } = {}) {
  const appPackages = String(argValue("--app-packages", process.env.MOBILE_APP_PACKAGES ?? ""))
    .split(",").map((value) => value.trim()).filter(Boolean);
  const appPackagePrefixes = String(argValue("--app-package-prefixes", process.env.MOBILE_APP_PACKAGE_PREFIXES ?? ""))
    .split(",").map((value) => value.trim()).filter(Boolean);
  if ([...appPackages, ...appPackagePrefixes].some((value) => !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value))) {
    fail("--app-packages / MOBILE_APP_PACKAGES and application package prefixes must contain comma-separated Android package IDs.");
  }
  let probe = androidRuntimeProbe(serial);
  let decision = androidRecoveryDecision({
    appPackages,
    appPackagePrefixes,
    ...probe,
    emulator: androidEmulator(serial),
    forceReboot,
  });

  if (decision.action === "healthy") {
    log(`Leased Android emulator ${serial} is healthy; no restart needed.`);
    return "unchanged";
  }
  if (decision.action === "fail-window-probe") {
    failAndroidWindowProbe(serial);
  }
  if (decision.action === "refuse-hardware") {
    fail(
      `Refusing to restart ${serial}: automatic device recovery is emulator-only and never reboots physical hardware.`,
    );
  }
  if (decision.action === "fail-app") {
    fail(
      `The application is ${probe.blockingDialog?.kind === "crash" ? "crashing" : "not responding"} on ${serial} (${decision.packageName}).\n` +
        "This is app evidence, not emulator dirt, so automatic recovery stopped without dismissing it.\n" +
        "Inspect it with: device-lease exec --platform android -- adb shell dumpsys activity lastanr",
    );
  }
  if (decision.action === "fail-unknown-app") {
    fail(
      `An Android app failure dialog is blocking ${serial}, but its package could not be identified or application packages were not configured.\n` +
        "Recovery stopped to preserve application evidence. Configure --app-packages or MOBILE_APP_PACKAGES.\n" +
        "Inspect it with: device-lease exec --platform android -- adb shell dumpsys window windows",
    );
  }

  if (decision.action === "clear-system-dialog") {
    log(
      `Clearing blocking ${probe.blockingDialog?.kind ?? "system"} dialog from ${decision.packageName} on ${serial}.`,
    );
    const stopped = boundedCommand("adb", [
      "-s",
      serial,
      "shell",
      "am",
      "force-stop",
      decision.packageName,
    ]);
    if (stopped.status === 0) {
      boundedCommand("adb", ["-s", serial, "shell", "input", "keyevent", "KEYCODE_HOME"]);
      const testPollMs = Number(process.env.MOBILE_DEVICE_TEST_RECOVERY_POLL_MS ?? 0);
      sleep(testPollMs > 0 ? testPollMs : 2000);
      probe = androidRuntimeProbe(serial);
      decision = androidRecoveryDecision({
        appPackages,
        appPackagePrefixes,
        ...probe,
        emulator: true,
      });
      if (decision.action === "healthy") {
        log(`Blocking system dialog cleared on leased Android emulator ${serial}.`);
        return "cleared-dialog";
      }
      if (decision.action === "fail-window-probe") {
        failAndroidWindowProbe(serial);
      }
      if (decision.action === "fail-app") {
        fail(
          `The application surfaced its own ${probe.blockingDialog?.kind ?? "failure"} after the system dialog cleared; preserving it for diagnosis.`,
        );
      }
      if (decision.action === "fail-unknown-app") {
        fail(
          "Another app failure dialog surfaced after the system dialog cleared, but its package could not be identified; preserving it instead of rebooting.",
        );
      }
    }
    decision = {
      action: "reboot",
      reason: `the ${decision.packageName ?? "system"} dialog did not clear`,
    };
  }

  return rebootAndroidEmulator(serial, decision.reason ?? "runtime recovery requested");
}

function iosSimulatorState(deviceId) {
  const json = boundedOutput("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  return parseSimctlIphones(json, "all").find((device) => device.udid === deviceId)?.state ?? null;
}

function iosSimulatorHealthy(deviceId, state) {
  if (state === "Shutdown") return true;
  if (state !== "Booted") return false;
  return (
    boundedCommand("xcrun", ["simctl", "bootstatus", deviceId, "-b"], { timeout: 30_000 })
      .status === 0
  );
}

function waitForIosState(deviceId, expectedState) {
  const testPollMs = Number(process.env.MOBILE_DEVICE_TEST_IOS_SETTLE_POLL_MS ?? 0);
  const pollMs = testPollMs > 0 ? testPollMs : 250;
  const testTimeoutMs = Number(process.env.MOBILE_DEVICE_TEST_IOS_SETTLE_TIMEOUT_MS ?? 0);
  const deadline = Date.now() + (testTimeoutMs > 0 ? testTimeoutMs : 30_000);

  while (Date.now() < deadline) {
    if (iosSimulatorState(deviceId) === expectedState) return true;
    sleep(pollMs);
  }
  return iosSimulatorState(deviceId) === expectedState;
}

function recoverIos(deviceId, { forceReboot = false } = {}) {
  const state = iosSimulatorState(deviceId);
  if (state === null) {
    fail(
      `Could not resolve leased iOS simulator ${deviceId} in the available-device list; refusing to target any simulator.`,
    );
  }
  if (!forceReboot && iosSimulatorHealthy(deviceId, state)) {
    log(
      state === "Shutdown"
        ? `Leased iOS simulator ${deviceId} is available and will boot on demand.`
        : `Leased iOS simulator ${deviceId} is healthy; no restart needed.`,
    );
    return "unchanged";
  }

  log(`Restarting leased iOS simulator ${deviceId}.`);
  if (state !== "Shutdown") {
    const shutdown = boundedCommand("xcrun", ["simctl", "shutdown", deviceId], {
      timeout: 30_000,
    });
    if (!waitForIosState(deviceId, "Shutdown")) {
      fail(
        `Leased iOS simulator ${deviceId} did not settle to Shutdown within 30 seconds from ${state}` +
          `${shutdown.status === 0 ? "" : " after simctl shutdown failed"}; ` +
          "refusing to issue boot against a transitional state.",
      );
    }
  }
  const boot = boundedCommand("xcrun", ["simctl", "boot", deviceId], { timeout: 30_000 });
  if (boot.status !== 0) fail(`Could not boot leased iOS simulator ${deviceId}.`);
  const ready = boundedCommand("xcrun", ["simctl", "bootstatus", deviceId, "-b"], {
    timeout: 180_000,
  });
  if (ready.status !== 0) {
    fail(
      `Leased iOS simulator ${deviceId} did not become healthy within 180 seconds after one restart.\n` +
        "Recovery stopped after its bounded attempt; release this lease and acquire a spare simulator.",
    );
  }
  log(`Leased iOS simulator ${deviceId} is healthy after restart.`);
  return "restarted";
}

function androidSerials(options = {}) {
  return attachedAndroidSerials(options).filter((serial) => {
    const health = androidDeviceHealth(serial);
    if (health.healthy) {
      reportedUnhealthyAndroidDevices.delete(serial);
      return true;
    }

    if (!reportedUnhealthyAndroidDevices.has(serial)) {
      log(`Skipping unhealthy Android device ${serial}: ${health.reason}.`);
      reportedUnhealthyAndroidDevices.add(serial);
    }
    return false;
  });
}
function androidDeviceProps(serial) {
  return {
    kernelQemu: output("adb", ["-s", serial, "shell", "getprop", "ro.kernel.qemu"])?.trim(),
    characteristics: output("adb", [
      "-s",
      serial,
      "shell",
      "getprop",
      "ro.build.characteristics",
    ])?.trim(),
  };
}

function emulatorBinary() {
  const sdk =
    process.env.ANDROID_SDK_ROOT ||
    process.env.ANDROID_HOME ||
    join(homedir(), "Library/Android/sdk");
  const candidate = join(sdk, "emulator/emulator");
  return existsSync(candidate) ? candidate : "emulator";
}

function avdNames() {
  return parseAvdNames(output(emulatorBinary(), ["-list-avds"]));
}

function bootedAvdNames(serials) {
  return new Set(
    serials
      .map((serial) =>
        output("adb", ["-s", serial, "emu", "avd", "name"])?.split(/\r?\n/)[0]?.trim(),
      )
      .filter(Boolean),
  );
}
function bootSpareAvd() {
  const before = attachedAndroidSerials({ allowPhysical: true });
  const running = bootedAvdNames(before);
  const spare = bootableAvdCandidates(avdNames(), running, avdPoolPrefix)[0];
  if (!spare) return null;

  log(`Booting spare AVD "${spare}" to widen the pool.`);
  const emulatorProcess = spawn(
    emulatorBinary(),
    ["-avd", spare, "-no-snapshot-save", "-no-boot-anim"],
    { detached: true, stdio: "ignore" },
  );
  emulatorProcess.on("error", (error) => {
    log(`Could not start the emulator binary: ${error.message}`);
  });
  emulatorProcess.unref();

  const deadline = Date.now() + 180_000;
  const known = new Set(before);
  while (Date.now() < deadline) {
    sleep(3000);
    const fresh = attachedAndroidSerials({ allowPhysical: true }).find(
      (serial) => !known.has(serial),
    );
    if (!fresh) continue;
    spawnSync("adb", ["-s", fresh, "wait-for-device"], {
      stdio: "ignore",
      timeout: Math.max(1000, deadline - Date.now()),
    });
    while (Date.now() < deadline) {
      if (androidDeviceHealth(fresh).healthy) {
        log(`AVD "${spare}" is booted as ${fresh}.`);
        return fresh;
      }
      sleep(3000);
    }
  }

  log(`AVD "${spare}" did not finish booting in time; continuing with the attached pool.`);
  return null;
}

function capacity(platform) {
  const injected = process.env.MOBILE_DEVICE_FAKE_CAPACITY;
  if (injected) {
    return injected
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id, name: id }));
  }

  if (platform === "android") {
    return androidSerials({ allowPhysical }).map((serial) => ({ id: serial, name: serial }));
  }

  const json = output("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  if (json === null) fail("xcrun simctl is unavailable. Install Xcode command line tools.");
  return parseSimctlIphones(json, argValue("--ios-family", "iphone")).map((device) => ({
    id: device.udid,
    name: device.name,
  }));
}

function requirePlatform() {
  if (!isPlatform(platformArg)) {
    fail(`--platform must be one of: ${PLATFORMS.join(", ")}`);
  }
  return platformArg;
}

async function acquire() {
  const platform = requirePlatform();
  const owner = resolveOwner();
  const label = argValue("--label", undefined);
  const deadline = Date.now() + waitMs;

  let announcedWait = false;
  let lostRaces = 0;

  for (;;) {
    const pool = capacity(platform);
    const outcome = await withLeaseMutex(platform, () => {
      const nowMs = Date.now();
      reclaimExpired(platform, nowMs);
      if (
        hasArg("--exclusive") &&
        readLeases(platform).some(
          (lease) => lease.owner === owner && !isExpired(lease, nowMs, ttlMs),
        )
      ) {
        return { kind: "owned" };
      }

      const plan = planAcquisition({
        capacityIds: pool.map((device) => device.id),
        leases: readLeases(platform),
        owner,
        nowMs,
        ttlMs,
        requestedDeviceId: argValue("--device", undefined),
      });

      if (plan.action === "mismatch" || plan.action === "unavailable") {
        return { kind: plan.action };
      }

      if (plan.action === "reuse") {
        const token = renewLeaseIfOwned(platform, plan.deviceId, owner, label);
        if (!token) {
          return { kind: "lost" };
        }
        dropOtherLeases(platform, owner, plan.deviceId);
        return { kind: "reused", deviceId: plan.deviceId, token };
      }

      if (plan.action === "claim") {
        const token = claim(platform, plan.deviceId, owner, label);
        if (!token) return { kind: "lost" };
        dropOtherLeases(platform, owner, plan.deviceId);

        return { kind: "claimed", deviceId: plan.deviceId, token };
      }

      return { kind: "wait", blockedBy: plan.blockedBy ?? [] };
    });

    if (outcome.kind === "mismatch" || outcome.kind === "unavailable" || outcome.kind === "owned") {
      fail(`Requested ${platform} device is ${outcome.kind}; no device lease was replaced.`);
    }

    if (outcome.kind === "reused") {
      log(`Reusing ${platform} device ${outcome.deviceId} already leased to this worktree.`);
      return emit(platform, outcome.deviceId, pool, outcome.token);
    }

    if (outcome.kind === "claimed") {
      log(`Leased ${platform} device ${outcome.deviceId} to ${owner}.`);
      return emit(platform, outcome.deviceId, pool, outcome.token);
    }
    if (outcome.kind === "lost" && lostRaces < pool.length) {
      lostRaces += 1;
      continue;
    }

    if (outcome.kind === "wait" && platform === "android" && allowBoot) {
      const booted = bootSpareAvd();
      if (booted) continue;
    }

    if (Date.now() >= deadline) {
      fail(
        `No free ${platform} device after ${Math.round(waitMs / 1000)}s. ` +
          `Held by: ${(outcome.blockedBy ?? []).join(", ") || "unknown"}. ` +
          `Run \`device-lease list\` to inspect, or provision more capacity ` +
          `(\`pnpm android:avds\` for Android).`,
      );
    }

    if (!announcedWait) {
      log(`All ${platform} devices are leased by other worktrees. Waiting for one to free up…`);
      announcedWait = true;
    }
    sleep(pollMs);
  }
}

function emit(platform, deviceId, pool, token) {
  const emitDelayMs = Number(process.env.MOBILE_DEVICE_TEST_EMIT_DELAY_MS ?? 0);
  if (emitDelayMs > 0) sleep(emitDelayMs);
  const name = pool.find((device) => device.id === deviceId)?.name;
  const lines = formatExportLines({ platform, deviceId, name, token, compatPrefix });
  if (hasArg("--json")) {
    process.stdout.write(`${JSON.stringify({ platform, deviceId, token, owner: resolveOwner() })}\n`);
  } else {
    process.stdout.write(`${lines.map((line) => `export ${line}`).join("\n")}\n`);
  }
}

async function release() {
  const owner = resolveOwner();
  if (platformFlag !== undefined && !isPlatform(platformFlag)) {
    fail(`--platform must be one of: ${PLATFORMS.join(", ")}`);
  }

  const platforms = platformFlag === undefined ? PLATFORMS : [platformFlag];
  let released = 0;

  for (const platform of platforms) {
    released += await withLeaseMutex(platform, () => {
      let count = 0;
      const force = hasArg("--force");

      for (const lease of readLeases(platform)) {
        if (lease.owner !== owner && !force) continue;
        if (expectedToken && lease.token !== expectedToken) continue;
        const removed = removeLeaseIf(
          platform,
          lease.deviceId,
          (current) =>
            (force || current.owner === owner) &&
            (!expectedToken || current.token === expectedToken),
        );

        if (!removed) continue;

        log(`Released ${platform} device ${lease.deviceId}.`);
        count += 1;
      }
      return count;
    });
  }

  if (released === 0 && expectedToken)
    fail("No matching acquisition token to release; successor lease preserved.");
  if (released === 0) log("No matching lease to release.");
}
async function execWithLease() {
  const platform = requirePlatform();
  const separator = process.argv.indexOf("--");
  const argv = separator === -1 ? [] : process.argv.slice(separator + 1);

  if (argv.length === 0) {
    fail("Usage: device-lease exec --platform <android|ios> -- <command> [args…]");
  }

  const owner = resolveOwner();
  const deviceId = leasedDeviceFor({
    leaseRoot,
    platform,
    owner,
    nowMs: Date.now(),
    fallbackTtlMs: ttlMs,
  });

  if (!deviceId) {
    fail(
      `This worktree holds no ${platform} lease. Acquire one first:\n` +
        `  device-lease acquire --platform ${platform}`,
    );
  }
  const capturedDevice = argValue("--device", undefined);
  if (capturedDevice && capturedDevice !== deviceId) {
    fail(`The captured device ${capturedDevice} does not match this owner's leased device ${deviceId}; command not started.`);
  }
  const renewed = await withLeaseMutex(platform, () =>
    renewLeaseIfOwned(platform, deviceId, owner, argValue("--label", undefined)),
  );

  if (!renewed) {
    fail(
      `This worktree's ${platform} lease on ${deviceId} is no longer valid.\n` +
        `  device-lease acquire --platform ${platform}`,
    );
  }

  const env = { ...process.env };
  env.MOBILE_DEVICE_OWNER = owner;
  env.MOBILE_DEVICE_TTL_MINUTES = String(ttlMinutes);
  env.MOBILE_DEVICE_ADAPTER_MODULE = new URL("./lib/adapter.mjs", import.meta.url).href;
  for (const line of formatExportLines({ platform, deviceId, token: renewed, compatPrefix })) {
    const index = line.indexOf("=");
    env[line.slice(0, index)] = line
      .slice(index + 1)
      .replace(/^'|'$/g, "")
      .replaceAll(`'\\''`, "'");
  }
  const placeholder = new RegExp(`(?<![A-Za-z0-9_])(?:${["MOBILE_DEVICE", compatPrefix].filter(Boolean).join("|")})(?![A-Za-z0-9_])`, "g");
  const substituted = argv.map((arg) => arg.replace(placeholder, deviceId));
  if (substituted.some((arg) => arg === "booted")) {
    fail(
      "Refusing to run a `booted` device operand under a lease: it resolves to " +
        "whichever device is booted, which may be another worktree's.\n" +
        `Use the MOBILE_DEVICE placeholder instead, which expands to ${deviceId}:\n` +
        "  device:lease exec --platform ios -- xcrun simctl io MOBILE_DEVICE screenshot shot.png",
    );
  }
  assertSdkTarget(substituted, { platform, deviceId });
  const metaFile = join(lockPath(platform, deviceId), "meta.json");
  const { code, lost } = await runLeasedChild(substituted, {
    env,
    heartbeatMs: Math.floor(ttlMs / 4),
    ownsLease: () => {
      const meta = JSON.parse(readFileSync(metaFile, "utf8"));
      return meta?.owner === owner && meta.deviceId === deviceId && meta.token === renewed &&
        Number.isFinite(Date.parse(meta.expiresAt)) && Date.parse(meta.expiresAt) > Date.now();
    },
    renewLease: (active) => withLeaseMutex(platform, () =>
      active() ? renewLeaseIfOwned(platform, deviceId, owner, null, renewed) : false,
    ),
  });

  if (lost) {
    fail(
      `This worktree's ${platform} lease on ${deviceId} was lost while the command ran, ` +
        "so its command process group was stopped and its result rejected. Re-acquire and rerun.",
    );
  }

  process.exit(code);
}
async function renewCommand() {
  const platform = requirePlatform();
  const owner = resolveOwner();

  const deviceId = leasedDeviceFor({
    leaseRoot,
    platform,
    owner,
    nowMs: Date.now(),
    fallbackTtlMs: ttlMs,
  });

  if (!deviceId) fail(`This worktree holds no live ${platform} lease.`);

  const renewed = await withLeaseMutex(platform, () =>
    renewLeaseIfOwned(platform, deviceId, owner, null),
  );

  if (!renewed) fail(`This worktree's ${platform} lease on ${deviceId} is no longer valid.`);

  process.stdout.write(`${deviceId}\n`);
}
async function keepAliveCommand() {
  const flags = new Set(["--platform", "--owner", "--device", "--token", "--ttl-minutes", "--duration-minutes", "--json"]);
  const seen = new Set();
  for (let index = 3; index < leaseArgs.length; index++) {
    const flag = leaseArgs[index];
    if (!flags.has(flag) || seen.has(flag)) fail(`Unsupported or duplicate keep-alive option: ${flag}`);
    seen.add(flag);
    if (flag !== "--json" && (!leaseArgs[++index] || leaseArgs[index].startsWith("--"))) fail(`${flag} requires an explicit value.`);
  }
  if (separatorIndex !== -1) fail("keep-alive does not run a child command.");
  if (!expectedToken) fail("keep-alive requires a captured --token (or MOBILE_DEVICE_TOKEN); acquire a lease first.");
  const durationMinutes = numberFlag("--duration-minutes", 60, { allowZero: false });
  if (durationMinutes > 1440) fail("--duration-minutes must be no more than 1440 (24 hours).");
  const platform = requirePlatform();
  const owner = resolveOwner();
  const deviceId = leasedDeviceFor({ leaseRoot, platform, owner, nowMs: Date.now(), fallbackTtlMs: ttlMs });
  if (!deviceId) fail(`This worktree holds no live ${platform} lease; keep-alive never acquires one.`);
  if (hasArg("--device") && argValue("--device") !== deviceId) fail("Captured device does not match the leased device; no renewal started.");
  const readLease = () => {
    try {
      const meta = JSON.parse(readFileSync(join(lockPath(platform, deviceId), "meta.json"), "utf8"));
      return meta?.owner === owner && meta.deviceId === deviceId && meta.token === expectedToken &&
        Number.isFinite(Date.parse(meta.expiresAt)) && Date.parse(meta.expiresAt) > Date.now() ? meta : null;
    } catch { return null; }
  };
  const captured = readLease();
  if (!captured) fail("Captured ownership is no longer valid; no renewal started.");
  // Existing records stamp acquiredAt on each renewal. Preserve their TTL when
  // no override was supplied; do not silently reset a custom session to 4 hours.
  const renewalTtlMs = hasArg("--ttl-minutes") ? ttlMs : Date.parse(captured.expiresAt) - Date.parse(captured.acquiredAt);
  if (!Number.isFinite(renewalTtlMs) || renewalTtlMs < 60000 || !Number.isFinite(Date.now() + renewalTtlMs) || Date.now() + renewalTtlMs > 8.64e15) {
    fail("Cannot infer a valid lease TTL; supply --ttl-minutes explicitly. No renewal started.");
  }
  const code = await runKeepAlive({
    durationMs: durationMinutes * 60000, heartbeatMs: Math.min(Math.floor(renewalTtlMs / 4), 86400000),
    identity: { platform, deviceId, owner }, readLease,
    renewLease: active => withLeaseMutex(platform, () => {
      if (!active() || !readLease()) return false;
      return renewLeaseIfOwned(platform, deviceId, owner, null, expectedToken, renewalTtlMs, active);
    }, active),
    onEvent: event => {
      if (hasArg("--json")) process.stdout.write(`${JSON.stringify(event)}\n`);
      else log(`Keep-alive ${event.event}: pid=${event.pid} ${platform}=${deviceId} renewal-ends=${event.renewalEndsAt} lease-expires=${event.expiresAt ?? "unverified"}${event.reason ? ` reason=${event.reason}` : ""}${event.detail ? ` (${event.detail})` : ""}`);
    },
  });
  process.exitCode = code;
}
async function recoverCommand() {
  const platform = requirePlatform();
  const owner = resolveOwner();
  const deviceId = leasedDeviceFor({
    leaseRoot,
    platform,
    owner,
    nowMs: Date.now(),
    fallbackTtlMs: ttlMs,
  });

  if (!deviceId) {
    fail(
      `This worktree holds no live ${platform} lease. Acquire one before recovery:\n` +
        `  device-lease acquire --platform ${platform}`,
    );
  }

  const outcome = await withLeaseMutex(platform, () => {
    const renewed = renewLeaseIfOwned(platform, deviceId, owner, argValue("--label", undefined));
    if (!renewed) {
      fail(
        `This worktree's ${platform} lease on ${deviceId} was lost before recovery. Re-acquire instead of touching that device.`,
      );
    }

    const options = { forceReboot: hasArg("--reboot") };
    return platform === "android"
      ? recoverAndroid(deviceId, options)
      : recoverIos(deviceId, options);
  });

  process.stdout.write(`${outcome}\n`);
}

function list() {
  const report = leaseStatus({ leaseRoot, platforms: platformArg ? [requirePlatform()] : PLATFORMS, fallbackTtlMs: ttlMs });
  if (hasArg("--json")) { process.stdout.write(`${JSON.stringify(report)}\n`); return; }
  for (const platform of Object.keys(report.observations)) {
    const leases = report.leases.filter(lease => lease.platform === platform);
    log(`\n${platform}:`);
    if (leases.length === 0) {
      log("  (no leases)");
      continue;
    }
    for (const lease of leases) {
      const state = lease.expired ? " EXPIRED" : "";
      const renewal = lease.lastRenewedAt ?? (lease.renewalKnown ? "not-yet" : "unknown-legacy");
      log(`  ${lease.deviceId}${state}  ttl=${formatTtl(lease.remainingTtlSeconds)}  last-renewed=${renewal}  device=${lease.deviceState.state ?? lease.deviceState.availability}  owner=${lease.owner}  expires=${lease.expiresAt ?? "unknown"}`);
    }
    if (!report.observations[platform].ok) log(`  State query unavailable: ${report.observations[platform].detail}`);
  }
  log("Device shutdown or absence does not end a valid lease; ownership and expiry remain authoritative.");
}
try {
  switch (command) {
    case "acquire":
      await acquire();
      break;
    case "release":
      await release();
      break;
    case "exec":
      await execWithLease();
      break;
    case "renew":
      await renewCommand();
      break;
    case "keep-alive":
      await keepAliveCommand();
      break;
    case "recover":
      await recoverCommand();
      break;
    case "list":
      list();
      break;
    case "doctor": {
      const report = doctorReport({ platform: requirePlatform(), leaseRoot, owner: resolveOwner(), avdPoolPrefix, iosFamily: argValue("--ios-family", "iphone") });
      if (hasArg("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
      else {
        log(`Registry: ${report.registry}\nOwner: ${report.owner}\nPlatform: ${report.platform}`);
        for (const check of report.checks) log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
        log(`Capacity: ${JSON.stringify(report.capacity)}`);
      }
      process.exitCode = report.ok ? 0 : 1;
      break;
    }
    case "adoption-check": {
      for (const flag of ["--scope", "--config"]) {
        if (hasArg(flag) && (!argValue(flag) || argValue(flag).startsWith("--"))) fail(`${flag} requires an explicit value.`);
      }
      const report = adoptionReport({ scope: argValue("--scope"), configPath: argValue("--config"), leaseRoot, owner: resolveOwner(), avdPoolPrefix });
      if (hasArg("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
      else log(formatAdoption(report));
      process.exitCode = report.ok ? 0 : 1;
      break;
    }
    default:
      fail(
        "Usage: device-lease <acquire|release|exec|renew|keep-alive|recover|list|doctor|adoption-check> " +
          "[--platform android|ios]\n" +
          "  acquire  claim a device for this worktree and print shell exports\n" +
          "  release  drop this worktree's lease(s)\n" +
          "  exec     run a command with this worktree's lease in its environment\n" +
          "  renew    push this worktree's lease expiry out and print the device\n" +
          "  keep-alive  renew a captured lease for a bounded manual session\n" +
          "  recover  clear a system failure or restart only this worktree's leased virtual device\n" +
          "  list     show lease TTL, last renewal, device state and owner (or --json)\n" +
          "  doctor   check SDK prerequisites, registry and visible capacity without claiming\n" +
          "  adoption-check --scope personal|project   inspect installation, instructions and launchers",
      );
  }
} catch (error) {
  fail(`device-lease ${command ?? ""} failed: ${error?.message ?? error}`);
}
