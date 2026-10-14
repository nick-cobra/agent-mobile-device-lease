#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

// Copy outside application repositories and run under device-session. Build
// the application and its instrumentation APK with the application's commands.
const [appApk, testApk, instrumentation, screenshot] = process.argv.slice(2);
const { MOBILE_DEVICE_ID: serial, MOBILE_DEVICE_TOKEN: token, MOBILE_DEVICE_OWNER: owner, MOBILE_DEVICE_PLATFORM: platform } = process.env;
if (!appApk || !testApk || !instrumentation || !screenshot || platform !== "android" || !serial || !token || !owner) {
  console.error("Run under device-session --platform android: android-personal-task.mjs <app.apk> <test.apk> <test-package/runner> <screenshot.png>");
  process.exit(1);
}
function sdk(args, capture = false) {
  // Each operation renews and checks the same captured owner/generation. An old
  // adapter cannot adopt a new token if another task replaces its lease.
  const result = spawnSync("device-lease", ["exec", "--platform", "android", "--owner", owner, "--token", token, "--", "adb", "-s", serial, ...args], {
    env: process.env, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Leased SDK operation failed (exit ${result.status ?? result.signal}).`);
  return result.stdout;
}
try {
  sdk(["install", "-r", appApk]);
  sdk(["install", "-r", "-t", testApk]);
  // adb's process exit status alone does not prove instrumentation success.
  const output = sdk(["shell", "am", "instrument", "-w", instrumentation], true).toString("utf8");
  process.stdout.write(output);
  if (!/\bOK \([1-9]\d* tests?\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED/.test(output)) {
    throw new Error("Instrumentation did not report a successful test run.");
  }
  writeFileSync(screenshot, sdk(["exec-out", "screencap", "-p"], true));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
