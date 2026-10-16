#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { arch, homedir, platform as hostPlatform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLeaseRoot } from "./lib/device-lease.mjs";
import { smokeCommand } from "./lib/smoke-command.mjs";

const cli = fileURLToPath(new URL("./device-lease.mjs", import.meta.url));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const report = { ok: false, installedVersion: version, validationMode: "unselected", liveSdkValidated: false,
  host: { platform: hostPlatform(), release: release(), arch: arch(), node: process.version }, sdk: {}, checks: [], cleanup: "not-needed" };
const controller = new AbortController();
let signalCode = 0, deadlineTimer, root, env, device, platform, registry, deadline, originalLeases, originalDevices;
const captured = new Map();
let lossRun, uncertainAcquisition = false;
const onInt = () => { signalCode = 130; controller.abort("interrupted"); };
const onTerm = () => { signalCode = 143; controller.abort("interrupted"); };
process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
const fail = kind => { throw Object.assign(new Error(kind), { kind }); };
const pass = name => report.checks.push({ name, status: "passed" });
let phase = "options";
const hash = value => createHash("sha256").update(value).digest("hex");
const lock = () => join(registry, platform, `${device}.lock`, "meta.json");
const metadata = () => JSON.parse(readFileSync(lock(), "utf8"));
function options() {
  const values = {}, flags = new Set(["--live", "--stubbed", "--json"]);
  for (let i = 2; i < process.argv.length; i++) {
    const key = process.argv[i];
    if (![...flags, "--platform", "--device", "--timeout-seconds"].includes(key) || key in values) fail("invalid-options");
    values[key] = flags.has(key) ? true : process.argv[++i];
    if (!flags.has(key) && (!values[key] || values[key].startsWith("--"))) fail("invalid-options");
  }
  platform = values["--platform"]; device = values["--device"];
  if (!["android", "ios"].includes(platform)) fail("explicit-platform-required");
  if (typeof device !== "string" || !(platform === "android" ? /^emulator-\d+$/.test(device) : /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(device))) fail("explicit-virtual-device-required");
  if (!!values["--live"] === !!values["--stubbed"]) fail("explicit-validation-mode-required");
  report.validationMode = values["--live"] ? "live" : "stubbed";
  if (values["--live"] && Object.keys(process.env).some(k => (k === "MOBILE_DEVICE_FAKE_CAPACITY" || k.startsWith("MOBILE_DEVICE_TEST_")) && process.env[k])) fail("live-mode-refuses-test-seams");
  if (values["--live"] && platform === "ios" && hostPlatform() !== "darwin") fail("ios-requires-macos");
  const seconds = Number(values["--timeout-seconds"] ?? 120);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) fail("timeout-must-be-1-to-300-seconds");
  deadline = performance.now() + seconds * 1000;
  deadlineTimer = setTimeout(() => controller.abort("timeout"), seconds * 1000);
  registry = resolve(resolveLeaseRoot(process.env, homedir()));
  env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") || ["MOBILE_DEVICE_OWNER", "MOBILE_DEVICE_TOKEN", "MOBILE_DEVICE_ID", "MOBILE_DEVICE_PLATFORM", "MOBILE_DEVICE_TTL_MINUTES", "MOBILE_DEVICE_ADAPTER_MODULE", "ANDROID_SERIAL", "IOS_SIMULATOR_UDID"].includes(key)) delete env[key];
  env.MOBILE_DEVICE_LEASE_DIR = registry;
}
function leaseSnapshot() {
  const dir = join(registry, platform), snapshot = {};
  if (!existsSync(dir)) return snapshot;
  for (const name of readdirSync(dir).filter(name => name.endsWith(".lock"))) {
    if (name === `${device}.lock`) continue;
    const path = join(dir, name, "meta.json");
    if (!lstatSync(join(dir, name)).isDirectory() || !lstatSync(path).isFile() || lstatSync(path).size > 65536) fail("unrelated-lease-unverifiable");
    const bytes = readFileSync(path), meta = JSON.parse(bytes);
    // acquire reclaims expired records platform-wide. Refuse before calling it
    // if any unrelated record could expire during this run plus cleanup.
    if (!Number.isFinite(Date.parse(meta.expiresAt)) || Date.parse(meta.expiresAt) < Date.now() + Math.max(0, deadline - performance.now()) + 30000) fail("unrelated-lease-too-close-to-expiry");
    snapshot[name] = hash(bytes);
  }
  return snapshot;
}
const same = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
async function command(argv, { cwd = root, cleanup = false, allowFailure = false, limit = 15000 } = {}) {
  if (!cleanup && controller.signal.aborted) fail(controller.signal.reason === "timeout" ? "timeout" : "interrupted");
  const run = smokeCommand(argv[0], argv.slice(1), { env, cwd, signal: cleanup ? undefined : controller.signal, timeoutMs: cleanup ? 5000 : Math.min(limit, deadline - performance.now()) });
  const r = await run.result;
  if (r.kind) fail(r.kind);
  if (r.code !== 0 && !allowFailure) fail(/permission|not permitted|not authorised|not authorized|sandbox/i.test(r.stderr) ? "permission-restricted" : "command-failed");
  return r;
}
const leaseArgs = (verb, owner, token) => [process.execPath, cli, verb, "--platform", platform, "--owner", owner, "--device", device, "--ttl-minutes", "1", ...(token ? ["--token", token] : [])];
async function acquire(owner, allowFailure = false) {
  if (!same(originalLeases, leaseSnapshot())) fail("unrelated-leases-changed");
  uncertainAcquisition = true;
  const r = await command([...leaseArgs("acquire", owner), "--no-boot", "--wait-seconds", "0", "--exclusive", "--json"], { cwd: owner, allowFailure });
  if (r.code !== 0) { uncertainAcquisition = false; return r; }
  let data; try { data = JSON.parse(r.stdout); } catch { fail("acquisition-result-unverifiable"); }
  if (typeof data.token !== "string" || !data.token) fail("acquisition-result-unverifiable");
  captured.set(owner, data.token);
  uncertainAcquisition = false;
  if (data.owner !== owner || data.deviceId !== device || data.platform !== platform) fail("acquisition-identity-mismatch");
  return data;
}
async function sdkSnapshot() {
  const args = platform === "android" ? ["adb", "devices"] : ["xcrun", "simctl", "list", "devices", "available", "--json"];
  const r = await command(args);
  const devices = Object.create(null);
  if (platform === "android") {
    const lines = r.stdout.split(/\r?\n/), header = lines.findIndex(line => line.trim() === "List of devices attached");
    if (header === -1) fail("invalid-sdk-inventory");
    for (const line of lines.slice(header + 1)) {
      if (!line.trim()) continue;
      // Keep the complete state, including recovery/sideload and multiword
      // permission diagnostics. Dropping an unfamiliar row hides transitions.
      const m = /^(\S+)\s+(.+)$/.exec(line.trim());
      if (!m || Object.hasOwn(devices, m[1])) fail("invalid-sdk-inventory");
      devices[m[1]] = m[2];
    }
  } else {
    let data; try { data = JSON.parse(r.stdout); } catch { fail("invalid-sdk-inventory"); }
    for (const list of Object.values(data.devices ?? {})) for (const d of list) if (d.isAvailable !== false && typeof d.udid === "string") devices[d.udid] = d.state;
  }
  if (devices[device] !== (platform === "android" ? "device" : "Booted")) fail("selected-device-must-already-be-ready");
  delete devices[device]; return devices;
}
async function run() {
  options(); phase = "preconditions";
  if (existsSync(dirname(lock()))) fail("selected-device-has-lease-record");
  originalLeases = leaseSnapshot();
  report.observations = { unrelatedLeaseRecords: Object.keys(originalLeases).length };
  pass("registry-preconditions");
  root = realpathSync(mkdtempSync(join(tmpdir(), "mobile-lease-smoke-")));
  const ownerA = join(root, "caller-a"), ownerB = join(root, "caller-b");
  mkdirSync(ownerA); mkdirSync(ownerB);
  phase = "caller-and-registry";
  const a = await acquire(ownerA);
  // Empty config avoids inspecting personal rules while proving the installed
  // entry point resolves the disposable caller rather than node_modules.
  const config = join(root, "adoption.json"); writeFileSync(config, '{"version":1,"instructions":[],"launchers":[]}');
  const adoption = JSON.parse((await command([process.execPath, cli, "adoption-check", "--scope", "project", "--config", config, "--json"], { cwd: ownerA })).stdout);
  if (adoption.owner !== ownerA || adoption.registry !== registry || adoption.installation.version !== version) fail("caller-or-registry-mismatch");
  pass(phase);
  phase = "contention";
  const before = hash(readFileSync(lock()));
  const blocked = await acquire(ownerB, true);
  if (blocked.code !== 1 || hash(readFileSync(lock())) !== before) fail("contention-did-not-preserve-holder");
  pass(phase);
  phase = "renewal";
  const previousExpiry = Date.parse(metadata().expiresAt);
  await command(leaseArgs("renew", ownerA, a.token));
  const renewed = metadata();
  if (renewed.owner !== ownerA || renewed.token !== a.token || Date.parse(renewed.expiresAt) <= previousExpiry || !Number.isFinite(Date.parse(renewed.lastRenewedAt))) fail("renewal-unverified");
  pass(phase);
  phase = "sdk-inventory"; originalDevices = await sdkSnapshot();
  report.observations.unrelatedDeviceStates = Object.keys(originalDevices).length;
  pass(phase);
  const v = await command(platform === "android" ? ["adb", "version"] : ["xcrun", "--version"]);
  const numeric = /(?:Android Debug Bridge version|xcrun version)\s+(\d+(?:\.\d+)*)/.exec(v.stdout);
  if (!numeric) fail("sdk-version-unverifiable");
  report.sdk[platform === "android" ? "adb" : "xcrun"] = numeric[1];
  phase = "sdk-target";
  const probe = platform === "android" ? ["adb", "-s", device, "get-serialno"] : ["xcrun", "simctl", "getenv", device, "SIMULATOR_UDID"];
  const checked = await command([...leaseArgs("exec", ownerA, a.token), "--", ...probe]);
  if (checked.stdout.trim().toLowerCase() !== device.toLowerCase()) fail("sdk-target-mismatch");
  pass(phase);
  // No more SDK work before the artificial ownership transfer.
  phase = "ownership-loss";
  const ready = join(root, "inert-ready");
  lossRun = smokeCommand(process.execPath, [...leaseArgs("exec", ownerA, a.token).slice(1), "--", process.execPath, "-e", 'require("node:fs").writeFileSync(process.argv[1],String(process.pid));process.on("SIGTERM",()=>{});setInterval(()=>{},100)', ready], { env, cwd: ownerA, signal: controller.signal, timeoutMs: Math.max(1, deadline - performance.now()) });
  while (!existsSync(ready)) {
    if (controller.signal.aborted) fail(controller.signal.reason);
    if (lossRun.child.exitCode !== null || lossRun.child.signalCode) fail("inert-child-did-not-start");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await command(leaseArgs("release", ownerA, a.token)); captured.delete(ownerA);
  const b = await acquire(ownerB);
  const stopped = await lossRun.result; lossRun = undefined;
  if (stopped.kind || stopped.code !== 1 || !stopped.stderr.includes("was lost while the command ran")) fail(stopped.kind ?? "ownership-loss-unverified");
  const pid = Number(readFileSync(ready, "utf8"));
  const ps = await command(["ps", "-p", String(pid), "-o", "stat="], { allowFailure: true });
  if (ps.code === 0 && !ps.stdout.trim().startsWith("Z")) fail("inert-child-still-running");
  pass(phase);
  phase = "successor-safe-cleanup";
  const successor = hash(readFileSync(lock()));
  const stale = await command(leaseArgs("release", ownerA, a.token), { allowFailure: true });
  if (stale.code !== 1 || hash(readFileSync(lock())) !== successor) fail("successor-not-preserved");
  await command(leaseArgs("release", ownerB, b.token)); captured.delete(ownerB);
  if (existsSync(dirname(lock()))) fail("captured-cleanup-unverified");
  pass(phase);
  phase = "unrelated-devices";
  if (!same(originalDevices, await sdkSnapshot())) fail("sdk-inventory-changed-inconclusive");
  pass(phase);
  phase = "unrelated-leases";
  if (!same(originalLeases, leaseSnapshot())) fail("unrelated-leases-changed-inconclusive");
  pass(phase);
  report.ok = true;
}
try { await run(); }
catch (error) { report.checks.push({ name: phase, status: "failed", kind: error.kind ?? "unverifiable-result" }); }
finally {
  clearTimeout(deadlineTimer);
  // Stop owned work before releasing; never read a registry token to adopt it.
  controller.abort("cleanup");
  if (lossRun) { await lossRun.result; lossRun = undefined; }
  report.cleanup = uncertainAcquisition ? "unverified" : "passed";
  for (const [owner, token] of captured) {
    try {
      await command(leaseArgs("release", owner, token), { cleanup: true, allowFailure: true });
      if (existsSync(lock())) {
        const meta = metadata();
        if (meta.owner === owner && meta.token === token) fail("captured-lease-remains");
      }
    } catch { report.cleanup = "unverified"; report.ok = false; }
  }
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); }
    catch { report.cleanup = "unverified"; report.ok = false; }
  }
  process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
}
for (const name of ["registry-preconditions", "caller-and-registry", "contention", "renewal", "sdk-inventory", "sdk-target", "ownership-loss", "successor-safe-cleanup", "unrelated-devices", "unrelated-leases"]) {
  if (!report.checks.some(c => c.name === name)) report.checks.push({ name, status: "skipped", kind: "not-reached" });
}
report.liveSdkValidated = report.ok && report.validationMode === "live";
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report)}\n`);
else process.stdout.write([`Installed version: ${report.installedVersion}`, `Mode: ${report.validationMode}; live SDK validated: ${report.liveSdkValidated}`, ...report.checks.map(c => `${c.name}: ${c.status}${c.kind ? ` (${c.kind})` : ""}`), `Cleanup: ${report.cleanup}`].join("\n") + "\n");
process.exitCode = signalCode || (report.ok ? 0 : 1);
