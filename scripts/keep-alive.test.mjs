import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "device-lease.mjs");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await pause(20); }
  throw Error("Timed out waiting for the renewal process");
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-keep-"));
  const env = { ...process.env, MOBILE_DEVICE_LEASE_DIR: join(root, "leases"), MOBILE_DEVICE_OWNER: "/worktree/manual", MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" };
  delete env.MOBILE_DEVICE_TOKEN;
  const children = [];
  function cli(args, overrides = {}) {
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const output = { stdout: "", stderr: "" };
    child.stdout.on("data", data => { output.stdout += data; });
    child.stderr.on("data", data => { output.stderr += data; });
    const result = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, ...output }));
    });
    return { child, output, result };
  }
  try {
    const acquired = await cli(["acquire", "--platform", "android", "--json", "--no-boot", "--wait-seconds", "0", "--ttl-minutes", "1"]).result;
    assert.equal(acquired.code, 0, acquired.stderr);
    const lease = JSON.parse(acquired.stdout);
    const meta = join(env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock/meta.json");
    const keep = (extra = [], overrides = {}) => cli(["keep-alive", "--platform", "android", "--token", lease.token, "--ttl-minutes", "1", "--duration-minutes", "0.02", "--json", ...extra], overrides);
    const events = run => run.output.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
    const started = async run => {
      await until(() => run.output.stdout.includes('"event":"started"') || run.child.exitCode !== null);
      assert.ok(events(run).some(x => x.event === "started"), run.output.stderr);
    };
    const replace = async changes => {
      const next = JSON.stringify({ ...JSON.parse(await readFile(meta, "utf8")), ...changes });
      await writeFile(meta + ".next", next); await rename(meta + ".next", meta); return next;
    };
    await fn({ root, env, cli, lease, meta, keep, events, started, replace });
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => child.once("close", resolve))));
    await rm(root, { recursive: true, force: true });
  }
}

test("keep-alive has a finite lifetime and leaves the captured manual lease held", { timeout: 10000 }, () => fixture(async f => {
  const run = f.keep(); await f.started(run);
  const ready = f.events(run).find(x => x.event === "started");
  assert.equal(ready.pid, run.child.pid);
  assert.equal(ready.deviceId, f.lease.deviceId);
  assert.equal(ready.owner, f.lease.owner);
  assert.equal(ready.renewalHealthy, true);
  assert.ok(Date.parse(ready.renewalEndsAt) > Date.now());
  const result = await run.result; assert.equal(result.code, 0, result.stderr);
  const stopped = f.events(run).at(-1);
  assert.equal(stopped.event, "stopped"); assert.equal(stopped.reason, "duration-complete");
  const stored = JSON.parse(await readFile(f.meta, "utf8"));
  assert.equal(stored.token, f.lease.token);
  assert.equal(stopped.expiresAt, stored.expiresAt);
  assert.ok(Date.parse(stored.expiresAt) > Date.now());
  const held = await f.cli(["acquire", "--platform", "android", "--device", f.lease.deviceId, "--no-boot", "--wait-seconds", "0"], { MOBILE_DEVICE_OWNER: "/worktree/competitor" }).result;
  assert.equal(held.code, 1, "ending renewal must not release a manual session");
}));

test("keep-alive requires a captured token and rejects invalid duration without mutation", () => fixture(async f => {
  const original = await readFile(f.meta, "utf8");
  for (const flags of [[], ["--token", "stale"], ["--token", f.lease.token, "--duration-minutes", "0"], ["--token", f.lease.token, "--duration-minutes", "Infinity"], ["--token", f.lease.token, "--duration-minutes", "1441"], ["--token", f.lease.token, "--duration-minutes"], ["--token", f.lease.token, "--force"]]) {
    const result = await f.cli(["keep-alive", "--platform", "android", ...flags]).result;
    assert.equal(result.code, 1, JSON.stringify(flags));
    assert.equal(await readFile(f.meta, "utf8"), original);
  }
}));

for (const signal of ["SIGINT", "SIGTERM"]) test(`${signal} stops keep-alive without releasing or renewing later`, { timeout: 10000 }, () => fixture(async f => {
  const run = f.keep(); await f.started(run); run.child.kill(signal);
  const result = await run.result; assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
  const original = await readFile(f.meta, "utf8"); await pause(100);
  assert.equal(await readFile(f.meta, "utf8"), original);
  assert.equal(JSON.parse(original).token, f.lease.token);
  assert.equal(f.events(run).at(-1).reason, "interrupted");
}));

for (const change of [{ token: "successor" }, { owner: "/worktree/next", token: "next" }, { expiresAt: new Date(0).toISOString() }]) test(`keep-alive stops after ${Object.keys(change).join("/")} changes`, { timeout: 10000 }, () => fixture(async f => {
  const run = f.keep(); await f.started(run); const expected = await f.replace(change);
  const result = await run.result; assert.equal(result.code, 1, result.stderr);
  assert.equal(await readFile(f.meta, "utf8"), expected);
  assert.equal(f.events(run).at(-1).reason, "ownership-lost");
  assert.equal(f.events(run).at(-1).expiresAt, null);
}));

test("keep-alive rejects an explicit captured-device mismatch without renewal", () => fixture(async f => {
  const original = await readFile(f.meta, "utf8");
  const result = await f.keep(["--device", "emulator-5556"]).result;
  assert.equal(result.code, 1); assert.equal(await readFile(f.meta, "utf8"), original);
}));

test("keep-alive inherits the existing custom TTL when no override is supplied", { timeout: 10000 }, () => fixture(async f => {
  const run = f.cli(["keep-alive", "--platform", "android", "--token", f.lease.token, "--duration-minutes", "0.005", "--json"]);
  assert.equal((await run.result).code, 0, run.output.stderr);
  const stored = JSON.parse(await readFile(f.meta, "utf8"));
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.lastRenewedAt), 60000);
}));

