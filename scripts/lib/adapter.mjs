import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { isPlatform, resolveLeaseRoot } from "./device-lease.mjs";
import { runChild } from "./run-child.mjs";

const cli = fileURLToPath(new URL("../device-lease.mjs", import.meta.url));

// Capture once at adapter startup, never rediscover a token from the registry.
// Every operation goes through this installed CLI's existing supervisor.
export function captureDevice({ env = process.env } = {}) {
  const { MOBILE_DEVICE_PLATFORM: platform, MOBILE_DEVICE_ID: deviceId, MOBILE_DEVICE_OWNER: owner, MOBILE_DEVICE_TOKEN: token } = env;
  if (!isPlatform(platform) || !deviceId || !owner || !token) throw new Error("Run the adapter under device-lease exec or device-session with a captured platform, owner, device and token.");
  for (const name of platform === "android" ? ["ANDROID_SERIAL", "ADB_DEVICE_SERIAL"] : ["IOS_SIMULATOR"]) {
    if (env[name] && env[name] !== deviceId) throw new Error(`Conflicting ${name}; it does not match the captured leased device.`);
  }
  const ttl = env.MOBILE_DEVICE_TTL_MINUTES;
  if (ttl !== undefined && (!Number.isFinite(Number(ttl)) || Number(ttl) < 1)) throw new Error("Invalid captured lease TTL.");
  const snapshot = Object.freeze({ ...env, MOBILE_DEVICE_LEASE_DIR: resolve(resolveLeaseRoot(env, homedir())) });
  const identity = Object.freeze({ platform, deviceId, owner, token, registry: snapshot.MOBILE_DEVICE_LEASE_DIR });
  const run = async (command, args, { capture = false, binary = false } = {}) => {
    if (typeof command !== "string" || !Array.isArray(args) || !args.every(arg => typeof arg === "string")) throw new Error("Adapter commands require a command and string arguments.");
    const flags = [cli, "exec", "--platform", platform, "--owner", owner, "--token", token];
    if (ttl !== undefined) flags.push("--ttl-minutes", ttl);
    const result = await runChild(process.execPath, [...flags, "--", command, ...args], { env: snapshot, capture, binary, maxBuffer: 32 * 1024 * 1024 });
    if (result.code !== 0) {
      const error = new Error(`Leased SDK operation failed (exit ${result.code}).${result.stderr ? `\n${result.stderr}` : ""}`);
      error.code = result.code;
      throw error;
    }
    return result;
  };
  const requirePlatform = expected => { if (platform !== expected) throw new Error(`This adapter holds a ${platform} lease, not ${expected}.`); };
  return Object.freeze({
    identity,
    // Arbitrary launchers still need to honour the pin internally.
    run,
    adb(args, options) { requirePlatform("android"); return run("adb", ["-s", deviceId, ...args], options); },
    simctl(args, options) { requirePlatform("ios"); return run("xcrun", ["simctl", ...args], options); },
    xcodebuild(args, options) {
      requirePlatform("ios");
      if (!Array.isArray(args) || args[0] !== "test-without-building" || !args.includes("-xctestrun")) throw new Error("Use test-without-building with an application-provided -xctestrun file.");
      if (args.some(arg => /^-(?:destination|parallel-testing-enabled)(?:=|$)/.test(arg))) throw new Error("The adapter owns the XCTest destination and parallel testing settings.");
      return run("xcodebuild", [...args, "-destination", `platform=iOS Simulator,id=${deviceId}`, "-parallel-testing-enabled", "NO"], options);
    },
  });
}
