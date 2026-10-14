import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const scripts = dirname(fileURLToPath(import.meta.url));
const run = (file, args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(scripts, file), ...args], {
    env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});
async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "ml-f-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  const env = {
    MOBILE_DEVICE_LEASE_DIR: join(root, "leases"), MOBILE_DEVICE_OWNER: "/worktree/example",
    MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554", PATH: bin,
    ANDROID_SDK_ROOT: join(root, "sdk"), ANDROID_HOME: join(root, "sdk"),
    AMDL_CALL_LOG: join(root, "calls"),
  };
  for (const tool of ["adb", "xcrun", "simctl"]) {
    await writeFile(join(bin, tool), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AMDL_CALL_LOG"\n', { mode: 0o755 });
  }
  try { await fn(root, env, bin); } finally { await rm(root, { recursive: true, force: true }); }
}
async function acquire(env, platform = "android") {
  const result = await run("device-lease.mjs", ["acquire", "--platform", platform, "--no-boot", "--wait-seconds", "0", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const args of [
  ["-s", "emulator-5556", "shell", "true"], ["-semulator-5556", "shell", "true"],
  ["-s", "emulator-5554", "-s", "emulator-5556", "shell", "true"],
  ["-t", "2", "shell", "true"], ["-t2", "shell", "true"],
  ["-d", "shell", "true"], ["-e", "shell", "true"],
]) {
  test(`direct adb refuses an overriding selector: ${args.join(" ")}`, () => fixture(async (root, env, bin) => {
    await acquire(env);
    const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", join(bin, "adb"), ...args], env);
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /selector|leased device/i);
    assert.equal(existsSync(env.AMDL_CALL_LOG), false, "SDK command must not start");
  }));
}

test("matching adb selector and command-specific install/shell flags remain usable", () => fixture(async (root, env) => {
  await acquire(env);
  for (const args of [["-s", "MOBILE_DEVICE", "install", "-t", "-d", "app.apk"], ["shell", "-e", "none", "am", "start", "-d", "example://path"]]) {
    const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", "adb", ...args], env);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.match(await readFile(env.AMDL_CALL_LOG, "utf8"), /-s emulator-5554 install -t -d app.apk/);
}));

for (const args of [
  ["install", "SIMULATOR-OTHER", "app.app"], ["shutdown", "all"],
  ["io", "booted", "screenshot", "shot.png"], ["delete", "all"],
  ["launch", "--console", "SIMULATOR-OTHER", "com.example.app"],
  ["delete", "SIMULATOR-OWNED", "SIMULATOR-OTHER"],
]) {
  test(`direct simctl refuses a conflicting or global operand: ${args.join(" ")}`, () => fixture(async (root, env) => {
    env.MOBILE_DEVICE_FAKE_CAPACITY = "SIMULATOR-OWNED";
    await acquire(env, "ios");
    const result = await run("device-lease.mjs", ["exec", "--platform", "ios", "--", "xcrun", "simctl", ...args], env);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(existsSync(env.AMDL_CALL_LOG), false);
  }));
}

test("direct simctl accepts an owned placeholder including launch options", () => fixture(async (root, env) => {
  env.MOBILE_DEVICE_FAKE_CAPACITY = "SIMULATOR-OWNED";
  await acquire(env, "ios");
  for (const args of [["io", "MOBILE_DEVICE", "screenshot", "shot.png"], ["launch", "--console", "MOBILE_DEVICE", "com.example.app"]]) {
    const result = await run("device-lease.mjs", ["exec", "--platform", "ios", "--", "xcrun", "simctl", ...args], env);
    assert.equal(result.code, 0, result.stderr);
  }
  assert.match(await readFile(env.AMDL_CALL_LOG, "utf8"), /simctl launch --console SIMULATOR-OWNED/);
}));

test("SDK for the other platform cannot run inside the leased wrapper", () => fixture(async (root, env) => {
  await acquire(env);
  const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", "xcrun", "simctl", "install", "SIMULATOR-OTHER", "app.app"], env);
  assert.equal(result.code, 1);
  assert.equal(existsSync(env.AMDL_CALL_LOG), false);
}));

test("unrelated command arguments resembling SDK selectors are data", () => fixture(async (root, env) => {
  await acquire(env);
  const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", process.execPath, "-e", "console.log(process.argv.slice(1).join('|'))", "--", "-s", "emulator-5556"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "-s|emulator-5556");
}));

test("session passes an explicit owner to nested personal adapter commands", () => fixture(async (root, env) => {
  const result = await run("device-session.mjs", ["--platform", "android", "--owner", "personal-task", "--no-boot", "--wait-seconds", "0", "--", process.execPath, "-e", "process.stdout.write(process.env.MOBILE_DEVICE_OWNER)"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "personal-task");
}));

test("missing avdmanager reports the executable rather than guessing a device profile", () => fixture(async (root, env) => {
  await mkdir(join(env.ANDROID_SDK_ROOT, "emulator"), { recursive: true });
  await writeFile(join(env.ANDROID_SDK_ROOT, "emulator/emulator"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await run("provision-android-avds.mjs", ["--size", "1", "--package", "system-images;android-36;google_apis_playstore;arm64-v8a"], env);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /(?:missing|not found|could not run).*avdmanager/i);
  assert.doesNotMatch(result.stderr, /device profile is unknown/i);
}));

test("doctor reports missing SDK prerequisites and never creates a registry", () => fixture(async (root, env, bin) => {
  await rm(join(bin, "adb"));
  // An SDK copy outside PATH must not hide that bare adb child calls will fail.
  await mkdir(join(env.ANDROID_SDK_ROOT, "platform-tools"), { recursive: true });
  await writeFile(join(env.ANDROID_SDK_ROOT, "platform-tools/adb"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const result = await run("device-lease.mjs", ["doctor", "--platform", "android", "--json"], env);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.registry, env.MOBILE_DEVICE_LEASE_DIR);
  assert.ok(report.checks.some((check) => check.name === "adb" && !check.ok));
  assert.ok(report.checks.some((check) => check.name === "avdmanager" && !check.ok));
  assert.equal(existsSync(env.MOBILE_DEVICE_LEASE_DIR), false);
}));

test("doctor reports pool capacity and held devices without renewing or creating leases", () => fixture(async (root, env, bin) => {
  const held = await acquire(env);
  const meta = join(env.MOBILE_DEVICE_LEASE_DIR, "android", held.deviceId + ".lock/meta.json");
  const before = await readFile(meta, "utf8");
  await mkdir(join(env.ANDROID_SDK_ROOT, "emulator"), { recursive: true });
  await mkdir(join(env.ANDROID_SDK_ROOT, "cmdline-tools/latest/bin"), { recursive: true });
  await writeFile(join(env.ANDROID_SDK_ROOT, "emulator/emulator"), '#!/bin/sh\nprintf "mobile-agent-1\\nmobile-agent-2\\npersonal-avd\\n"\n', { mode: 0o755 });
  await writeFile(join(env.ANDROID_SDK_ROOT, "cmdline-tools/latest/bin/avdmanager"), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile(join(bin, "adb"), '#!/bin/sh\nprintf "List of devices attached\\nemulator-5554\\tdevice\\nemulator-5556\\tdevice\\n"\n', { mode: 0o755 });
  const result = await run("device-lease.mjs", ["doctor", "--platform", "android", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.capacity.poolAvds, ["mobile-agent-1", "mobile-agent-2"]);
  assert.deepEqual(report.capacity.availableRunningDevices, ["emulator-5556"]);
  assert.equal(await readFile(meta, "utf8"), before);
  assert.deepEqual((await readdir(join(env.MOBILE_DEVICE_LEASE_DIR, "android"))).filter((name) => name.endsWith(".lock")), ["emulator-5554.lock"]);
}));

test("iOS doctor reports configured families without booting or claiming", () => fixture(async (root, env, bin) => {
  env.AMDL_SIMULATORS = JSON.stringify({ devices: { runtime: [
    { udid: "PHONE", name: "iPhone Example", isAvailable: true, state: "Shutdown" },
    { udid: "PAD", name: "iPad Example", isAvailable: true, state: "Shutdown" },
  ] } });
  await writeFile(join(bin, "xcrun"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AMDL_CALL_LOG"\nprintf "%s" "$AMDL_SIMULATORS"\n', { mode: 0o755 });
  const result = await run("device-lease.mjs", ["doctor", "--platform", "ios", "--ios-family", "all", "--json"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).capacity.availableDevices, ["PHONE", "PAD"]);
  assert.equal(await readFile(env.AMDL_CALL_LOG, "utf8"), "simctl list devices available -j\n");
  assert.equal(existsSync(env.MOBILE_DEVICE_LEASE_DIR), false);
}));

async function personalAdapterStubs(env, bin) {
  await writeFile(join(bin, "device-lease"), `#!/bin/sh\nexec "${process.execPath}" "${join(scripts, "device-lease.mjs")}" "$@"\n`, { mode: 0o755 });
  await writeFile(join(bin, "adb"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AMDL_CALL_LOG"
case "$*" in
  *instrument*) printf '%s\\n' "$AMDL_TEST_OUTPUT" ;;
  *screencap*) printf 'PNG-STUB' ;;
esac
if [ "$AMDL_REPLACE_TOKEN" = 1 ] && [ "$3" = install ]; then
  "${process.execPath}" -e 'const f=require("node:fs"),p=require("node:path");const file=p.join(process.env.MOBILE_DEVICE_LEASE_DIR,"android",process.env.MOBILE_DEVICE_ID+".lock","meta.json");const m=JSON.parse(f.readFileSync(file));m.token="successor";f.writeFileSync(file,JSON.stringify(m));'
fi
`, { mode: 0o755 });
}
const personalExample = join(scripts, "../examples/android-personal-task.mjs");
test("personal adapter keeps installation, tests and screenshots on its captured device", () => fixture(async (root, env, bin) => {
  await personalAdapterStubs(env, bin);
  env.AMDL_TEST_OUTPUT = "OK (2 tests)";
  const shot = join(root, "shot.png");
  const result = await run("device-session.mjs", ["--platform", "android", "--owner", "personal-task", "--no-boot", "--wait-seconds", "0", "--", process.execPath, personalExample, "app.apk", "test.apk", "com.example.app.test/Runner", shot], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(shot, "utf8"), "PNG-STUB");
  const calls = (await readFile(env.AMDL_CALL_LOG, "utf8")).trim().split("\n");
  assert.equal(calls.length, 4);
  assert.ok(calls.every((line) => line.startsWith("-s emulator-5554 ")));
  assert.equal((await readdir(join(env.MOBILE_DEVICE_LEASE_DIR, "android"))).filter((name) => name.endsWith(".lock")).length, 0);
}));

for (const testOutput of ["FAILURES!!! Tests run: 2, Failures: 1", "OK (0 tests)", "INSTRUMENTATION_ABORTED"])
test(`personal adapter rejects unsuccessful instrumentation when adb exits zero: ${testOutput}`, () => fixture(async (root, env, bin) => {
  await personalAdapterStubs(env, bin);
  env.AMDL_TEST_OUTPUT = testOutput;
  const shot = join(root, "shot.png");
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, personalExample, "app.apk", "test.apk", "com.example.app.test/Runner", shot], env);
  assert.equal(result.code, 1);
  assert.equal(existsSync(shot), false);
  assert.doesNotMatch(await readFile(env.AMDL_CALL_LOG, "utf8"), /screencap/);
}));

test("personal adapter cannot install again or capture after a successor takes its generation", () => fixture(async (root, env, bin) => {
  await personalAdapterStubs(env, bin);
  env.AMDL_TEST_OUTPUT = "OK (2 tests)";
  env.AMDL_REPLACE_TOKEN = "1";
  const shot = join(root, "shot.png");
  const result = await run("device-session.mjs", ["--platform", "android", "--no-boot", "--wait-seconds", "0", "--", process.execPath, personalExample, "app.apk", "test.apk", "com.example.app.test/Runner", shot], env);
  assert.equal(result.code, 1);
  assert.equal(existsSync(shot), false);
  assert.equal((await readFile(env.AMDL_CALL_LOG, "utf8")).trim().split("\n").length, 1);
  assert.equal(JSON.parse(await readFile(join(env.MOBILE_DEVICE_LEASE_DIR, "android/emulator-5554.lock/meta.json"), "utf8")).token, "successor");
}));