test("keep-alive bounds heartbeat timers even with a very large valid TTL", { timeout: 10000 }, () => fixture(async f => {
  const huge = f.cli(["keep-alive", "--platform", "android", "--token", f.lease.token, "--ttl-minutes", "1440000", "--duration-minutes", "0.005", "--json"]);
  assert.equal((await huge.result).code, 0, huge.output.stderr);
  assert.doesNotMatch(huge.output.stderr, /TimeoutOverflow/);
  assert.deepEqual(f.events(huge).map(x => x.event), ["started", "stopped"]);
}));

test("keep-alive does not adopt an expired lease or create an absent registry", () => fixture(async f => {
  await f.replace({ expiresAt: new Date(0).toISOString() });
  const original = await readFile(f.meta, "utf8"); assert.equal((await f.keep().result).code, 1);
  assert.equal(await readFile(f.meta, "utf8"), original);
  const absent = join(f.root, "absent"); assert.equal((await f.keep([], { MOBILE_DEVICE_LEASE_DIR: absent }).result).code, 1);
  await assert.rejects(readFile(absent), { code: "ENOENT" });
}));

test("keep-alive stops promptly on invalid metadata", { timeout: 10000 }, () => fixture(async f => {
  const run = f.keep(); await f.started(run); await writeFile(f.meta, "invalid-json");
  assert.equal((await run.result).code, 1); assert.equal(await readFile(f.meta, "utf8"), "invalid-json");
}));

test("keep-alive cancels a pending initial renewal mutex wait promptly", { timeout: 10000 }, () => fixture(async f => {
  const original = await readFile(f.meta, "utf8");
  const server = createServer(socket => socket.end());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(join(f.env.MOBILE_DEVICE_LEASE_DIR, "android", ".lease-op.sock"), resolve); });
  try {
    const run = f.keep(); const result = await run.result;
    assert.equal(result.code, 1, result.stderr);
    assert.equal(f.events(run).some(x => x.event === "started"), false);
    assert.equal(await readFile(f.meta, "utf8"), original);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test("a renewal delayed beyond the keep-alive deadline never changes lease metadata", { timeout: 10000 }, () => fixture(async f => {
  const original = await readFile(f.meta, "utf8");
  const run = f.cli(["keep-alive", "--platform", "android", "--token", f.lease.token, "--duration-minutes", "0.001", "--json"], { MOBILE_DEVICE_TEST_RENEW_DELAY_MS: "200" });
  assert.equal((await run.result).code, 1);
  assert.equal(await readFile(f.meta, "utf8"), original);
  assert.equal(f.events(run).some(x => x.event === "started"), false);
}));

test("SIGTERM cancels a pending initial mutex wait without a later renewal", { timeout: 10000 }, () => fixture(async f => {
  const original = await readFile(f.meta, "utf8");
  let connected = false;
  const server = createServer(socket => { socket.end(); connected = true; });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(join(f.env.MOBILE_DEVICE_LEASE_DIR, "android", ".lease-op.sock"), resolve); });
  try {
    const run = f.keep(); await until(() => connected || run.child.exitCode !== null);
    assert.ok(connected, run.output.stderr); run.child.kill("SIGTERM");
    assert.equal((await run.result).code, 143, run.output.stderr);
    assert.equal(await readFile(f.meta, "utf8"), original);
    assert.equal(f.events(run).some(x => x.event === "started"), false);
  } finally { await new Promise(resolve => server.close(resolve)); }
}));

test("keep-alive also renews a captured iOS lease without SDK access", { timeout: 10000 }, () => fixture(async f => {
  const overrides = { MOBILE_DEVICE_FAKE_CAPACITY: "SIM-ONLY" };
  const acquired = await f.cli(["acquire", "--platform", "ios", "--json", "--wait-seconds", "0", "--ttl-minutes", "1"], overrides).result;
  assert.equal(acquired.code, 0, acquired.stderr);
  const lease = JSON.parse(acquired.stdout);
  const run = f.cli(["keep-alive", "--platform", "ios", "--token", lease.token, "--device", lease.deviceId, "--duration-minutes", "0.005", "--json"], overrides);
  assert.equal((await run.result).code, 0, run.output.stderr);
  assert.equal(f.events(run)[0].platform, "ios");
  assert.equal(f.events(run)[0].deviceId, "SIM-ONLY");
  const meta = JSON.parse(await readFile(join(f.env.MOBILE_DEVICE_LEASE_DIR, "ios", "SIM-ONLY.lock/meta.json"), "utf8"));
  assert.equal(meta.token, lease.token);
  assert.equal(Date.parse(meta.expiresAt) - Date.parse(meta.lastRenewedAt), 60000);
}));

test("keep-alive periodically renews the same generation with its configured TTL", { timeout: 23000 }, () => fixture(async f => {
  const run = f.cli(["keep-alive", "--platform", "android", "--token", f.lease.token, "--ttl-minutes", "1", "--duration-minutes", "0.27", "--json"]);
  await f.started(run); const first = JSON.parse(await readFile(f.meta, "utf8"));
  const result = await run.result; assert.equal(result.code, 0, result.stderr);
  const stored = JSON.parse(await readFile(f.meta, "utf8"));
  assert.equal(stored.token, first.token); assert.ok(Date.parse(stored.lastRenewedAt) > Date.parse(first.lastRenewedAt));
  assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.lastRenewedAt), 60000);
  assert.ok(f.events(run).some(x => x.event === "renewed"));
}));
