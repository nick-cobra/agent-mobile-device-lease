import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { androidRecoveryDecision } from "./lib/device-lease.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const run = (file, args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(scripts, file), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});
async function fixture(fn) {
  const root = await mkdtemp("/tmp/ml-c-");
  const env = { MOBILE_DEVICE_LEASE_DIR: join(root, "l"), MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554", MOBILE_DEVICE_OWNER: "/worktree/test" };
  try { await fn(root, env); } finally { await rm(root, { recursive: true, force: true }); }
}
const acquire = ["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0"];

test("configured legacy prefix preserves acquisition exports and child pins", () => fixture(async (root, env) => {
  env.MOBILE_DEVICE_COMPAT_PREFIX = "LEGACY_DEVICE";
  const result = await run("device-lease.mjs", acquire, env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /export LEGACY_DEVICE_ID='emulator-5554'/);
  assert.match(result.stdout, /export MOBILE_DEVICE_ID='emulator-5554'/);
  const child = await run("device-lease.mjs", ["exec", "--platform", "android", "--", process.execPath, "-e", "process.stdout.write(process.env.LEGACY_DEVICE_ID ?? 'missing')"], env);
  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.stdout, "emulator-5554");
  const placeholder = await run("device-lease.mjs", ["exec", "--platform", "android", "--", "echo", "target=LEGACY_DEVICE"], env);
  assert.equal(placeholder.stdout.trim(), "target=emulator-5554");
}));

test("malformed legacy prefixes fail before allocation", () => fixture(async (root, env) => {
  const result = await run("device-lease.mjs", acquire, { ...env, MOBILE_DEVICE_COMPAT_PREFIX: "BAD;PREFIX" });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /prefix/i);
}));

test("compatibility operands are tokens and do not rewrite partial words or variable names", () => fixture(async (root, env) => {
  env.MOBILE_DEVICE_COMPAT_PREFIX = "LEGACY_DEVICE";
  const acquired = await run("device-lease.mjs", acquire, env);
  assert.equal(acquired.code, 0, acquired.stderr);
  const result = await run("device-lease.mjs", ["exec", "--platform", "android", "--", "echo", "MYLEGACY_DEVICE", "LEGACY_DEVICE_ID", "target=LEGACY_DEVICE"], env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), "MYLEGACY_DEVICE LEGACY_DEVICE_ID target=emulator-5554");
}));

test("protected package prefixes preserve all application variants without matching neighbours", () => {
  const probe = { health: { healthy: true }, emulator: true, blockingDialog: { kind: "anr", packageName: "com.example.club.custom" }, appPackagePrefixes: ["com.example.club"] };
  assert.equal(androidRecoveryDecision(probe).action, "fail-app");
  assert.equal(androidRecoveryDecision({ ...probe, blockingDialog: { kind: "crash", packageName: "com.example.club" } }).action, "fail-app");
  assert.equal(androidRecoveryDecision({ ...probe, blockingDialog: { kind: "anr", packageName: "com.example.clubevil" } }).action, "clear-system-dialog");
});

async function sdkStubs(root, env) {
  const sdk = join(root, "sdk");
  const bin = join(root, "bin");
  await mkdir(join(sdk, "emulator"), { recursive: true });
  await mkdir(join(sdk, "cmdline-tools/latest/bin"), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(sdk, "emulator/emulator"), `#!/bin/sh
if [ "$1" = "-list-avds" ]; then
  printf 'personal-avd\\nlegacy-agent-1\\nlegacy-agent-2\\nmobile-agent-1\\n'
else
  printf '%s\\n' "$*" >> "$AMDL_BOOT_LOG"
  touch "$AMDL_READY"
fi
`, { mode: 0o755 });
  await writeFile(join(sdk, "cmdline-tools/latest/bin/avdmanager"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AMDL_CREATE_LOG"
`, { mode: 0o755 });
  await writeFile(join(bin, "adb"), `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\\n'
  if [ -f "$AMDL_READY" ]; then printf 'emulator-5554\\tdevice\\n'; fi
elif [ "$4" = "getprop" ]; then
  printf '1\\n'
elif [ "$4" = "pm" ]; then
  printf 'package:/system/framework/framework-res.apk\\n'
elif [ "$3" = "emu" ]; then
  printf 'legacy-agent-1\\nOK\\n'
fi
`, { mode: 0o755 });
  return { ...env, MOBILE_DEVICE_FAKE_CAPACITY: "", MOBILE_AVD_POOL_PREFIX: "legacy-agent", ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, ANDROID_AVD_HOME: join(root, "avds"), PATH: bin + ":" + process.env.PATH, AMDL_BOOT_LOG: join(root, "boot.log"), AMDL_CREATE_LOG: join(root, "create.log"), AMDL_READY: join(root, "ready") };
}

test("provisioner reuses the configured existing pool without creating defaults", () => fixture(async (root, env) => {
  const configured = await sdkStubs(root, env);
  const result = await run("provision-android-avds.mjs", ["--size", "2", "--package", "system-images;android-36;google_apis_playstore;arm64-v8a"], configured);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Pool: legacy-agent-1, legacy-agent-2/);
  assert.match(result.stdout, /Nothing to do/);
}));

test("on-demand acquisition boots only the configured spare pool", { timeout: 15000 }, () => fixture(async (root, env) => {
  const configured = await sdkStubs(root, env);
  const result = await run("device-lease.mjs", ["acquire", "--platform", "android", "--wait-seconds", "0", "--json"], configured);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).deviceId, "emulator-5554");
  assert.match(await readFile(configured.AMDL_BOOT_LOG, "utf8"), /-avd legacy-agent-1 /);
}));

test("explicit pool prefix overrides environment and malformed prefixes fail before SDK actions", () => fixture(async (root, env) => {
  const configured = await sdkStubs(root, env);
  const result = await run("provision-android-avds.mjs", ["--avd-prefix", "mobile-agent", "--size", "1", "--package", "system-images;android-36;google_apis_playstore;arm64-v8a"], configured);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Pool: mobile-agent-1/);
  const bad = await run("device-lease.mjs", acquire, { ...env, MOBILE_AVD_POOL_PREFIX: "../personal" });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /pool prefix/);
}));

test("configured package family is preserved through the actual recovery CLI", () => fixture(async (root, env) => {
  const bin = join(root, "recovery-bin");
  await mkdir(bin);
  const log = join(root, "actions.log");
  await writeFile(join(bin, "adb"), `#!/bin/sh
printf '%s\\n' "$*" >> "$AMDL_ACTION_LOG"
case "$*" in
  *getprop*) printf '1\\n' ;;
  *'pm path android'*) printf 'package:/system/framework/framework-res.apk\\n' ;;
  *'dumpsys window windows'*) printf 'mCurrentFocus=Window{1 u0 Application Not Responding: com.example.club.custom}\\n' ;;
esac
`, { mode: 0o755 });
  const configured = { ...env, MOBILE_APP_PACKAGE_PREFIXES: "com.example.club", PATH: bin + ":" + process.env.PATH, AMDL_ACTION_LOG: log };
  const acquired = await run("device-lease.mjs", acquire, configured);
  assert.equal(acquired.code, 0, acquired.stderr);
  const recovery = await run("device-lease.mjs", ["recover", "--platform", "android"], configured);
  assert.equal(recovery.code, 1);
  assert.match(recovery.stderr, /The application is not responding/);
  assert.doesNotMatch(await readFile(log, "utf8"), /force-stop|reboot/);
}));
