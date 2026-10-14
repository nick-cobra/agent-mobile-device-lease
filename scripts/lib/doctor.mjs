import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { androidTool, findExecutable } from "./sdk-tools.mjs";
import { DEFAULT_TTL_MINUTES, isExpired, isLocalEmulatorSerial, parseAdbDevices, parseAvdNames, parseSimctlIphones } from "./device-lease.mjs";
import { readLeases } from "./device-lease-store.mjs";

export function doctorReport({ platform, leaseRoot, owner, avdPoolPrefix, iosFamily = "iphone", env = process.env }) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });
  const registry = resolve(leaseRoot);
  try {
    let parent = registry;
    while (!existsSync(parent) && dirname(parent) !== parent) parent = dirname(parent);
    if (!statSync(parent).isDirectory()) throw new Error(`${parent} is not a directory`);
    accessSync(parent, constants.W_OK | constants.X_OK);
    const socketLength = Buffer.byteLength(join(registry, platform, ".lease-op.sock"));
    if (socketLength > (process.platform === "darwin" ? 103 : 107)) throw new Error("Registry socket path is too long; choose a short local path");
    check("registry", true, `${registry}; existing parent ${parent} is writable (no directory created)`);
  } catch (error) { check("registry", false, error.message); }

  const probe = (name, path, args) => {
    if (!path) { check(name, false, `Missing executable ${name}; check SDK installation and PATH`); return null; }
    if (!args) { check(name, true, path); return ""; }
    const result = spawnSync(path, args, { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) { check(name, false, `${path}: ${result.error?.message ?? `command exited ${result.status}`}`); return null; }
    check(name, true, path);
    return result.stdout;
  };
  let liveLeases = [];
  try {
    liveLeases = readLeases(registry, platform).filter((lease) => !isExpired(lease, Date.now(), DEFAULT_TTL_MINUTES * 60000));
  } catch (error) { check("lease inventory", false, error.message); }
  const held = new Set(liveLeases.map((lease) => lease.deviceId));
  let capacity;
  if (platform === "android") {
    // The lease engine and arbitrary child launchers invoke adb from PATH.
    const devices = probe("adb", findExecutable("adb", { env }), ["devices", "-l"]);
    const avds = probe("emulator", androidTool("emulator", env), ["-list-avds"]);
    probe("avdmanager", androidTool("avdmanager", env));
    const poolAvds = parseAvdNames(avds).filter((name) => name.startsWith(`${avdPoolPrefix}-`));
    const runningDevices = parseAdbDevices(devices).filter(isLocalEmulatorSerial);
    capacity = { poolPrefix: avdPoolPrefix, poolAvds, runningDevices, availableRunningDevices: runningDevices.filter((id) => !held.has(id)), heldDevices: [...held] };
    check("capacity", poolAvds.length + runningDevices.length > 0, `${poolAvds.length} configured pool AVDs; ${runningDevices.length} ready emulators; ${capacity.availableRunningDevices.length} ready and unleased. Counts may overlap; stopped AVDs are not boot-tested.`);
  } else {
    const inventory = probe("xcrun", findExecutable("xcrun", { env }), ["simctl", "list", "devices", "available", "-j"]);
    let devices = [];
    try {
      if (inventory === null || !JSON.parse(inventory)?.devices) throw new Error("No valid simulator inventory");
      devices = parseSimctlIphones(inventory, iosFamily);
    } catch (error) { check("simulator inventory", false, error.message); }
    capacity = { family: iosFamily, devices: devices.map(({ udid, name, state }) => ({ id: udid, name, state })), availableDevices: devices.filter(({ udid }) => !held.has(udid)).map(({ udid }) => udid), heldDevices: [...held] };
    check("capacity", devices.length > 0, `${devices.length} available simulators; ${capacity.availableDevices.length} unleased (not boot-tested).`);
  }
  return { ok: checks.every((entry) => entry.ok), platform, registry, owner, checks, capacity };
}
