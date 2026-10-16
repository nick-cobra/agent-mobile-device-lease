import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const ids = { android: "emulator-5554", ios: "11111111-1111-4111-8111-111111111111" };
const other = { android: "emulator-5556", ios: "22222222-2222-4222-8222-222222222222" };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(platform, fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-sm-")), bin = join(root, "bin"), registry = join(root, "leases");
  await mkdir(bin); await mkdir(join(registry, platform), { recursive: true });
  const log = join(root, "sdk-calls"), pidFile = join(root, "sdk-pid");
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, MOBILE_DEVICE_LEASE_DIR: registry, MOBILE_DEVICE_FAKE_CAPACITY: ids[platform], SMOKE_FIXTURE_LOG: log, SMOKE_FIXTURE_PID: pidFile };
  const sdk = `#!${process.execPath}
const f=require('node:fs'),a=process.argv.slice(2),tool=require('node:path').basename(process.argv[1]);
f.appendFileSync(process.env.SMOKE_FIXTURE_LOG,JSON.stringify({tool,args:a})+'\\n');
if(a.includes('version')||a.includes('--version')){console.log(tool==='adb'?'Android Debug Bridge version 1.0.41':'xcrun version 72.');process.exit(0)}
if(a.includes('devices')){
 if(tool==='adb')console.log('List of devices attached\\nemulator-5554 device\\nemulator-5556 device');
 else console.log(JSON.stringify({devices:{'com.apple.CoreSimulator.SimRuntime.iOS-26-0':[{udid:'${ids.ios}',name:'iPhone Fixture',state:'Booted',isAvailable:true},{udid:'${other.ios}',name:'iPhone Other',state:'Booted',isAvailable:true}]}}));
 process.exit(0);
}
if(process.env.SMOKE_FIXTURE_FAIL==='1'){console.error('Permission denied SECRET_SDK_TEXT /Users/private/account ${ids.ios}');process.exit(1)}
if(process.env.SMOKE_FIXTURE_HANG==='1'){f.writeFileSync(process.env.SMOKE_FIXTURE_PID,String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},100)}
else console.log(process.env.SMOKE_FIXTURE_WRONG==='1'?'${other[platform]}':(tool==='adb'?a[a.indexOf('-s')+1]:a[a.indexOf('getenv')+1]));
`;
  for (const name of ["adb", "xcrun"]) await writeFile(join(bin, name), sdk, { mode: 0o755 });
  const run = async (extra = [], overrides = {}) => {
    const child = spawn(process.execPath, [join(scripts, "device-smoke.mjs"), "--platform", platform, "--device", ids[platform], "--stubbed", "--json", ...extra], { env: { ...env, ...overrides }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
    const result = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr })); });
    return { child, result };
  };
  const record = async (id, { expired = false } = {}) => {
    const path = join(registry, platform, `${id}.lock`); await mkdir(path);
    const body = JSON.stringify({ deviceId: id, owner: "/unrelated/worktree", token: "UNRELATED_PRIVATE_TOKEN", acquiredAt: new Date().toISOString(), expiresAt: new Date(Date.now() + (expired ? -1 : 3600000)).toISOString() });
    await writeFile(join(path, "meta.json"), body); return { path: join(path, "meta.json"), body };
  };
  try { await fn({ root, env, platform, registry, log, pidFile, run, record }); }
  finally {
    try {
      const pid = Number(await readFile(pidFile, "utf8"));
      const args = spawnSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 1000 }).stdout;
      if (args.includes(root)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    } catch {}
    await rm(root, { recursive: true, force: true });
  }
}

for (const platform of ["android", "ios"]) test(`installed-style ${platform} smoke completes contention, targeting, loss and cleanup`, { timeout: 20000 }, () => fixture(platform, async f => {
  const unrelated = await f.record(other[platform]);
  const { result } = await f.run(); const r = await result;
  assert.equal(r.code, 0, r.stderr + r.stdout);
  const report = JSON.parse(r.stdout);
  assert.equal(report.ok, true); assert.equal(report.validationMode, "stubbed");
  assert.equal(report.observations.unrelatedLeaseRecords, 1);
  assert.equal(report.observations.unrelatedDeviceStates, 1);
  assert.equal(report.liveSdkValidated, false, "stub SDKs must never be described as live evidence");
  for (const check of ["caller-and-registry", "contention", "renewal", "sdk-target", "ownership-loss", "successor-safe-cleanup", "unrelated-leases", "unrelated-devices"]) {
    assert.ok(report.checks.some(x => x.name === check && x.status === "passed"), check);
  }
  assert.equal(await readFile(unrelated.path, "utf8"), unrelated.body);
  assert.equal(existsSync(join(f.registry, platform, `${ids[platform]}.lock`)), false);
  assert.equal(r.stdout.includes(ids[platform]), false); assert.equal(r.stdout.includes(f.root), false);
  assert.equal(r.stdout.includes("UNRELATED_PRIVATE_TOKEN"), false);
  const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(JSON.parse);
  assert.ok(calls.some(x => x.args.includes(platform === "android" ? "get-serialno" : "getenv")));
  assert.ok(calls.every(x => !x.args.some(arg => ["boot", "shutdown", "erase", "delete", "kill-server", "install"].includes(arg))));
}));

for (const kind of ["occupied", "unrelated-expired"]) test(`${kind} registry state is refused before SDK work`, { timeout: 10000 }, () => fixture("android", async f => {
  const saved = await f.record(kind === "occupied" ? ids.android : other.android, { expired: kind === "unrelated-expired" });
  const r = await (await f.run()).result; assert.notEqual(r.code, 0);
  assert.equal(await readFile(saved.path, "utf8"), saved.body);
  assert.equal(existsSync(f.log), false);
}));

