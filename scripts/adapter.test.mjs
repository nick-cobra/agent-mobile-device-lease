import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const moduleUrl = pathToFileURL(join(scripts, "lib/adapter.mjs")).href;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function start(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  const done = new Promise((resolve, reject) => {
    child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
async function fixture(fn, platform = "android") {
  const root = await mkdtemp(join(tmpdir(), "ml-a-")), bin = join(root, "bin");
  await mkdir(bin);
  const env = { ...process.env, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`, MOBILE_DEVICE_LEASE_DIR: join(root, "leases"),
    MOBILE_DEVICE_OWNER: "explicit-owner", MOBILE_DEVICE_FAKE_CAPACITY: platform === "android" ? "emulator-5554" : "SIM-OWNED", AMDL_CALL_LOG: join(root, "calls") };
  for (const key of ["MOBILE_DEVICE_TOKEN", "ANDROID_SERIAL", "ADB_DEVICE_SERIAL", "IOS_SIMULATOR"]) delete env[key];
  const cli = args => start(process.execPath, [join(scripts, "device-lease.mjs"), ...args], env).done;
  const a = await cli(["acquire", "--platform", platform, "--json", "--no-boot", "--wait-seconds", "0"]);
  assert.equal(a.code, 0, a.stderr);
  const own = JSON.parse(a.stdout);
  const meta = join(env.MOBILE_DEVICE_LEASE_DIR, platform, `${own.deviceId}.lock/meta.json`);
  const capturedEnv = { ...env, MOBILE_DEVICE_PLATFORM: platform, MOBILE_DEVICE_ID: own.deviceId, MOBILE_DEVICE_TOKEN: own.token };
  const tool = (name, code = 'require("node:fs").appendFileSync(process.env.AMDL_CALL_LOG, JSON.stringify(process.argv.slice(2))+"\\n");') => writeFile(join(bin, name), `#!${process.execPath}\n${code}\n`, { mode: 0o755 });
  await tool("adb"); await tool("xcrun"); await tool("xcodebuild");
  const children = [];
  const program = code => {
    const process = start(globalThis.process.execPath, ["--input-type=module", "-e", `import { captureDevice } from ${JSON.stringify(moduleUrl)}; ${code}`], capturedEnv);
    children.push(process); return process;
  };
  try { await fn({ root, bin, env, own, meta, capturedEnv, cli, tool, program }); }
  finally {
    for (const p of children) if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill("SIGTERM");
    await Promise.allSettled(children.map(p => p.done));
    await rm(root, { recursive: true, force: true });
  }
}
test("wrapped children discover the helper from the executing installation", () => fixture(async f => {
  const r = await f.cli(["exec", "--platform", "android", "--", process.execPath, "-e", "process.stdout.write(process.env.MOBILE_DEVICE_ADAPTER_MODULE ?? '')"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, moduleUrl);
}));
test("adapter captures owner, device, token, registry and TTL once; binary capture is intact", () => fixture(async f => {
  await f.tool("adb", 'process.stdout.write(Buffer.from([0,255,128,10]));');
  f.capturedEnv.MOBILE_DEVICE_TTL_MINUTES = "2";
  const r = await f.program(`const d = captureDevice(); process.env.MOBILE_DEVICE_TOKEN = "new"; process.env.MOBILE_DEVICE_ID = "emulator-5556"; process.env.MOBILE_DEVICE_LEASE_DIR = "/nonexistent"; const r = await d.adb(["exec-out", "screencap", "-p"], {capture:true, binary:true}); console.log(JSON.stringify({ identity:d.identity, bytes:[...r.stdout] }));`).done;
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.deepEqual(data.bytes, [0,255,128,10]);
  assert.equal(data.identity.owner, f.own.owner);
  assert.equal(data.identity.token, f.own.token);
  const meta = JSON.parse(await readFile(f.meta, "utf8"));
  assert.ok(Date.parse(meta.expiresAt) - Date.now() <= 120000);
}));
test("adapter rejects conflicting inherited pins and direct selectors before SDK access", () => fixture(async f => {
  for (const code of ['process.env.ANDROID_SERIAL="emulator-5556"; captureDevice();', 'await captureDevice().adb(["-s","emulator-5556","shell","true"]);']) {
    const r = await f.program(code).done;
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /conflict|selector|leased device/i);
    assert.equal(existsSync(f.env.AMDL_CALL_LOG), false);
  }
}));
test("adapter does not adopt a same-owner successor token between operations", () => fixture(async f => {
  const ready = join(f.root, "ready"), go = join(f.root, "go");
  const p = f.program(`import {writeFileSync,existsSync} from 'node:fs'; const d=captureDevice(); await d.adb(["shell","true"]); writeFileSync(${JSON.stringify(ready)}, "ready"); while(!existsSync(${JSON.stringify(go)})) await new Promise(r=>setTimeout(r,20)); await d.adb(["install","app.apk"]);`);
  for (let i=0; !existsSync(ready) && i<250; i++) await delay(20);
  assert.ok(existsSync(ready), "first operation must finish");
  const next = { ...JSON.parse(await readFile(f.meta, "utf8")), token: "successor" };
  await writeFile(f.meta, JSON.stringify(next)); await writeFile(go, "continue");
  const r = await p.done;
  assert.notEqual(r.code, 0);
  assert.equal((await readFile(f.env.AMDL_CALL_LOG, "utf8")).trim().split("\n").length, 1);
  assert.equal(JSON.parse(await readFile(f.meta, "utf8")).token, "successor");
}));
test("adapter stops active SDK work on ownership loss and preserves successor metadata", { timeout:15000 }, () => fixture(async f => {
  const ready = join(f.root, "sdk-ready"), ticks = join(f.root, "ticks");
  await f.tool("adb", `const f=require('node:fs'); f.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>f.appendFileSync(${JSON.stringify(ticks)},'x'),25);`);
  const p = f.program('await captureDevice().adb(["shell","long-operation"]);');
  for(let i=0; !existsSync(ready) && i<250; i++) await delay(20);
  assert.ok(existsSync(ready));
  const next = { ...JSON.parse(await readFile(f.meta,"utf8")), token:"successor" };
  await writeFile(f.meta,JSON.stringify(next));
  const r=await p.done;
  assert.notEqual(r.code,0);
  assert.match(r.stderr,/lost while the command ran/);
  const before=await readFile(ticks,"utf8"); await delay(150);
  assert.equal(await readFile(ticks,"utf8"),before);
  assert.equal(JSON.parse(await readFile(f.meta,"utf8")).token,"successor");
}));
test("iOS helper pins simctl and XCTest destinations and rejects an overriding destination", () => fixture(async f => {
  const r = await f.program('const d=captureDevice(); await d.simctl(["install","MOBILE_DEVICE","Example.app"]); await d.xcodebuild(["test-without-building","-xctestrun","Tests.xctestrun"]);').done;
  assert.equal(r.code,0,r.stderr);
  const calls=(await readFile(f.env.AMDL_CALL_LOG,"utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(calls[0],["simctl","install","SIM-OWNED","Example.app"]);
  assert.ok(calls[1].includes("platform=iOS Simulator,id=SIM-OWNED"));
  for(const args of [["-destination","id=OTHER"],["-destination=id=OTHER"],["-parallel-testing-enabled","YES"]]) {
    const bad=await f.program(`await captureDevice().xcodebuild(${JSON.stringify(["test-without-building","-xctestrun","Tests.xctestrun",...args])});`).done;
    assert.notEqual(bad.code,0);
    assert.match(bad.stderr,/destination|parallel/i);
  }
},"ios"));

for (const signal of ["SIGINT", "SIGTERM"]) {
  test(`adapter forwards ${signal} and waits for supervised SDK cleanup`, { timeout: 15000 }, () => fixture(async f => {
    const ready=join(f.root,"ready"), ticks=join(f.root,"ticks");
    await f.tool("adb", `const f=require('node:fs'); process.on('SIGTERM',()=>{}); process.on('SIGINT',()=>{}); f.writeFileSync(${JSON.stringify(ready)},String(process.pid)); setInterval(()=>f.appendFileSync(${JSON.stringify(ticks)},'x'),25);`);
    const p=f.program('await captureDevice().adb(["shell","long-operation"]);');
    for(let i=0; !existsSync(ready) && i<250; i++) await delay(20);
    assert.ok(existsSync(ready));
    p.child.kill(signal);
    const r=await p.done;
    assert.notEqual(r.code,0);
    const before=await readFile(ticks,"utf8"); await delay(150);
    assert.equal(await readFile(ticks,"utf8"),before);
    assert.equal(JSON.parse(await readFile(f.meta,"utf8")).token,f.own.token);
  }));
}
test("adapter bounds captured SDK output and rejects its result", () => fixture(async f => {
  await f.tool("adb", 'process.stdout.write(Buffer.alloc(33*1024*1024));');
  const r=await f.program('await captureDevice().adb(["exec-out","screencap","-p"],{capture:true,binary:true});').done;
  assert.notEqual(r.code,0);
  assert.match(r.stderr,/output exceeded/);
}));
