import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = join(dirname(fileURLToPath(import.meta.url)), "device-lease.mjs");
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", c => { stdout += c; });
    child.stderr.on("data", c => { stderr += c; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-d-"));
  const bin = join(root, "bin"), registry = join(root, "leases");
  await mkdir(bin);
  const env = { ...process.env, PATH: bin, ANDROID_HOME: root, ANDROID_SDK_ROOT: root,
    MOBILE_DEVICE_LEASE_DIR: registry, MOBILE_DEVICE_OWNER: "/worktree/example", MOBILE_DEVICE_FAKE_CAPACITY: "SIM-OWNED" };
  delete env.MOBILE_DEVICE_TOKEN;
  const tool = (name, body) => writeFile(join(bin, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  const acquire = async () => {
    const r = await run(["acquire", "--platform", "ios", "--json", "--wait-seconds", "0"], env);
    assert.equal(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const meta = join(registry, "ios/SIM-OWNED.lock/meta.json");
  const inventory = devices => tool("xcrun", `console.log(${JSON.stringify(JSON.stringify({ devices: { runtime: devices } }))})`);
  try { await fn({ root, bin, registry, env, tool, acquire, meta, inventory }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

for (const [message, kind] of [["Operation not permitted by sandbox", "permission-restriction"], ["Permission denied", "permission-restriction"], ["CoreSimulatorService connection became invalid", "sdk-failure"]]) {
  test(`doctor preserves SDK stderr and classifies ${kind}: ${message}`, () => fixture(async f => {
    await f.tool("xcrun", `console.error(${JSON.stringify(message)}); process.exit(1)`);
    const result = await run(["doctor", "--platform", "ios", "--json"], f.env);
    assert.equal(result.code, 1);
    const check = JSON.parse(result.stdout).checks.find(c => c.name === "xcrun");
    assert.equal(check.kind, kind);
    assert.equal(check.exitCode, 1);
    assert.equal(check.stderr, message);
    assert.ok(check.detail.includes(message));
    const text = await run(["doctor", "--platform", "ios"], f.env);
    assert.ok(text.stderr.includes(message));
    assert.equal((await readdir(f.root)).includes("leases"), false);
  }));
}
test("doctor distinguishes a missing executable from a failed SDK", () => fixture(async f => {
  const r = await run(["doctor", "--platform", "ios", "--json"], f.env);
  const check = JSON.parse(r.stdout).checks.find(c => c.name === "xcrun");
  assert.equal(check.kind, "missing-executable");
  assert.match(check.detail, /Missing executable/);
}));
test("doctor bounds noisy diagnostics and includes failure output written to stdout", () => fixture(async f => {
  await f.tool("xcrun", 'console.log("SDK failure " + "x".repeat(20000)); process.exit(2)');
  const r = await run(["doctor", "--platform", "ios", "--json"], f.env);
  const check = JSON.parse(r.stdout).checks.find(c => c.name === "xcrun");
  assert.match(check.stdout, /^SDK failure/);
  assert.ok(check.stdout.length <= 4200);
  assert.match(check.detail, /truncated/);
}));
test("a valid shut-down simulator lease shows freshness and remains held", () => fixture(async f => {
  const own = await f.acquire();
  await f.inventory([{ udid: own.deviceId, name: "iPhone Example", state: "Shutdown", isAvailable: true }]);
  const before = await readFile(f.meta, "utf8");
  const r = await run(["list", "--platform", "ios", "--json"], f.env);
  assert.equal(r.code, 0, r.stderr);
  const lease = JSON.parse(r.stdout).leases[0];
  assert.equal(lease.expired, false);
  assert.ok(lease.remainingTtlSeconds > 0);
  assert.equal(lease.deviceState.state, "Shutdown");
  assert.equal(lease.deviceState.availability, "present");
  assert.equal(lease.lastRenewedAt, null);
  assert.equal(lease.renewalKnown, true);
  assert.equal("token" in lease, false);
  assert.equal(await readFile(f.meta, "utf8"), before);
  const contender = await run(["acquire", "--platform", "ios", "--device", own.deviceId, "--owner", "other", "--wait-seconds", "0"], f.env);
  assert.equal(contender.code, 1);
  const text = await run(["list", "--platform", "ios"], f.env);
  assert.match(text.stderr, /ttl=.*last-renewed=.*device=Shutdown/);
  assert.match(text.stderr, /does not end.*lease/);
}));
test("status shows expired records without removing them", () => fixture(async f => {
  await f.acquire();
  const meta = JSON.parse(await readFile(f.meta, "utf8"));
  meta.expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(f.meta, JSON.stringify(meta));
  await f.inventory([]);
  const before = await readFile(f.meta, "utf8");
  const r = await run(["list", "--platform", "ios", "--json"], f.env);
  const lease = JSON.parse(r.stdout).leases[0];
  assert.equal(lease.expired, true);
  assert.equal(lease.remainingTtlSeconds, 0);
  assert.equal(await readFile(f.meta, "utf8"), before);
}));
test("status distinguishes absent devices from unavailable state queries", () => fixture(async f => {
  await f.acquire();
  await f.inventory([]);
  const absent = JSON.parse((await run(["list", "--platform", "ios", "--json"], f.env)).stdout);
  assert.equal(absent.leases[0].deviceState.availability, "absent");
  await f.tool("xcrun", 'console.error("Operation not permitted"); process.exit(1)');
  const failed = JSON.parse((await run(["list", "--platform", "ios", "--json"], f.env)).stdout);
  assert.equal(failed.leases[0].deviceState.availability, "unavailable");
  assert.equal(failed.observations.ios.kind, "permission-restriction");
  await f.tool("xcrun", 'console.log("not json")');
  const malformed = JSON.parse((await run(["list", "--platform", "ios", "--json"], f.env)).stdout);
  assert.equal(malformed.leases[0].deviceState.availability, "unavailable");
}));
test("renewal records its actual timestamp; old metadata does not invent one", () => fixture(async f => {
  const own = await f.acquire();
  const r = await run(["renew", "--platform", "ios", "--token", own.token], f.env);
  assert.equal(r.code, 0, r.stderr);
  const meta = JSON.parse(await readFile(f.meta, "utf8"));
  assert.ok(Number.isFinite(Date.parse(meta.lastRenewedAt)));
  delete meta.lastRenewedAt;
  await writeFile(f.meta, JSON.stringify(meta));
  await f.inventory([]);
  const old = JSON.parse((await run(["list", "--platform", "ios", "--json"], f.env)).stdout).leases[0];
  assert.equal(old.lastRenewedAt, null);
  assert.equal(old.renewalKnown, false);
}));
for (const state of ["offline", "unauthorized"]) test(`Android status preserves ${state} observations`, () => fixture(async f => {
  await mkdir(join(f.registry, "android/emulator-5554.lock"), { recursive: true });
  const path = join(f.registry, "android/emulator-5554.lock/meta.json");
  await writeFile(path, JSON.stringify({ deviceId: "emulator-5554", owner: "other", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() }));
  await f.tool("adb", `console.log("List of devices attached\\nemulator-5554\\t${state}\\n")`);
  const result = await run(["list", "--platform", "android", "--json"], f.env);
  assert.equal(JSON.parse(result.stdout).leases[0].deviceState.state, state);
}));
