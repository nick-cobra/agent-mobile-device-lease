#!/usr/bin/env node
// Copy to a personal location or a project launcher directory. The application
// supplies a built app and simulator-compatible .xctestrun file with real tests.
const [app, xctestrun, bundleId, screenshot] = process.argv.slice(2);
if (!app || !xctestrun || !bundleId || !screenshot || process.env.MOBILE_DEVICE_PLATFORM !== "ios" || !process.env.MOBILE_DEVICE_ADAPTER_MODULE) {
  console.error("Run under device-lease exec or device-session --platform ios: ios-personal-task.mjs <app.app> <tests.xctestrun> <bundle-id> <screenshot.png>");
  process.exit(1);
}
try {
  const { captureDevice } = await import(process.env.MOBILE_DEVICE_ADAPTER_MODULE);
  const device = captureDevice();
  await device.simctl(["bootstatus", "MOBILE_DEVICE", "-b"]);
  await device.simctl(["install", "MOBILE_DEVICE", app]);
  // Parallel testing is disabled to avoid selecting cloned simulators.
  await device.xcodebuild(["test-without-building", "-xctestrun", xctestrun]);
  await device.simctl(["launch", "MOBILE_DEVICE", bundleId]);
  await device.simctl(["io", "MOBILE_DEVICE", "screenshot", screenshot]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