test("live mode refuses fake capacity and never claims live success", { timeout: 10000 }, () => fixture("android", async f => {
  const child = spawnSync(process.execPath, [join(scripts, "device-smoke.mjs"), "--platform", "android", "--device", ids.android, "--live", "--json"], { env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(child.status, 1); const report = JSON.parse(child.stdout);
  assert.equal(report.liveSdkValidated, false); assert.equal(existsSync(f.log), false);
}));

test("an interrupted acquisition never adopts a token from the registry or claims cleanup", { timeout: 12000 }, () => fixture("android", async f => {
  const r = await (await f.run(["--timeout-seconds", "1"], { MOBILE_DEVICE_TEST_EMIT_DELAY_MS: "5000" })).result;
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.equal(report.cleanup, "unverified");
  assert.ok(report.checks.some(c => c.status === "skipped" && c.name === "sdk-target"));
  const meta = JSON.parse(await readFile(join(f.registry, "android", `${ids.android}.lock/meta.json`), "utf8"));
  assert.ok(Date.parse(meta.expiresAt) > Date.now(), "short captured-but-unreturned acquisition is left to expire");
  assert.equal(r.stdout.includes(meta.token), false);
}));

test("inherited owner, token and Git overrides cannot redirect disposable callers", { timeout: 12000 }, () => fixture("android", async f => {
  const r = await (await f.run([], { MOBILE_DEVICE_OWNER: "/private/old-owner", MOBILE_DEVICE_TOKEN: "PRIVATE_OLD_TOKEN", GIT_DIR: "/private/not-a-repo" })).result;
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout, /PRIVATE_OLD_TOKEN|old-owner/);
}));

test("physical and missing targets and missing opt-in are refused", () => fixture("android", async f => {
  for (const args of [["--platform", "android", "--device", "physical-serial", "--live"], ["--platform", "android", "--live"], ["--platform", "android", "--device", ids.android]]) {
    const r = spawnSync(process.execPath, [join(scripts, "device-smoke.mjs"), ...args, "--json"], { env: f.env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).liveSdkValidated, false);
    assert.equal(existsSync(f.log), false);
  }
}));

for (const failure of ["WRONG", "FAIL"]) test(`SDK ${failure.toLowerCase()} failure releases only the captured generation and redacts output`, { timeout: 15000 }, () => fixture("android", async f => {
  const unrelated = await f.record(other.android);
  const r = await (await f.run([], { [`SMOKE_FIXTURE_${failure}`]: "1" })).result;
  assert.equal(r.code, 1); assert.equal(JSON.parse(r.stdout).liveSdkValidated, false);
  assert.equal(existsSync(join(f.registry, "android", `${ids.android}.lock`)), false);
  assert.equal(await readFile(unrelated.path, "utf8"), unrelated.body);
  assert.doesNotMatch(r.stdout + r.stderr, /SECRET_SDK_TEXT|UNRELATED_PRIVATE_TOKEN|\/Users\/private/);
  if (failure === "FAIL") assert.ok(JSON.parse(r.stdout).checks.some(c => c.kind === "permission-restricted"));
}));

test("missing SDK executable is classified and captured ownership is cleaned", { timeout: 12000 }, () => fixture("android", async f => {
  const r = await (await f.run([], { PATH: dirname(process.execPath) })).result;
  assert.equal(r.code, 1);
  const report = JSON.parse(r.stdout);
  assert.ok(report.checks.some(c => c.kind === "missing-executable"));
  assert.equal(report.cleanup, "passed");
  assert.equal(existsSync(join(f.registry, "android", `${ids.android}.lock`)), false);
}));

test("an operation deadline stops a stubborn SDK child and cleans the captured lease", { timeout: 20000 }, () => fixture("android", async f => {
  const r = await (await f.run(["--timeout-seconds", "3"], { SMOKE_FIXTURE_HANG: "1" })).result;
  assert.equal(r.code, 1); const report = JSON.parse(r.stdout);
  assert.equal(report.liveSdkValidated, false); assert.ok(report.checks.some(x => x.kind === "timeout"));
  assert.equal(existsSync(join(f.registry, "android", `${ids.android}.lock`)), false);
  const pid = Number(await readFile(f.pidFile, "utf8"));
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 1000 });
  assert.ok(probe.status !== 0 || probe.stdout.trim().startsWith("Z"), "SDK child must have stopped");
}));

test("SIGTERM interrupts SDK work, preserves unrelated processes and cleans its own lease", { timeout: 20000 }, () => fixture("android", async f => {
  const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore" });
  try {
    const run = await f.run([], { SMOKE_FIXTURE_HANG: "1" });
    const deadline = Date.now() + 8000;
    while (!existsSync(f.pidFile) && run.child.exitCode === null && Date.now() < deadline) await pause(20);
    assert.equal(existsSync(f.pidFile), true, "fixture SDK must be running before interruption");
    run.child.kill("SIGTERM"); const r = await run.result;
    assert.equal(r.code, 143, r.stderr + r.stdout);
    assert.equal(existsSync(join(f.registry, "android", `${ids.android}.lock`)), false);
    assert.doesNotThrow(() => process.kill(bystander.pid, 0));
  } finally { bystander.kill("SIGKILL"); await new Promise(resolve => bystander.once("close", resolve)); }
}));
