import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { androidRecoveryDecision } from "./lib/device-lease.mjs";
import { resolveOwner } from "./lib/owner.mjs";
import { spawnSync } from "node:child_process";

const scripts = dirname(fileURLToPath(import.meta.url));
const run = (script, args, env) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [join(scripts, script), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolvePromise({ code, stdout, stderr }));
});
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-h-"));
  const env = { MOBILE_DEVICE_LEASE_DIR: join(root, "l"), MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554,emulator-5556", MOBILE_DEVICE_OWNER: "/worktree/test" };
  try { await fn(root, env); } finally { await rm(root, { recursive: true, force: true }); }
}
const acquireArgs = ["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json"];

test("an installed CLI identifies the caller's checkout rather than its package directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "ml-own-"));
  try {
    const git = spawnSync("git", ["init", root], { encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
    assert.equal(resolveOwner({ cwd: root, env: {} }), await realpath(root));
    assert.equal(resolveOwner({ cwd: root, explicit: "task-run", env: {} }), "task-run");
    assert.equal(resolveOwner({ cwd: root, env: { MOBILE_DEVICE_OWNER: "another-run" } }), "another-run");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("device placeholders never rewrite environment variable names", () => fixture(async (root, env) => {
  const acquired = await run("device-lease.mjs", acquireArgs, env);
  assert.equal(acquired.code, 0, acquired.stderr);
  const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", process.execPath, "-e", "process.stdout.write(process.env.MOBILE_DEVICE_LEASE_DIR)"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, env.MOBILE_DEVICE_LEASE_DIR);
}));

test("JSON acquisition returns its captured identity and token", () => fixture(async (root, env) => {
  const result = await run("device-lease.mjs", acquireArgs, env);
  assert.equal(result.code, 0, result.stderr);
  const lease = JSON.parse(result.stdout);
  assert.equal(lease.platform, "android");
  assert.equal(lease.owner, env.MOBILE_DEVICE_OWNER);
  const meta = JSON.parse(await readFile(join(env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock", "meta.json"), "utf8"));
  assert.equal(lease.token, meta.token);
}));

test("automatic session pins its command and releases after success", () => fixture(async (root, env) => {
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, "-e", "process.stdout.write(process.env.ANDROID_SERIAL)"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "emulator-5554");
  assert.equal((await readdir(join(env.MOBILE_DEVICE_LEASE_DIR, "android"))).filter((x) => x.endsWith(".lock")).length, 0);
}));

test("automatic session propagates failure and still releases", () => fixture(async (root, env) => {
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, "-e", "process.exit(7)"], env);
  assert.equal(result.code, 7, result.stderr);
  assert.equal((await readdir(join(env.MOBILE_DEVICE_LEASE_DIR, "android"))).filter((x) => x.endsWith(".lock")).length, 0);
}));

test("automatic session refuses an already owned lease without releasing it", () => fixture(async (root, env) => {
  const acquired = await run("device-lease.mjs", acquireArgs, env);
  assert.equal(acquired.code, 0, acquired.stderr);
  const lease = JSON.parse(acquired.stdout);
  const metaPath = join(env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock", "meta.json");
  const before = await readFile(metaPath, "utf8");
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, "-e", "console.log('must-not-run')"], env);
  assert.equal(result.code, 1);
  assert.ok(!result.stdout.includes("must-not-run"));
  assert.equal(await readFile(metaPath, "utf8"), before);
}));

test("session cleanup cannot release a same-owner successor", () => fixture(async (root, env) => {
  const mutation = `const f=require('node:fs');const p=require('node:path');const file=p.join(process.env.MOBILE_DEVICE_LEASE_DIR,'android',process.env.ANDROID_SERIAL+'.lock','meta.json');const m=JSON.parse(f.readFileSync(file));m.token='successor-token';f.writeFileSync(file,JSON.stringify(m));`;
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, "-e", mutation], env);
  assert.equal(result.code, 1);
  const meta = JSON.parse(await readFile(join(env.MOBILE_DEVICE_LEASE_DIR, "android", "emulator-5554.lock", "meta.json"), "utf8"));
  assert.equal(meta.token, "successor-token");
}));

test("explicit app configuration protects the receiving project's crashes", () => {
  const probe = { health: { healthy: true }, emulator: true, blockingDialog: { kind: "crash", packageName: "org.example.club.debug" } };
  assert.equal(androidRecoveryDecision({ ...probe, appPackages: ["org.example.club.debug"] }).action, "fail-app");
  assert.equal(androidRecoveryDecision(probe).action, "fail-unknown-app");
  assert.equal(androidRecoveryDecision({ ...probe, blockingDialog: { kind: "anr", packageName: "com.android.systemui" }, appPackages: ["org.example.club.debug"] }).action, "clear-system-dialog");
});

test("build CLI refuses occupied capacity and never starts the build", async () => {
  const root = await mkdtemp(join(tmpdir(), "ml-b-"));
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const result = await run("mobile-build.mjs", ["--wait-seconds", "0", "--", process.execPath, "-e", "console.log('must-not-run')"], { MOBILE_BUILD_LOCK_PORT: String(server.address().port), MOBILE_BUILD_LOCK: join(root, "build.lock") });
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes("must-not-run"));
  } finally {
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("build CLI propagates failure and frees capacity for its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "ml-b-"));
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const env = { MOBILE_BUILD_LOCK_PORT: String(port), MOBILE_BUILD_LOCK: join(root, "build.lock") };
  try {
    const failed = await run("mobile-build.mjs", ["--", process.execPath, "-e", "process.exit(9)"], env);
    assert.equal(failed.code, 9, failed.stderr);
    const next = await run("mobile-build.mjs", ["--wait-seconds", "0", "--", process.execPath, "-e", "console.log('next-build')"], env);
    assert.equal(next.code, 0, next.stderr);
    assert.match(next.stdout, /next-build/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("exec heartbeat renews during a running child", { timeout: 25000 }, () => fixture(async (root, env) => {
  const acquired = await run("device-lease.mjs", [...acquireArgs, "--ttl-minutes", "1"], env);
  assert.equal(acquired.code, 0, acquired.stderr);
  const lease = JSON.parse(acquired.stdout);
  const metaPath = join(env.MOBILE_DEVICE_LEASE_DIR, "android", lease.deviceId + ".lock", "meta.json");
  const before = JSON.parse(await readFile(metaPath, "utf8"));
  const childCode = `setTimeout(()=>{const f=require('node:fs');const p=require('node:path');const m=JSON.parse(f.readFileSync(p.join(process.env.MOBILE_DEVICE_LEASE_DIR,'android',process.env.ANDROID_SERIAL+'.lock','meta.json')));process.stdout.write(m.acquiredAt)},17000)`;
  const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--token", lease.token, "--ttl-minutes", "1", "--", process.execPath, "-e", childCode], env);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Date.parse(result.stdout) - Date.parse(before.acquiredAt) >= 14000);
}));
