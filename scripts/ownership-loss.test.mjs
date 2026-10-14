import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer } from "node:net";

const scripts = dirname(fileURLToPath(import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(20); }
  throw new Error("Timed out waiting for the owned command to stop or become ready");
}
function cli(args, env) {
  const child = spawn(process.execPath, [join(scripts, "device-lease.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; });
  child.stderr.on("data", (data) => { stderr += data; });
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, result };
}
async function bounded(result, timeout = 5000) {
  let timer;
  try { return await Promise.race([result, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned execution continued after ownership loss")), timeout); })]); }
  finally { clearTimeout(timer); }
}
function running(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() && !result.stdout.trim().startsWith("Z");
}
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-loss-"));
  const env = { ...process.env, MOBILE_DEVICE_LEASE_DIR: join(root, "leases"), MOBILE_DEVICE_OWNER: "/worktree/task", MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" };
  delete env.MOBILE_DEVICE_TOKEN;
  const processes = [];
  const worker = join(root, "command-worker.mjs");
  const record = join(root, "pids.json");
  const leafReady = join(root, "leaf-ready");
  const leafCode = `const f=require('node:fs');f.writeFileSync(${JSON.stringify(leafReady)},'ready');process.on('SIGTERM',()=>{});setInterval(()=>{},100);`;
  await writeFile(worker, `import {spawn} from 'node:child_process';import{writeFileSync}from'node:fs';const leaf=spawn(process.execPath,['-e',${JSON.stringify(leafCode)}],{stdio:'ignore'});process.on('SIGTERM',()=>{if(!process.env.MOBILE_IGNORE_TERM)process.exit(0)});writeFileSync(${JSON.stringify(record)},JSON.stringify({root:process.pid,leaf:leaf.pid}));setInterval(()=>{},100);`);
  try { await fn({ root, env, worker, record, leafReady, processes }); }
  finally {
    for (const child of processes) { try { child.kill("SIGKILL"); } catch {} }
    try {
      const pids = JSON.parse(await readFile(record, "utf8"));
      for (const pid of Object.values(pids)) {
        const identity = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8" }).stdout;
        if (identity?.includes(root)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      }
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}
async function launch(f, { ignoreTerm = false, nested = false } = {}) {
  const acquired = cli(["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json", "--ttl-minutes", "1"], f.env);
  f.processes.push(acquired.child);
  const first = await bounded(acquired.result);
  assert.equal(first.code, 0, first.stderr);
  const lease = JSON.parse(first.stdout);
  const command = [process.execPath, f.worker];
  if (nested) command.unshift(process.execPath, join(scripts, "device-lease.mjs"), "exec", "--platform", "android", "--ttl-minutes", "1", "--");
  const executed = cli(["exec", "--platform", "android", "--ttl-minutes", "1", "--", ...command], { ...f.env, MOBILE_IGNORE_TERM: ignoreTerm ? "1" : "" });
  f.processes.push(executed.child);
  await until(async () => { try { await readFile(f.record); await readFile(f.leafReady); return true; } catch { return false; } });
  const pids = JSON.parse(await readFile(f.record, "utf8"));
  return { ...executed, lease, pids, meta: join(f.env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock/meta.json") };
}
async function replace(meta, change) {
  const data = JSON.parse(await readFile(meta, "utf8"));
  const updated = JSON.stringify({ ...data, ...change });
  await writeFile(meta + ".next", updated);
  await rename(meta + ".next", meta);
  return updated;
}

for (const kind of ["owner", "same-owner token", "expiry"]) {
  test(`lost ${kind} stops root and SIGTERM-ignoring descendant promptly`, { timeout: 12000 }, () => fixture(async (f) => {
    const run = await launch(f);
    const change = kind === "owner" ? { owner: "/worktree/successor", token: "successor" } : kind === "same-owner token" ? { token: "successor" } : { expiresAt: new Date(Date.now() - 1).toISOString() };
    const expected = await replace(run.meta, change);
    const result = await bounded(run.result);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /lost|no longer|ownership/i);
    await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
    assert.equal(await readFile(run.meta, "utf8"), expected, "old execution must not renew or release a successor");
  }));
}

test("ownership loss escalates when both root and descendant ignore SIGTERM", { timeout: 12000 }, () => fixture(async (f) => {
  const run = await launch(f, { ignoreTerm: true });
  await replace(run.meta, { token: "successor" });
  const result = await bounded(run.result);
  assert.notEqual(result.code, 0);
  await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
}));

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`${signal} stops a nested wrapper's separate SDK process group`, { timeout: 12000 }, () => fixture(async (f) => {
    const run = await launch(f, { nested: true, ignoreTerm: true });
    run.child.kill(signal);
    const result = await bounded(run.result);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143, result.stderr);
    await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
    assert.equal(JSON.parse(await readFile(run.meta, "utf8")).token, run.lease.token, "interrupting exec must leave the task lease intact");
  }));
}

test("ownership loss also stops nested SDK groups and leaves unrelated processes running", { timeout: 12000 }, () => fixture(async (f) => {
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},100)", f.root], { stdio: "ignore" });
  f.processes.push(unrelated);
  const run = await launch(f, { nested: true, ignoreTerm: true });
  const expected = await replace(run.meta, { token: "successor" });
  const result = await bounded(run.result);
  assert.equal(result.code, 1, result.stderr);
  await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
  assert.ok(running(unrelated.pid), "only the spawned command groups may be stopped");
  assert.equal(await readFile(run.meta, "utf8"), expected);
}));

for (const corruption of ["missing", "unreadable"]) {
  test(`${corruption} lease metadata stops device work without waiting for renewal`, { timeout: 12000 }, () => fixture(async (f) => {
    const run = await launch(f);
    if (corruption === "missing") await rm(run.meta);
    else await writeFile(run.meta, "invalid-json");
    assert.equal((await bounded(run.result)).code, 1);
    await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
  }));
}

test("loss monitoring continues while heartbeat renewal is waiting for the registry mutex", { timeout: 26000 }, () => fixture(async (f) => {
  const run = await launch(f);
  const server = createServer((socket) => socket.end());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(join(f.env.MOBILE_DEVICE_LEASE_DIR, "android", ".lease-op.sock"), resolve); });
  try {
    // The minimum TTL schedules a heartbeat at 15 s. Keep its mutation lock
    // occupied, then replace the token while that heartbeat is waiting.
    await pause(15300);
    const expected = await replace(run.meta, { token: "successor" });
    assert.equal((await bounded(run.result)).code, 1);
    await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
    assert.equal(await readFile(run.meta, "utf8"), expected);
  } finally { await new Promise((resolve) => server.close(resolve)); }
}));

test("ordinary output and nonzero exit codes propagate without releasing the task lease", () => fixture(async (f) => {
  const acquisition = cli(["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json"], f.env);
  f.processes.push(acquisition.child);
  const first = await bounded(acquisition.result);
  assert.equal(first.code, 0, first.stderr);
  const lease = JSON.parse(first.stdout);
  const run = cli(["exec", "--platform", "android", "--", process.execPath, "-e", "process.stdout.write('ordinary-output');process.stderr.write('ordinary-error');process.exit(23)"], f.env);
  f.processes.push(run.child);
  const result = await bounded(run.result);
  assert.equal(result.code, 23);
  assert.equal(result.stdout, "ordinary-output");
  assert.equal(result.stderr, "ordinary-error");
  const meta = join(f.env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock/meta.json");
  assert.equal(JSON.parse(await readFile(meta, "utf8")).token, lease.token);
}));

test("restricted process inspection reports its limit and still stops the known group", { timeout: 12000 }, () => fixture(async (f) => {
  const bin = join(f.root, "restricted-bin");
  await mkdir(bin);
  await writeFile(join(bin, "ps"), "#!/bin/sh\necho 'Operation not permitted' >&2\nexit 1\n", { mode: 0o755 });
  f.env.PATH = `${bin}:${f.env.PATH}`;
  const run = await launch(f, { ignoreTerm: true });
  await replace(run.meta, { token: "successor" });
  const result = await bounded(run.result);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /process tree.*host process access/);
  await until(() => !running(run.pids.root) && !running(run.pids.leaf), 2000);
}));

test("a quick command cannot return success after changing its captured token", () => fixture(async (f) => {
  const acquisition = cli(["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json"], f.env);
  f.processes.push(acquisition.child);
  assert.equal((await bounded(acquisition.result)).code, 0);
  const code = "const f=require('node:fs'),p=require('node:path');const file=p.join(process.env.MOBILE_DEVICE_LEASE_DIR,'android',process.env.MOBILE_DEVICE_ID+'.lock/meta.json');const m=JSON.parse(f.readFileSync(file));m.token='successor';f.writeFileSync(file,JSON.stringify(m));";
  const run = cli(["exec", "--platform", "android", "--", process.execPath, "-e", code], f.env);
  f.processes.push(run.child);
  const result = await bounded(run.result);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /lost|ownership/i);
}));
