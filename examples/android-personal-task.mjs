#!/usr/bin/env node
import { writeFileSync } from "node:fs";

// Copy outside application repositories and run under device-lease exec or
// device-session (only for finite unattended work). Build
// the application and its instrumentation APK with the application's commands.
const [appApk, testApk, instrumentation, screenshot] = process.argv.slice(2);
if (!appApk || !testApk || !instrumentation || !screenshot || process.env.MOBILE_DEVICE_PLATFORM !== "android" || !process.env.MOBILE_DEVICE_ADAPTER_MODULE) {
  console.error("Run under device-lease exec or device-session --platform android: android-personal-task.mjs <app.apk> <test.apk> <test-package/runner> <screenshot.png>");
  process.exit(1);
}
try {
  const { captureDevice } = await import(process.env.MOBILE_DEVICE_ADAPTER_MODULE);
  const device = captureDevice();
  await device.adb(["install", "-r", appApk]);
  await device.adb(["install", "-r", "-t", testApk]);
  // adb's process exit status alone does not prove instrumentation success.
  const output = (await device.adb(["shell", "am", "instrument", "-w", instrumentation], { capture: true })).stdout;
  process.stdout.write(output);
  if (!/\bOK \([1-9]\d* tests?\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED|INSTRUMENTATION_ABORTED/.test(output)) {
    throw new Error("Instrumentation did not report a successful test run.");
  }
  writeFileSync(screenshot, (await device.adb(["exec-out", "screencap", "-p"], { capture: true, binary: true })).stdout);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
