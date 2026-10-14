import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  AVD_POOL_PREFIX,
  DEFAULT_TTL_MINUTES,
  PINNED_SYSTEM_IMAGE_PACKAGE,
  PLATFORMS,
  androidRecoveryDecision,
  assessAndroidDeviceHealth,
  avdPoolNames,
  bootableAvdCandidates,
  canPreferPhysicalAndroidDevice,
  classifyAndroidDeviceProps,
  findPhysicalAndroidDevices,
  formatAge,
  formatExportLines,
  hasPinnedSystemImage,
  isExpired,
  isPlatform,
  isEmulatorProps,
  isLocalEmulatorSerial,
  parseAdbDevices,
  parseAndroidBlockingDialog,
  physicalLeaseMarker,
  selectAndroidEmulatorProcess,
  selectLeasableAndroidSerials,
  parseAvdNames,
  parseAvdPath,
  resolveAvdHome,
  parseSimctlIphones,
  planAcquisition,
  resolveLeaseRoot,
  sameAndroidEmulatorProcess,
  shellQuote,
  toSystemImagePackage,
  withHardwareKeyboard,
} from "./lib/device-lease.mjs";
import { leasedDeviceFor } from "./lib/device-lease-store.mjs";

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "device-lease.mjs");
const HOUR_MS = 60 * 60 * 1000;

describe("emulator identification", () => {
  it("accepts a local emulator serial and rejects a handset serial", () => {
    assert.equal(isLocalEmulatorSerial("emulator-5554"), true);
    assert.equal(
      isLocalEmulatorSerial("bef90f05"),
      false,
      "Developer's phone must never look like an emulator",
    );
  });

  it("does not treat a network-attached device as an emulator on its serial alone", () => {
    assert.equal(isLocalEmulatorSerial("127.0.0.1:5555"), false);
    assert.equal(isLocalEmulatorSerial(undefined), false);
    assert.equal(isLocalEmulatorSerial(""), false);
  });

  it("reads the emulator markers getprop reports", () => {
    assert.equal(isEmulatorProps({ kernelQemu: "1" }), true);
    assert.equal(isEmulatorProps({ characteristics: "emulator" }), true);
    assert.equal(
      isEmulatorProps({ characteristics: "nosdcard,emulator" }),
      true,
      "a list must be split, not matched whole",
    );
  });

  it("lets the local launcher prefer positively identified hardware", () => {
    assert.deepEqual(
      findPhysicalAndroidDevices(["emulator-5554", "bef90f05", "emulator-5556"], (serial) =>
        serial === "bef90f05" ? "physical" : "emulator",
      ),
      ["bef90f05"],
    );
  });

  it("does not treat unknown targets as physical devices", () => {
    assert.deepEqual(
      findPhysicalAndroidDevices(["unknown-target", "emulator-5554"], (serial) =>
        serial === "unknown-target" ? "unknown" : "emulator",
      ),
      [],
    );
  });

  it("recognises a physical device when a successful qemu probe is blank", () => {
    assert.equal(
      classifyAndroidDeviceProps({
        kernelQemu: "",
        characteristics: "nosdcard",
      }),
      "physical",
    );
    assert.equal(classifyAndroidDeviceProps({ kernelQemu: "", characteristics: "" }), "unknown");
  });

  it("keeps the launcher ambiguous with multiple physical or unknown targets", () => {
    assert.equal(
      canPreferPhysicalAndroidDevice({ deviceCount: 3, physicalCount: 2, unknownCount: 0 }),
      false,
    );
    assert.equal(
      canPreferPhysicalAndroidDevice({ deviceCount: 2, physicalCount: 1, unknownCount: 1 }),
      false,
    );
    assert.equal(
      canPreferPhysicalAndroidDevice({ deviceCount: 3, physicalCount: 1, unknownCount: 0 }),
      true,
    );
  });

  it("FAILS CLOSED when the device cannot be identified", () => {
    assert.equal(isEmulatorProps({}), false);
    assert.equal(isEmulatorProps(), false);
    assert.equal(isEmulatorProps({ kernelQemu: "", characteristics: "" }), false);
    assert.equal(isEmulatorProps({ kernelQemu: "0", characteristics: "default" }), false);
    assert.equal(isEmulatorProps({ kernelQemu: undefined, characteristics: "nosdcard" }), false);
  });
});

describe("Android device health", () => {
  it("requires both completed boot and a responsive package service", () => {
    assert.deepEqual(
      assessAndroidDeviceHealth({
        bootCompleted: "1\n",
        packagePath: "package:/system/framework/framework-res.apk\n",
      }),
      { healthy: true, reason: "ready" },
    );
  });

  it("rejects an attached emulator whose boot has not completed", () => {
    assert.deepEqual(
      assessAndroidDeviceHealth({ bootCompleted: "0", packagePath: "package:/system/app.apk" }),
      {
        healthy: false,
        reason: "Android boot has not completed",
      },
    );
  });

  it("rejects the package-service failure seen during visual capture", () => {
    assert.deepEqual(assessAndroidDeviceHealth({ bootCompleted: "1", packagePath: null }), {
      healthy: false,
      reason: "Android package service is unavailable",
    });
    assert.equal(
      assessAndroidDeviceHealth({
        bootCompleted: "1",
        packagePath: "cmd: Can't find service: package",
      }).healthy,
      false,
    );
  });
});

describe("leased Android runtime recovery", () => {
  it("identifies the package behind the active system ANR dialog", () => {
    assert.deepEqual(
      parseAndroidBlockingDialog({
        windowDump:
          "mCurrentFocus=Window{42 u0 Application Not Responding: com.google.android.apps.wellbeing}",
        lastAnr: "Process: com.google.android.apps.wellbeing\nReason: Input dispatching timed out",
      }),
      {
        kind: "anr",
        packageName: "com.google.android.apps.wellbeing",
      },
    );
  });

  it("fails closed when the focused ANR title contains only an app label", () => {
    assert.deepEqual(
      parseAndroidBlockingDialog({
        windowDump: "mCurrentFocus=Window{17 u0 Digital Wellbeing isn’t responding}",
        lastAnr: "Process: com.google.android.apps.wellbeing\nPID: 123",
      }),
      {
        kind: "anr",
        packageName: null,
      },
    );
  });

  it("ignores historical error-window records when the current focus is healthy", () => {
    assert.equal(
      parseAndroidBlockingDialog({
        windowDump:
          "Window #4 Window{17 u0 Application Not Responding: com.example.app.debug}\n" +
          "mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}",
        lastAnr: "Process: com.example.app.debug\nPID: 123",
      }),
      null,
    );
  });

  it("never assigns a crash dialog to lastanr history", () => {
    assert.deepEqual(
      parseAndroidBlockingDialog({
        windowDump: "mCurrentFocus=Window{17 u0 Digital Wellbeing keeps stopping}",
        lastAnr: "Process: com.example.app.debug\nPID: 123",
      }),
      { kind: "crash", packageName: null },
    );
  });

  it("does not treat a historical lastanr as a current blocker", () => {
    assert.equal(
      parseAndroidBlockingDialog({
        windowDump: "mCurrentFocus=Window{1 u0 com.example.app.debug/com.example.app.MainActivity}",
        lastAnr: "Process: com.example.app.debug\nPID: 123",
      }),
      null,
    );
  });

  it("clears an unrelated system ANR before escalating to a reboot", () => {
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: {
          kind: "anr",
          packageName: "com.google.android.apps.nexuslauncher",
        },
        emulator: true,
      }),
      {
        action: "clear-system-dialog",
        packageName: "com.google.android.apps.nexuslauncher",
      },
    );
  });

  it("never hides an application ANR by rebooting the emulator", () => {
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: { kind: "anr", packageName: "com.example.app.debug" },
        emulator: true,
      }),
      {
        action: "fail-app",
        packageName: "com.example.app.debug",
      },
    );
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: { kind: "anr", packageName: null },
        emulator: true,
        forceReboot: true,
      }),
      { action: "fail-unknown-app" },
    );
  });

  it("reboots only emulators when runtime health fails or restart is explicit", () => {
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: false, reason: "Android package service is unavailable" },
        blockingDialog: null,
        emulator: true,
      }),
      { action: "reboot", reason: "Android package service is unavailable" },
    );
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: {
          kind: "anr",
          packageName: "com.google.android.apps.wellbeing",
        },
        emulator: true,
        forceReboot: true,
      }),
      { action: "reboot", reason: "restart requested" },
    );
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: null,
        emulator: false,
        forceReboot: true,
      }),
      { action: "refuse-hardware" },
    );
    assert.deepEqual(
      androidRecoveryDecision({
        appPackages: ["com.example.app", "com.example.app.debug"],
        health: { healthy: true, reason: "ready" },
        blockingDialog: null,
        emulator: true,
      }),
      { action: "healthy" },
    );
  });

  it("maps a leased serial to one proven emulator process and installed AVD", () => {
    assert.deepEqual(
      selectAndroidEmulatorProcess({
        serial: "emulator-5554",
        listenerPids: ["64606", "64606", "99"],
        processCommands: {
          64606:
            "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd mobile-agent-1 -no-boot-anim",
          99: "/usr/bin/unrelated -avd mobile-agent-1",
        },
        processExecutables: {
          64606: "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64",
          99: "/usr/bin/unrelated",
        },
        processStartTimes: { 64606: "Thu Aug 27 07:00:00 2026", 99: "old" },
        canonicalEmulatorDir: "/sdk/emulator",
        availableAvdNames: ["mobile-agent-1", "mobile-agent-2"],
      }),
      {
        pid: 64606,
        port: 5554,
        avdName: "mobile-agent-1",
        executablePath: "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64",
        startTime: "Thu Aug 27 07:00:00 2026",
      },
    );
    assert.equal(
      selectAndroidEmulatorProcess({
        serial: "phone-1",
        listenerPids: ["64606"],
        processCommands: {
          64606: "/sdk/emulator/qemu-system-aarch64 -avd mobile-agent-1",
        },
        availableAvdNames: ["mobile-agent-1"],
      }),
      null,
    );

    assert.equal(
      selectAndroidEmulatorProcess({
        serial: "emulator-5554",
        listenerPids: ["64606"],
        processCommands: { 64606: "/tmp/emulator -avd mobile-agent-1" },
        processExecutables: { 64606: "/tmp/emulator" },
        processStartTimes: { 64606: "Thu Aug 27 07:00:00 2026" },
        canonicalEmulatorDir: "/sdk/emulator",
        availableAvdNames: ["mobile-agent-1"],
      }),
      null,
      "a lookalike executable outside the canonical SDK must never be signalled",
    );

    const identity = {
      pid: 64606,
      port: 5554,
      avdName: "mobile-agent-1",
      executablePath: "/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64",
      startTime: "Thu Aug 27 07:00:00 2026",
    };
    assert.equal(sameAndroidEmulatorProcess(identity, { ...identity }), true);
    assert.equal(
      sameAndroidEmulatorProcess(identity, {
        ...identity,
        startTime: "Thu Aug 27 07:00:01 2026",
      }),
      false,
      "PID reuse must invalidate the proof before signalling",
    );
  });
});

describe("selectLeasableAndroidSerials", () => {
  const PHONE = "bef90f05";
  const EMULATOR = "emulator-5554";
  const props = (map) => (serial) => map[serial] ?? {};

  it("drops a physical handset and keeps the emulator when both are attached", () => {
    const { leasable, rejected } = selectLeasableAndroidSerials(
      [PHONE, EMULATOR],
      props({ [PHONE]: { characteristics: "nosdcard" } }),
    );

    assert.deepEqual(leasable, [EMULATOR]);
    assert.deepEqual(rejected, [PHONE], "the phone must be reported so the caller can name it");
  });

  it("returns nothing leasable when only hardware is attached", () => {
    const { leasable, rejected } = selectLeasableAndroidSerials(
      [PHONE],
      props({ [PHONE]: { kernelQemu: "0", characteristics: "nosdcard" } }),
    );

    assert.deepEqual(leasable, []);
    assert.deepEqual(rejected, [PHONE]);
  });

  it("keeps a network-attached emulator that getprop identifies", () => {
    const REMOTE = "127.0.0.1:5555";
    const { leasable } = selectLeasableAndroidSerials(
      [REMOTE],
      props({ [REMOTE]: { kernelQemu: "1" } }),
    );

    assert.deepEqual(leasable, [REMOTE]);
  });

  it("drops a device whose props cannot be read", () => {
    const { leasable, rejected } = selectLeasableAndroidSerials([PHONE], () => undefined);

    assert.deepEqual(leasable, [], "unreadable must not mean leasable");
    assert.deepEqual(rejected, [PHONE]);
  });

  it("returns hardware only when --allow-physical is passed", () => {
    const { leasable, rejected } = selectLeasableAndroidSerials([PHONE, EMULATOR], props({}), {
      allowPhysical: true,
    });

    assert.deepEqual(leasable, [PHONE, EMULATOR]);
    assert.deepEqual(rejected, []);
  });
});

describe("physicalLeaseMarker", () => {
  it("records a hardware lease so a forbidden-by-default run leaves a trail", () => {
    assert.deepEqual(physicalLeaseMarker({ allowPhysical: true, deviceId: "bef90f05" }), {
      physical: true,
    });
  });

  it("does not stamp an emulator leased while the flag happened to be set", () => {
    assert.deepEqual(physicalLeaseMarker({ allowPhysical: true, deviceId: "emulator-5554" }), {});
  });

  it("adds nothing to an ordinary lease", () => {
    assert.deepEqual(physicalLeaseMarker({ deviceId: "emulator-5554" }), {});
    assert.deepEqual(physicalLeaseMarker(), {});
  });
});

describe("parseAdbDevices", () => {
  it("skips the banner and returns only fully-online serials", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554\tdevice",
      "emulator-5556\tdevice",
      "",
    ].join("\n");

    assert.deepEqual(parseAdbDevices(stdout), ["emulator-5554", "emulator-5556"]);
  });

  it("excludes devices that cannot take an install", () => {
    const stdout = [
      "List of devices attached",
      "emulator-5554\toffline",
      "RF8N90ABCDE\tunauthorized",
      "emulator-5556\tdevice",
    ].join("\n");

    assert.deepEqual(parseAdbDevices(stdout), ["emulator-5556"]);
  });

  it("returns an empty pool for no devices or no output", () => {
    assert.deepEqual(parseAdbDevices("List of devices attached\n\n"), []);
    assert.deepEqual(parseAdbDevices(""), []);
    assert.deepEqual(parseAdbDevices(null), []);
  });
});

describe("parseSimctlIphones", () => {
  const json = JSON.stringify({
    devices: {
      "com.apple.CoreSimulator.SimRuntime.iOS-26-0": [
        { udid: "UDID-1", name: "iPhone 17 Pro", state: "Booted", isAvailable: true },
        { udid: "UDID-2", name: "iPhone Air", state: "Shutdown", isAvailable: true },
        { udid: "UDID-3", name: "iPhone 16e", state: "Shutdown", isAvailable: false },
        { udid: "UDID-4", name: "iPad Pro 13-inch (M4)", state: "Shutdown", isAvailable: true },
      ],
    },
  });

  it("returns available iPhones across runtimes", () => {
    assert.deepEqual(parseSimctlIphones(json), [
      { udid: "UDID-1", name: "iPhone 17 Pro", state: "Booted" },
      { udid: "UDID-2", name: "iPhone Air", state: "Shutdown" },
    ]);
  });

  it("can explicitly select iPads for store captures without widening the default phone pool", () => {
    assert.deepEqual(parseSimctlIphones(json, "ipad"), [
      { udid: "UDID-4", name: "iPad Pro 13-inch (M4)", state: "Shutdown" },
    ]);
    assert.equal(parseSimctlIphones(json, "all").length, 3);
    assert.throws(() => parseSimctlIphones(json, "tablet"), /family/i);
  });

  it("includes shutdown simulators because the launcher boots on demand", () => {
    const shutdown = parseSimctlIphones(json).filter((device) => device.state === "Shutdown");
    assert.equal(shutdown.length, 1);
  });

  it("returns an empty pool for malformed output", () => {
    assert.deepEqual(parseSimctlIphones("not json"), []);
    assert.deepEqual(parseSimctlIphones(""), []);
  });
});

describe("parseAvdNames", () => {
  it("drops blank lines and SDK banner noise", () => {
    const stdout = ["INFO    | Storing crashdata", "mobile-agent-1", "", "mobile-agent-2"].join("\n");
    assert.deepEqual(parseAvdNames(stdout), ["mobile-agent-1", "mobile-agent-2"]);
  });
});

describe("resolveLeaseRoot", () => {
  it("prefers an explicit override", () => {
    assert.equal(resolveLeaseRoot({ MOBILE_DEVICE_LEASE_DIR: "/tmp/x" }, "/home/developer"), "/tmp/x");
  });

  it("honours XDG_STATE_HOME, then falls back to the home directory", () => {
    assert.equal(
      resolveLeaseRoot({ XDG_STATE_HOME: "/state" }, "/home/developer"),
      "/state/shared-mobile/device-leases",
    );
    assert.equal(resolveLeaseRoot({}, "/home/developer"), "/home/developer/.local/state/shared-mobile/device-leases");
  });

  it("never resolves inside the repository", () => {
    const root = resolveLeaseRoot({}, "/home/developer");
    assert.ok(!root.includes("/project/worktrees"));
  });
});

describe("isExpired", () => {
  const ttl = 4 * HOUR_MS;
  const now = Date.parse("2026-07-31T12:00:00.000Z");

  it("keeps a fresh lease", () => {
    assert.equal(isExpired({ acquiredAt: "2026-07-31T11:00:00.000Z" }, now, ttl), false);
  });

  it("expires a lease at or past the TTL", () => {
    assert.equal(isExpired({ acquiredAt: "2026-07-31T08:00:00.000Z" }, now, ttl), true);
    assert.equal(isExpired({ acquiredAt: "2026-07-31T07:00:00.000Z" }, now, ttl), true);
  });

  it("honours the holder's stored expiry over the contender's TTL", () => {
    const lease = { acquiredAt: "2026-07-31T11:00:00.000Z", expiresAt: "2026-07-31T15:00:00.000Z" };

    assert.equal(isExpired(lease, now, 0), false);
    assert.equal(isExpired(lease, now, -1), false);
  });

  it("expires once the holder's own stored expiry has passed", () => {
    const lease = { acquiredAt: "2026-07-31T02:00:00.000Z", expiresAt: "2026-07-31T06:00:00.000Z" };
    assert.equal(isExpired(lease, now, 99 * HOUR_MS), true);
  });

  it("falls back to the TTL for leases written before expiresAt existed", () => {
    assert.equal(isExpired({ acquiredAt: "2026-07-31T11:00:00.000Z" }, now, ttl), false);
    assert.equal(isExpired({ acquiredAt: "2026-07-31T02:00:00.000Z" }, now, ttl), true);
  });

  it("treats an unreadable timestamp as reclaimable", () => {
    assert.equal(isExpired({ acquiredAt: null }, now, ttl), true);
    assert.equal(isExpired({ acquiredAt: "garbage" }, now, ttl), true);
    assert.equal(isExpired({}, now, ttl), true);
  });
});

describe("planAcquisition", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");
  const ttl = 4 * HOUR_MS;
  const fresh = "2026-07-31T11:59:00.000Z";
  const stale = "2026-07-31T04:00:00.000Z";

  it("claims a free device when nothing is held", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5554", "emulator-5556"],
      leases: [],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.deepEqual(plan, { action: "claim", deviceId: "emulator-5554" });
  });

  it("skips devices held by other owners", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5554", "emulator-5556"],
      leases: [{ deviceId: "emulator-5554", owner: "/w/b", acquiredAt: fresh }],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.equal(plan.deviceId, "emulator-5556");
  });

  it("is reentrant: the same owner gets the same device back", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5554", "emulator-5556"],
      leases: [{ deviceId: "emulator-5556", owner: "/w/a", acquiredAt: fresh }],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.deepEqual(plan, { action: "reuse", deviceId: "emulator-5556" });
  });

  it("does not reuse its own lease on a device that has left the pool", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5556"],
      leases: [{ deviceId: "emulator-5554", owner: "/w/a", acquiredAt: fresh }],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.deepEqual(plan, { action: "claim", deviceId: "emulator-5556" });
  });

  it("treats an expired lease as free capacity", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5554"],
      leases: [{ deviceId: "emulator-5554", owner: "/w/b", acquiredAt: stale }],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.deepEqual(plan, { action: "claim", deviceId: "emulator-5554" });
  });

  it("waits, naming the holders, when every device is live-held by others", () => {
    const plan = planAcquisition({
      capacityIds: ["emulator-5554", "emulator-5556"],
      leases: [
        { deviceId: "emulator-5554", owner: "/w/b", acquiredAt: fresh },
        { deviceId: "emulator-5556", owner: "/w/c", acquiredAt: fresh },
      ],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.equal(plan.action, "wait");
    assert.equal(plan.deviceId, null);
    assert.deepEqual(plan.blockedBy.sort(), ["emulator-5554", "emulator-5556"]);
  });

  it("waits rather than claiming when capacity is empty", () => {
    const plan = planAcquisition({
      capacityIds: [],
      leases: [],
      owner: "/w/a",
      nowMs: now,
      ttlMs: ttl,
    });

    assert.equal(plan.action, "wait");
  });
});

describe("shellQuote", () => {
  it("quotes values so eval cannot split or expand them", () => {
    assert.equal(shellQuote("iPhone 17 Pro"), "'iPhone 17 Pro'");
    assert.equal(shellQuote("emulator-5554"), "'emulator-5554'");
  });

  it("neutralises metacharacters and command substitution", () => {
    assert.equal(shellQuote("a; touch /tmp/pwned"), "'a; touch /tmp/pwned'");
    assert.equal(shellQuote("$(id)"), "'$(id)'");
    assert.equal(shellQuote("`id`"), "'`id`'");
  });

  it("escapes an embedded single quote, the one character quoting cannot hold", () => {
    assert.equal(shellQuote("Developer's iPhone"), `'Developer'\\''s iPhone'`);
  });
});

describe("formatExportLines", () => {
  it("pins bare adb calls as well as the launcher flag on Android", () => {
    const lines = formatExportLines({ platform: "android", deviceId: "emulator-5556" });

    assert.ok(lines.includes("ANDROID_SERIAL='emulator-5556'"));
    assert.ok(lines.includes("ADB_DEVICE_SERIAL='emulator-5556'"));
    assert.ok(lines.includes("MOBILE_DEVICE_ID='emulator-5556'"));
  });

  it("emits the simulator pin on iOS and no adb variables", () => {
    const lines = formatExportLines({ platform: "ios", deviceId: "UDID-2", name: "iPhone Air" });

    assert.ok(lines.includes("IOS_SIMULATOR='UDID-2'"));
    assert.ok(lines.includes("MOBILE_DEVICE_NAME='iPhone Air'"));
    assert.ok(!lines.some((line) => line.startsWith("ANDROID_SERIAL=")));
  });

  it("quotes every emitted value, not just the ones that look risky", () => {
    const lines = formatExportLines({
      platform: "ios",
      deviceId: "UDID-2",
      name: "iPhone 17 Pro",
    });

    for (const line of lines) {
      assert.match(line, /^[A-Z_]+='.*'$/);
    }
  });
});
describe("leasedDeviceFor", () => {
  const fallbackTtlMs = 4 * HOUR_MS;

  async function withLeases(entries, run) {
    const leaseRoot = await mkdtemp(path.join(tmpdir(), "mobile-store-"));
    try {
      for (const entry of entries) {
        const lockDir = path.join(leaseRoot, "android", `${entry.deviceId}.lock`);
        await mkdir(lockDir, { recursive: true });
        await writeFile(path.join(lockDir, "meta.json"), JSON.stringify(entry));
      }
      return await run(leaseRoot);
    } finally {
      await rm(leaseRoot, { recursive: true, force: true });
    }
  }

  const future = new Date(Date.now() + 2 * HOUR_MS).toISOString();
  const past = new Date(Date.now() - 2 * HOUR_MS).toISOString();

  it("returns the device this owner holds", async () => {
    await withLeases(
      [
        { deviceId: "emulator-5554", owner: "/w/other", expiresAt: future },
        { deviceId: "emulator-5556", owner: "/w/mine", expiresAt: future },
      ],
      async (leaseRoot) => {
        const found = leasedDeviceFor({
          leaseRoot,
          platform: "android",
          owner: "/w/mine",
          nowMs: Date.now(),
          fallbackTtlMs,
        });

        assert.equal(found, "emulator-5556");
      },
    );
  });

  it("ignores an expired lease of this owner's", async () => {
    await withLeases(
      [{ deviceId: "emulator-5554", owner: "/w/mine", expiresAt: past }],
      async (leaseRoot) => {
        const found = leasedDeviceFor({
          leaseRoot,
          platform: "android",
          owner: "/w/mine",
          nowMs: Date.now(),
          fallbackTtlMs,
        });

        assert.equal(found, null);
      },
    );
  });

  it("returns null when this owner holds nothing", async () => {
    await withLeases(
      [{ deviceId: "emulator-5554", owner: "/w/other", expiresAt: future }],
      async (leaseRoot) => {
        assert.equal(
          leasedDeviceFor({
            leaseRoot,
            platform: "android",
            owner: "/w/mine",
            nowMs: Date.now(),
            fallbackTtlMs,
          }),
          null,
        );
      },
    );
  });

  it("returns null when nothing has ever been leased", () => {
    assert.equal(
      leasedDeviceFor({
        leaseRoot: path.join(tmpdir(), "mobile-store-does-not-exist"),
        platform: "android",
        owner: "/w/mine",
        nowMs: Date.now(),
        fallbackTtlMs,
      }),
      null,
    );
  });
});

describe("formatAge", () => {
  const now = Date.parse("2026-07-31T12:00:00.000Z");

  it("renders minutes below an hour and h/m above", () => {
    assert.equal(formatAge({ acquiredAt: "2026-07-31T11:30:00.000Z" }, now), "30m");
    assert.equal(formatAge({ acquiredAt: "2026-07-31T09:15:00.000Z" }, now), "2h45m");
  });

  it("does not crash on a corrupt timestamp", () => {
    assert.equal(formatAge({ acquiredAt: null }, now), "unknown");
  });
});

describe("platform validation", () => {
  it("accepts only the supported platforms", () => {
    assert.deepEqual(PLATFORMS, ["android", "ios"]);
    assert.ok(isPlatform("android"));
    assert.ok(isPlatform("ios"));
    assert.ok(!isPlatform("web"));
    assert.ok(!isPlatform(undefined));
  });

  it("defaults the TTL long enough to outlive an agent session", () => {
    assert.ok(DEFAULT_TTL_MINUTES >= 120);
  });
});

describe("android AVD pool", () => {
  it("names a stable, ordered pool", () => {
    assert.deepEqual(avdPoolNames(3), ["mobile-agent-1", "mobile-agent-2", "mobile-agent-3"]);
    assert.deepEqual(avdPoolNames(0), []);
    assert.ok(avdPoolNames(1)[0].startsWith(AVD_POOL_PREFIX));
  });

  it("builds the avdmanager package id", () => {
    assert.equal(
      toSystemImagePackage({ api: "android-36", tag: "google_apis_playstore", abi: "arm64-v8a" }),
      "system-images;android-36;google_apis_playstore;arm64-v8a",
    );
  });

  it("pins the pool to a system image that has been booted, not the newest installed", () => {
    assert.equal(
      hasPinnedSystemImage([
        { api: "android-36", tag: "google_apis_playstore", abi: "arm64-v8a" },
        { api: "android-37.0", tag: "google_apis_ps16k", abi: "arm64-v8a" },
      ]),
      true,
    );
    assert.equal(
      PINNED_SYSTEM_IMAGE_PACKAGE,
      "system-images;android-36;google_apis_playstore;arm64-v8a",
    );
  });

  it("reports the pinned image as missing when only other images are installed", () => {
    assert.equal(
      hasPinnedSystemImage([
        { api: "android-37.0", tag: "google_apis_ps16k", abi: "arm64-v8a" },
        { api: "android-35", tag: "google_apis_playstore", abi: "arm64-v8a" },
      ]),
      false,
    );
    assert.equal(hasPinnedSystemImage([]), false);
  });

  it("matches the pin on the full triple, not the API level alone", () => {
    assert.equal(
      hasPinnedSystemImage([{ api: "android-36", tag: "google_apis", abi: "arm64-v8a" }]),
      false,
    );
    assert.equal(
      hasPinnedSystemImage([{ api: "android-36", tag: "google_apis_playstore", abi: "x86_64" }]),
      false,
    );
  });

  it("only ever offers pool AVDs for booting", () => {
    const candidates = bootableAvdCandidates(
      ["Resizable_Experimental", "Pixel_Tablet_API_34", "mobile-agent-1", "mobile-agent-2"],
      [],
    );

    assert.deepEqual(candidates, ["mobile-agent-1", "mobile-agent-2"]);
  });

  it("excludes pool AVDs that are already running", () => {
    const candidates = bootableAvdCandidates(["mobile-agent-1", "mobile-agent-2"], ["mobile-agent-1"]);

    assert.deepEqual(candidates, ["mobile-agent-2"]);
  });

  it("offers nothing when only non-pool AVDs exist", () => {
    assert.deepEqual(bootableAvdCandidates(["Resizable_Experimental"], []), []);
  });
});
describe("device-lease CLI exclusivity", () => {
  function runCli(args, env) {
    return new Promise((resolvePromise) => {
      const child = spawn(process.execPath, [scriptPath, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
    });
  }

  async function withLeaseDir(run) {
    const dir = await mkdtemp(path.join(tmpdir(), "mobile-lease-"));
    try {
      return await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function acquire(leaseDir, owner, capacity, ttlMinutes, extraEnv = {}) {
    const args = [
      "acquire",
      "--platform",
      "android",
      "--owner",
      owner,
      "--wait-seconds",
      "0",
      "--no-boot",
    ];
    if (ttlMinutes !== undefined) args.push("--ttl-minutes", ttlMinutes);

    return runCli(args, {
      MOBILE_DEVICE_LEASE_DIR: leaseDir,
      MOBILE_DEVICE_FAKE_CAPACITY: capacity,
      ...extraEnv,
    });
  }

  async function makeRecoveryToolStubs(leaseDir) {
    const bin = path.join(leaseDir, "recovery-bin");
    await mkdir(bin, { recursive: true });
    await writeFile(
      path.join(bin, "adb"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$MOBILE_TEST_TOOL_LOG"
case "$*" in
  *"getprop sys.boot_completed"*)
    if [ -n "$MOBILE_TEST_RECOVERY_STARTED" ]; then
      touch "$MOBILE_TEST_RECOVERY_STARTED"
      while [ ! -e "$MOBILE_TEST_RECOVERY_UNBLOCK" ]; do sleep 0.01; done
    fi
    printf '1\n'
    ;;
  *"pm path android"*) printf 'package:/system/framework/framework-res.apk\n' ;;
  *"dumpsys window windows"*)
    if [ "$MOBILE_TEST_WINDOW_PROBE_FAIL" = "1" ]; then exit 1; fi
    if [ "$MOBILE_TEST_WINDOW_PROBE_FAIL_AFTER_CLEAR" = "1" ] && [ -e "$MOBILE_TEST_DIALOG_CLEARED" ]; then exit 1; fi
    if [ -e "$MOBILE_TEST_DIALOG_CLEARED" ] || [ -z "$MOBILE_TEST_ANR_PACKAGE" ]; then
      printf 'mCurrentFocus=Window{1 u0 com.android.launcher/.Launcher}\n'
    else
      printf 'mCurrentFocus=Window{17 u0 Application Not Responding: %s}\n' "$MOBILE_TEST_ANR_PACKAGE"
    fi
    ;;
  *"dumpsys activity lastanr"*)
    if [ -n "$MOBILE_TEST_ANR_PACKAGE" ]; then printf 'Process: %s\n' "$MOBILE_TEST_ANR_PACKAGE"; fi
    ;;
  *"am force-stop"*) touch "$MOBILE_TEST_DIALOG_CLEARED" ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    await writeFile(
      path.join(bin, "xcrun"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$MOBILE_TEST_TOOL_LOG"
case "$*" in
  *"simctl list devices available -j"*)
    state="\${MOBILE_TEST_IOS_STATE:-Booted}"
    if [ -n "$MOBILE_TEST_IOS_STATE_FILE" ] && [ -e "$MOBILE_TEST_IOS_STATE_FILE" ]; then state="$(sed -n '1p' "$MOBILE_TEST_IOS_STATE_FILE")"; fi
    if [ "$state" = "Missing" ]; then
      printf '{"devices":{"runtime":[]}}'
    else
      printf '{"devices":{"runtime":[{"udid":"UDID-1","name":"iPhone 17 Pro","state":"%s","isAvailable":true}]}}' "$state"
    fi
    ;;
  *"simctl shutdown UDID-1"*)
    if [ -n "$MOBILE_TEST_IOS_STATE_FILE" ]; then printf 'Shutdown\n' > "$MOBILE_TEST_IOS_STATE_FILE"; fi
    ;;
esac
exit 0
`,
      { mode: 0o755 },
    );
    return bin;
  }

  function recoveryEnv(leaseDir, bin, overrides = {}) {
    return {
      MOBILE_APP_PACKAGES: "com.example.app,com.example.app.debug",
      MOBILE_DEVICE_LEASE_DIR: leaseDir,
      MOBILE_DEVICE_TEST_RECOVERY_POLL_MS: "1",
      MOBILE_DEVICE_TEST_RECOVERY_TIMEOUT_MS: "50",
      MOBILE_DEVICE_TEST_IOS_SETTLE_TIMEOUT_MS: "50",
      MOBILE_DEVICE_TEST_IOS_SETTLE_POLL_MS: "1",
      MOBILE_TEST_TOOL_LOG: path.join(leaseDir, "tools.log"),
      MOBILE_TEST_DIALOG_CLEARED: path.join(leaseDir, "dialog-cleared"),
      MOBILE_TEST_IOS_STATE_FILE: path.join(leaseDir, "ios-state"),
      MOBILE_DEVICE_TEST_HOST_RESTART: path.join(leaseDir, "host-restarted"),
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      ...overrides,
    };
  }

  it("recovers only the owner's leased Android emulator from a system ANR", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, {
        MOBILE_TEST_ANR_PACKAGE: "com.google.android.apps.wellbeing",
      });

      const result = await runCli(["recover", "--platform", "android", "--owner", "/w/a"], env);

      assert.equal(result.code, 0);
      assert.match(result.stderr, /Blocking system dialog cleared/);
      assert.match(await readFile(env.MOBILE_TEST_TOOL_LOG, "utf8"), /am force-stop com\.google/);
    });
  });

  it("preserves an application ANR instead of dismissing or rebooting it", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, {
        MOBILE_TEST_ANR_PACKAGE: "com.example.app.debug",
      });

      const result = await runCli(
        ["recover", "--platform", "android", "--owner", "/w/a", "--reboot"],
        env,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /This is app evidence, not emulator dirt/);
      assert.doesNotMatch(await readFile(env.MOBILE_TEST_TOOL_LOG, "utf8"), /force-stop|reboot/);
    });
  });

  it("performs one explicit leased-emulator reboot", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, { MOBILE_TEST_ANR_PACKAGE: "" });

      const result = await runCli(
        ["recover", "--platform", "android", "--owner", "/w/a", "--reboot"],
        env,
      );

      assert.equal(result.code, 0);
      assert.match(result.stderr, /healthy after restart/);
      assert.equal(await readFile(env.MOBILE_DEVICE_TEST_HOST_RESTART, "utf8"), "restarted\n");
    });
  });

  it("fails closed when a reachable Android runtime cannot expose its focused window", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, {
        MOBILE_TEST_ANR_PACKAGE: "",
        MOBILE_TEST_WINDOW_PROBE_FAIL: "1",
      });

      const result = await runCli(
        ["recover", "--platform", "android", "--owner", "/w/a", "--reboot"],
        env,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /could not inspect the focused Android window/i);
      assert.equal(existsSync(env.MOBILE_DEVICE_TEST_HOST_RESTART), false);
    });
  });

  it("fails closed when the focused-window probe fails after clearing a system dialog", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, {
        MOBILE_TEST_ANR_PACKAGE: "com.google.android.apps.wellbeing",
        MOBILE_TEST_WINDOW_PROBE_FAIL_AFTER_CLEAR: "1",
      });

      const result = await runCli(["recover", "--platform", "android", "--owner", "/w/a"], env);

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /could not inspect the focused Android window/i);
      assert.equal(existsSync(env.MOBILE_DEVICE_TEST_HOST_RESTART), false);
    });
  });

  it("keeps release outside the mutex until destructive recovery finishes", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const bin = await makeRecoveryToolStubs(leaseDir);
      const started = path.join(leaseDir, "recovery-started");
      const unblock = path.join(leaseDir, "recovery-unblock");
      const env = recoveryEnv(leaseDir, bin, {
        MOBILE_TEST_ANR_PACKAGE: "",
        MOBILE_TEST_RECOVERY_STARTED: started,
        MOBILE_TEST_RECOVERY_UNBLOCK: unblock,
      });

      const recovery = runCli(["recover", "--platform", "android", "--owner", "/w/a"], env);
      const deadline = Date.now() + 2000;
      while (!existsSync(started) && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      }
      assert.equal(existsSync(started), true, "recovery must reach its protected device probe");

      const release = runCli(["release", "--platform", "android", "--owner", "/w/a"], env);
      const earlyRelease = await Promise.race([
        release.then(() => true),
        new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 100)),
      ]);
      await writeFile(unblock, "go\n");

      assert.equal(earlyRelease, false, "release must wait for lease-owned recovery to finish");
      assert.equal((await recovery).code, 0);
      assert.equal((await release).code, 0);
    });
  });

  it("restarts only the leased iOS simulator", async () => {
    await withLeaseDir(async (leaseDir) => {
      await runCli(["acquire", "--platform", "ios", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1",
      });
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin);

      const result = await runCli(
        ["recover", "--platform", "ios", "--owner", "/w/a", "--reboot"],
        env,
      );

      assert.equal(result.code, 0);
      const calls = await readFile(env.MOBILE_TEST_TOOL_LOG, "utf8");
      assert.match(calls, /simctl shutdown UDID-1/);
      assert.match(calls, /simctl boot UDID-1/);
      assert.match(calls, /simctl bootstatus UDID-1 -b/);
    });
  });

  for (const transitionalState of ["Booting", "Shutting Down"]) {
    it(`settles a leased iOS simulator from ${transitionalState} before booting`, async () => {
      await withLeaseDir(async (leaseDir) => {
        await runCli(["acquire", "--platform", "ios", "--owner", "/w/a"], {
          MOBILE_DEVICE_LEASE_DIR: leaseDir,
          MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1",
        });
        const bin = await makeRecoveryToolStubs(leaseDir);
        const env = recoveryEnv(leaseDir, bin, {
          MOBILE_TEST_IOS_STATE: transitionalState,
          MOBILE_TEST_IOS_STATE_FILE: path.join(leaseDir, "ios-state"),
        });

        const result = await runCli(["recover", "--platform", "ios", "--owner", "/w/a"], env);

        assert.equal(result.code, 0);
        const calls = await readFile(env.MOBILE_TEST_TOOL_LOG, "utf8");
        const shutdownIndex = calls.indexOf("simctl shutdown UDID-1");
        const bootIndex = calls.indexOf("simctl boot UDID-1");
        assert.ok(
          shutdownIndex >= 0 && bootIndex >= 0 && shutdownIndex < bootIndex,
          "shutdown and settle must precede boot",
        );
      });
    });
  }

  it("fails closed when the leased iOS simulator cannot be resolved", async () => {
    await withLeaseDir(async (leaseDir) => {
      await runCli(["acquire", "--platform", "ios", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1",
      });
      const bin = await makeRecoveryToolStubs(leaseDir);
      const env = recoveryEnv(leaseDir, bin, { MOBILE_TEST_IOS_STATE: "Missing" });

      const result = await runCli(
        ["recover", "--platform", "ios", "--owner", "/w/a", "--reboot"],
        env,
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /could not resolve leased iOS simulator/i);
      assert.doesNotMatch(await readFile(env.MOBILE_TEST_TOOL_LOG, "utf8"), /simctl boot UDID-1/);
    });
  });

  it("refuses recovery when this worktree has no lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await runCli(["recover", "--platform", "android", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /holds no live android lease/);
    });
  });

  const leasedId = (result) => /MOBILE_DEVICE_ID='([^']*)'/.exec(result.stdout)?.[1];
  async function plantStaleLease(leaseDir, deviceId, owner = "/w/crashed") {
    const lockDir = path.join(leaseDir, "android", `${deviceId}.lock`);
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "meta.json"),
      JSON.stringify({
        deviceId,
        owner,
        token: "stale-token",
        acquiredAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      }),
    );
  }

  it("gives concurrent owners distinct devices and rejects the overflow", async () => {
    await withLeaseDir(async (leaseDir) => {
      const pool = "emulator-5554,emulator-5556";
      const results = await Promise.all([
        acquire(leaseDir, "/w/a", pool),
        acquire(leaseDir, "/w/b", pool),
        acquire(leaseDir, "/w/c", pool),
      ]);

      const won = results.filter((result) => result.code === 0).map(leasedId);

      assert.equal(won.length, 2, "exactly the two real devices should be leased");
      assert.equal(new Set(won).size, 2, "two owners must never share one device");
      assert.equal(results.filter((result) => result.code !== 0).length, 1);
    });
  });

  it("returns the same device to a repeat acquire from one owner", async () => {
    await withLeaseDir(async (leaseDir) => {
      const pool = "emulator-5554,emulator-5556";
      const first = await acquire(leaseDir, "/w/a", pool);
      const second = await acquire(leaseDir, "/w/a", pool);

      assert.equal(first.code, 0);
      assert.equal(second.code, 0);
      assert.equal(leasedId(first), leasedId(second));
    });
  });

  it("frees the device for another owner after release", async () => {
    await withLeaseDir(async (leaseDir) => {
      assert.equal((await acquire(leaseDir, "/w/a", "emulator-5554")).code, 0);
      assert.notEqual((await acquire(leaseDir, "/w/b", "emulator-5554")).code, 0);

      await runCli(["release", "--platform", "android", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
      });

      const after = await acquire(leaseDir, "/w/b", "emulator-5554");
      assert.equal(after.code, 0);
      assert.equal(leasedId(after), "emulator-5554");
    });
  });

  it("does not let one owner release another owner's lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");

      await runCli(["release", "--platform", "android", "--owner", "/w/b"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
      });
      assert.notEqual((await acquire(leaseDir, "/w/b", "emulator-5554")).code, 0);
    });
  });

  it("reclaims a device whose lease has aged out", async () => {
    await withLeaseDir(async (leaseDir) => {
      await plantStaleLease(leaseDir, "emulator-5554");

      const after = await acquire(leaseDir, "/w/b", "emulator-5554");
      assert.equal(after.code, 0);
      assert.equal(leasedId(after), "emulator-5554");
    });
  });

  it("reclaims an expired lease exactly once under concurrency", async () => {
    await withLeaseDir(async (leaseDir) => {
      await plantStaleLease(leaseDir, "emulator-5554");
      const slow = acquire(leaseDir, "/w/slow", "emulator-5554", undefined, {
        MOBILE_DEVICE_TEST_RECLAIM_DELAY_MS: "700",
      });
      await new Promise((r) => setTimeout(r, 150));
      const fast = acquire(leaseDir, "/w/fast", "emulator-5554");

      const results = await Promise.all([slow, fast]);
      const winners = results.filter((result) => result.code === 0);

      assert.equal(winners.length, 1, "one device must not be reclaimed by two owners at once");
    });
  });
  it("emits exports a real shell can evaluate, including names with spaces", async () => {
    await withLeaseDir(async (leaseDir) => {
      const { stdout } = await acquire(leaseDir, "/w/a", "iPhone 17 Pro");

      const evaluated = await new Promise((resolvePromise) => {
        const shell = spawn(
          "/bin/sh",
          ["-c", `set -e; eval "$1"; printf '%s' "$MOBILE_DEVICE_ID"`, "sh", stdout],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        shell.stdout.on("data", (chunk) => {
          out += chunk;
        });
        shell.on("close", (code) => resolvePromise({ code, out }));
      });

      assert.equal(evaluated.code, 0, "eval of the acquire output must succeed");
      assert.equal(evaluated.out, "iPhone 17 Pro", "the value must survive eval intact");
    });
  });

  it("lets only one contender through an abandoned socket, even racing the takeover", async () => {
    await withLeaseDir(async (leaseDir) => {
      await plantStaleLease(leaseDir, "emulator-5554");
      const socketPath = path.join(leaseDir, "android", ".lease-op.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });
      await writeFile(socketPath, "");
      const slow = acquire(leaseDir, "/w/slow", "emulator-5554", undefined, {
        MOBILE_DEVICE_TEST_TAKEOVER_DELAY_MS: "1200",
      });
      await new Promise((r) => setTimeout(r, 200));
      const fast = acquire(leaseDir, "/w/fast", "emulator-5554", undefined, {
        MOBILE_DEVICE_TEST_RECLAIM_DELAY_MS: "1500",
      });

      const results = await Promise.all([slow, fast]);
      const winners = results.filter((result) => result.code === 0);

      assert.equal(winners.length, 1, "an abandoned socket must not admit two lease holders");
      assert.equal(leasedId(winners[0]), "emulator-5554");
    });
  });

  it("does not strand the old lease when a device leaves the pool", async () => {
    await withLeaseDir(async (leaseDir) => {
      const first = await acquire(leaseDir, "/w/a", "emulator-5554");
      assert.equal(leasedId(first), "emulator-5554");

      const replaced = await acquire(leaseDir, "/w/a", "emulator-5556");
      assert.equal(leasedId(replaced), "emulator-5556");
      const other = await acquire(leaseDir, "/w/b", "emulator-5554,emulator-5556");
      assert.equal(other.code, 0);
      assert.equal(leasedId(other), "emulator-5554");
      const reused = await acquire(leaseDir, "/w/a", "emulator-5554,emulator-5556");
      assert.equal(leasedId(reused), "emulator-5556");
    });
  });

  it("releases every platform when none is named, ignoring the acquired one", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      await runCli(["acquire", "--platform", "ios", "--owner", "/w/a", "--wait-seconds", "0"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1",
      });

      const released = await runCli(["release", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_PLATFORM: "ios",
      });

      assert.equal(released.code, 0);
      assert.match(released.stderr, /Released android device emulator-5554/);
      assert.match(released.stderr, /Released ios device UDID-1/);
    });
  });

  it("rejects an unsupported --platform on release instead of widening it", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");

      const released = await runCli(["release", "--platform", "web", "--owner", "/w/a"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
      });

      assert.notEqual(released.code, 0, "a typo must fail, not release everything");
      assert.notEqual((await acquire(leaseDir, "/w/b", "emulator-5554")).code, 0);
    });
  });

  it("never evicts a mutex that is genuinely held", async () => {
    await withLeaseDir(async (leaseDir) => {
      const socketPath = path.join(leaseDir, "android", ".lease-op.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });

      const holder = createServer();
      await new Promise((r) => holder.listen(socketPath, r));

      try {
        const contender = spawn(
          process.execPath,
          [scriptPath, "acquire", "--platform", "android", "--owner", "/w/b", "--no-boot"],
          {
            env: {
              ...process.env,
              MOBILE_DEVICE_LEASE_DIR: leaseDir,
              MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );

        let exited = false;
        contender.on("close", () => {
          exited = true;
        });
        await new Promise((r) => setTimeout(r, 2_500));

        assert.equal(exited, false, "a contender must queue behind a live holder, not evict it");
        assert.equal(
          existsSync(path.join(leaseDir, "android", "emulator-5554.lock")),
          false,
          "no lease may be issued while another process holds the mutex",
        );

        contender.kill("SIGKILL");
      } finally {
        await new Promise((r) => holder.close(r));
      }
    });
  });

  it("reclaims a socket left behind by a crashed holder", async () => {
    await withLeaseDir(async (leaseDir) => {
      const socketPath = path.join(leaseDir, "android", ".lease-op.sock");
      await mkdir(path.dirname(socketPath), { recursive: true });
      await writeFile(socketPath, "");

      const result = await acquire(leaseDir, "/w/a", "emulator-5554");

      assert.equal(result.code, 0, "an abandoned socket must not wedge the pool");
      assert.equal(leasedId(result), "emulator-5554");
    });
  });

  it("does not report a reuse of a lease that was reissued mid-pass", async () => {
    await withLeaseDir(async (leaseDir) => {
      const first = await acquire(leaseDir, "/w/a", "emulator-5554");
      assert.equal(leasedId(first), "emulator-5554");
      const reusing = acquire(leaseDir, "/w/a", "emulator-5554", undefined, {
        MOBILE_DEVICE_TEST_RENEW_DELAY_MS: "900",
      });
      await new Promise((r) => setTimeout(r, 350));
      const metaPath = path.join(leaseDir, "android", "emulator-5554.lock", "meta.json");
      await writeFile(
        metaPath,
        JSON.stringify({
          deviceId: "emulator-5554",
          owner: "/w/successor",
          token: "successor-token",
          acquiredAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );

      const result = await reusing;
      assert.notEqual(result.code, 0, "must not report reuse of another worktree's lease");
      const after = JSON.parse(await readFile(metaPath, "utf8"));
      assert.equal(after.owner, "/w/successor");
    });
  });

  it("substitutes MOBILE_DEVICE so tools taking the device as an argument are pinned", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");

      const result = await runCli(
        ["exec", "--platform", "android", "--owner", "/w/a", "--", "echo", "target=MOBILE_DEVICE"],
        { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" },
      );

      assert.equal(result.code, 0);
      assert.match(result.stdout, /target=emulator-5554/);
    });
  });

  it("refuses a `booted` operand, which would resolve past the lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      await runCli(["acquire", "--platform", "ios", "--owner", "/w/a", "--wait-seconds", "0"], {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1",
      });
      const result = await runCli(
        [
          "exec",
          "--platform",
          "ios",
          "--owner",
          "/w/a",
          "--",
          "xcrun",
          "simctl",
          "io",
          "booted",
          "screenshot",
          path.join(leaseDir, "refused.png"),
        ],
        { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "UDID-1" },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Refusing to run a `booted` device operand/);
    });
  });

  it("renews the lease before running, so a command cannot outlive it", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const metaPath = path.join(leaseDir, "android", "emulator-5554.lock", "meta.json");
      const before = JSON.parse(await readFile(metaPath, "utf8"));

      await new Promise((r) => setTimeout(r, 20));
      const result = await runCli(
        ["exec", "--platform", "android", "--owner", "/w/a", "--", "echo", "ran"],
        { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" },
      );

      assert.equal(result.code, 0);
      const after = JSON.parse(await readFile(metaPath, "utf8"));
      assert.ok(
        Date.parse(after.expiresAt) > Date.parse(before.expiresAt),
        "exec must push the expiry out before handing over the device",
      );
    });
  });

  it("refuses to exec a lease that now belongs to someone else", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const metaPath = path.join(leaseDir, "android", "emulator-5554.lock", "meta.json");
      await writeFile(
        metaPath,
        JSON.stringify({
          deviceId: "emulator-5554",
          owner: "/w/successor",
          acquiredAt: new Date(Date.now()).toISOString(),
          expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
        }),
      );

      const result = await runCli(
        ["exec", "--platform", "android", "--owner", "/w/a", "--", "echo", "should-not-run"],
        { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" },
      );

      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.stdout, /should-not-run/);
    });
  });

  it("refuses to exec when this worktree holds no lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await runCli(
        ["exec", "--platform", "android", "--owner", "/w/nobody", "--", "echo", "should-not-run"],
        { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" },
      );

      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.stdout, /should-not-run/);
    });
  });

  it("cannot be made to steal a live lease with a tiny contender TTL", async () => {
    await withLeaseDir(async (leaseDir) => {
      const held = await acquire(leaseDir, "/w/holder", "emulator-5554");
      assert.equal(held.code, 0);
      const thief = await acquire(leaseDir, "/w/thief", "emulator-5554", "1");
      assert.notEqual(thief.code, 0, "a contender's TTL must not expire someone else's lease");
      const stillHeld = await acquire(leaseDir, "/w/holder", "emulator-5554");
      assert.equal(leasedId(stillHeld), "emulator-5554");
    });
  });

  it("rejects a TTL too short for the heartbeat to stay ahead of", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await acquire(leaseDir, "/w/a", "emulator-5554", "0.0001");

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--ttl-minutes must be at least 1/);
    });
  });

  it("rejects a zero TTL rather than issuing an already-expired lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await acquire(leaseDir, "/w/a", "emulator-5554", "0");

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--ttl-minutes must be a positive number/);
    });
  });

  it("still allows --wait-seconds 0, which just means do not queue", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await acquire(leaseDir, "/w/a", "emulator-5554");
      assert.equal(result.code, 0, "--wait-seconds 0 is used by every test here");
    });
  });

  it("rejects a non-numeric TTL rather than making leases immortal", async () => {
    await withLeaseDir(async (leaseDir) => {
      const result = await acquire(leaseDir, "/w/a", "emulator-5554", "abc");

      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /--ttl-minutes must be a positive number/);
    });
  });

  it("emits the fail-safe output even when the lease directory is unusable", async () => {
    await withLeaseDir(async (leaseDir) => {
      const unusable = path.join(leaseDir, "not-a-directory");
      await writeFile(unusable, "");

      const result = await runCli(
        ["acquire", "--platform", "android", "--owner", "/w/a", "--wait-seconds", "0", "--no-boot"],
        { MOBILE_DEVICE_LEASE_DIR: unusable, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" },
      );

      assert.notEqual(result.code, 0);
      assert.equal(result.stdout.trim(), "false", "a crash must still fail the caller's eval");
    });
  });

  it("makes a failed acquire fail the eval instead of leaving the shell unpinned", async () => {
    await withLeaseDir(async (leaseDir) => {
      await acquire(leaseDir, "/w/holder", "emulator-5554");

      const refused = await acquire(leaseDir, "/w/other", "emulator-5554");
      assert.notEqual(refused.code, 0);
      assert.equal(refused.stdout.trim(), "false");

      const evaluated = await new Promise((resolvePromise) => {
        const shell = spawn(
          "/bin/sh",
          ["-c", 'eval "$1"; echo "reached=$?"', "sh", refused.stdout],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        shell.stdout.on("data", (chunk) => {
          out += chunk;
        });
        shell.on("close", () => resolvePromise(out));
      });

      assert.match(evaluated, /reached=1/, "eval of a failed acquire must report failure");
    });
  });

  it("does not execute injected shell metacharacters from a device name", async () => {
    await withLeaseDir(async (leaseDir) => {
      const marker = path.join(leaseDir, "pwned");
      const hostile = `iPhone $(touch ${marker}) Pro`;
      const { stdout } = await acquire(leaseDir, "/w/a", hostile);

      const evaluated = await new Promise((resolvePromise) => {
        const shell = spawn(
          "/bin/sh",
          ["-c", `set -e; eval "$1"; printf '%s' "$MOBILE_DEVICE_ID"`, "sh", stdout],
          {
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let out = "";
        shell.stdout.on("data", (chunk) => {
          out += chunk;
        });
        shell.on("close", (code) => resolvePromise({ code, out }));
      });

      assert.equal(evaluated.code, 0);
      assert.equal(evaluated.out, hostile, "the name must be data, never executed");
      assert.equal(existsSync(marker), false, "command substitution must not run");
    });
  });
  it("fences renew, exec and release with the acquisition token", async () => {
    await withLeaseDir(async (leaseDir) => {
      const env = {
        MOBILE_DEVICE_LEASE_DIR: leaseDir,
        MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554,emulator-5556",
      };
      const first = await runCli(
        [
          "acquire",
          "--platform",
          "android",
          "--owner",
          "/w/a",
          "--device",
          "emulator-5556",
          "--no-boot",
          "--wait-seconds",
          "0",
        ],
        env,
      );
      assert.equal(first.code, 0);
      const metaFile = path.join(leaseDir, "android/emulator-5556.lock/meta.json");
      const original = JSON.parse(await readFile(metaFile, "utf8"));
      assert.equal(original.deviceId, "emulator-5556");
      const successor = { ...original, token: "successor-token" };
      await writeFile(metaFile, JSON.stringify(successor));
      for (const verb of ["renew", "exec", "release"]) {
        const result = await runCli(
          [
            verb,
            "--platform",
            "android",
            "--owner",
            "/w/a",
            "--token",
            original.token,
            ...(verb === "exec" ? ["--", "echo", "must-not-run"] : []),
          ],
          env,
        );
        assert.notEqual(result.code, 0, verb);
        assert.ok(!result.stdout.includes("must-not-run"));
        assert.deepEqual(JSON.parse(await readFile(metaFile, "utf8")), successor);
      }
    });
  });

  it("refuses missing token/device values without changing the existing lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      const env = { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" };
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const meta = path.join(leaseDir, "android/emulator-5554.lock/meta.json");
      const before = await readFile(meta, "utf8");
      for (const args of [
        ["release", "--token"],
        ["acquire", "--device"],
      ]) {
        const result = await runCli(
          [args[0], "--platform", "android", "--owner", "/w/a", args[1]],
          env,
        );
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /requires an explicit value/);
        assert.equal(await readFile(meta, "utf8"), before);
      }
      const child = await runCli(
        ["exec", "--platform", "android", "--owner", "/w/a", "--", "echo", "--token", "child-data"],
        env,
      );
      assert.equal(child.code, 0);
      assert.match(child.stdout, /child-data/);
    });
  });
  it("exclusive acquisition cannot relabel/reuse another run's own-worktree lease", async () => {
    await withLeaseDir(async (leaseDir) => {
      const env = { MOBILE_DEVICE_LEASE_DIR: leaseDir, MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554" };
      await acquire(leaseDir, "/w/a", "emulator-5554");
      const meta = path.join(leaseDir, "android/emulator-5554.lock/meta.json");
      const before = await readFile(meta, "utf8");
      const result = await runCli(
        [
          "acquire",
          "--platform",
          "android",
          "--owner",
          "/w/a",
          "--exclusive",
          "--device",
          "emulator-5554",
          "--label",
          "second-run",
          "--wait-seconds",
          "0",
          "--no-boot",
        ],
        env,
      );
      assert.notEqual(result.code, 0);
      assert.equal(await readFile(meta, "utf8"), before);
    });
  });
});

describe("withHardwareKeyboard", () => {
  const realistic = [
    "hw.dPad = no",
    "hw.gpu.enabled = yes",
    "hw.keyboard = no",
    "hw.keyboard.charmap = qwerty2",
    "hw.keyboard.lid = yes",
    "hw.mainKeys = no",
    "",
  ].join("\n");

  it("flips an existing hw.keyboard = no to yes", () => {
    const updated = withHardwareKeyboard(realistic);

    assert.match(updated, /^hw\.keyboard = yes$/m);
    assert.ok(!/^hw\.keyboard = no$/m.test(updated));
  });

  it("leaves the sibling hw.keyboard.* keys untouched", () => {
    const updated = withHardwareKeyboard(realistic);

    assert.match(updated, /^hw\.keyboard\.charmap = qwerty2$/m);
    assert.match(updated, /^hw\.keyboard\.lid = yes$/m);
    assert.equal(updated.match(/^hw\.keyboard = yes$/gm).length, 1);
  });

  it("appends the key when the file does not have it", () => {
    const updated = withHardwareKeyboard("hw.dPad = no\nhw.mainKeys = no\n");

    assert.match(updated, /^hw\.keyboard = yes$/m);
    assert.match(updated, /^hw\.dPad = no$/m);
    assert.match(updated, /^hw\.mainKeys = no$/m);
  });

  it("appends onto a file with no trailing newline without joining lines", () => {
    const updated = withHardwareKeyboard("hw.mainKeys = no");

    assert.equal(updated, "hw.mainKeys = no\nhw.keyboard = yes\n");
  });

  it("is idempotent, so re-provisioning an already-fixed AVD changes nothing", () => {
    const once = withHardwareKeyboard(realistic);

    assert.equal(withHardwareKeyboard(once), once);
  });

  it("matches the key with or without spaces around the separator", () => {
    assert.match(withHardwareKeyboard("hw.keyboard=no\n"), /^hw\.keyboard = yes$/m);
    assert.match(withHardwareKeyboard("hw.keyboard   =   no\n"), /^hw\.keyboard = yes$/m);
  });

  it("rewrites every occurrence, because the emulator reads the last one", () => {
    const updated = withHardwareKeyboard("hw.keyboard = no\nhw.mainKeys = no\nhw.keyboard = no\n");

    assert.ok(!/= no$/m.test(updated.replace(/^hw\.mainKeys.*$/m, "")));
    assert.equal(updated.match(/^hw\.keyboard = yes$/gm).length, 2);
  });

  it("handles empty and absent contents", () => {
    assert.equal(withHardwareKeyboard(""), "hw.keyboard = yes\n");
    assert.equal(withHardwareKeyboard(undefined), "hw.keyboard = yes\n");
  });
});

describe("parseAvdPath", () => {
  const pointer = [
    "avd.ini.encoding=UTF-8",
    "path=/home/developer/.android/avd/mobile-agent-1.avd",
    "path.rel=avd/mobile-agent-1.avd",
    "target=android-36",
    "",
  ].join("\n");

  it("reads the authoritative path, not the relative one", () => {
    assert.equal(parseAvdPath(pointer), "/home/developer/.android/avd/mobile-agent-1.avd");
  });

  it("tolerates spaces around the separator", () => {
    assert.equal(parseAvdPath("path = /tmp/x.avd\n"), "/tmp/x.avd");
  });

  it("is not fooled when path.rel comes FIRST", () => {
    const reversed = [
      "avd.ini.encoding=UTF-8",
      "path.rel=avd/mobile-agent-1.avd",
      "path=/home/developer/.android/avd/mobile-agent-1.avd",
      "",
    ].join("\n");

    assert.equal(parseAvdPath(reversed), "/home/developer/.android/avd/mobile-agent-1.avd");
  });

  it("returns undefined when there is no usable path, so the caller can fall back", () => {
    assert.equal(parseAvdPath("target=android-36\n"), undefined);
    assert.equal(parseAvdPath("path=\n"), undefined);
    assert.equal(parseAvdPath(""), undefined);
    assert.equal(parseAvdPath(undefined), undefined);
  });

  it("treats a whitespace-only path as absent", () => {
    assert.equal(parseAvdPath("path=   \n"), undefined);
    assert.equal(parseAvdPath("path=\t\n"), undefined);
  });
});

describe("resolveAvdHome", () => {
  const fixtureHome = "/home/developer";

  it("defaults to ~/.android/avd", () => {
    assert.equal(resolveAvdHome({}, fixtureHome), "/home/developer/.android/avd");
  });

  it("honours ANDROID_AVD_HOME above everything else", () => {
    const env = {
      ANDROID_AVD_HOME: "/custom/avds",
      ANDROID_EMULATOR_HOME: "/emu",
      ANDROID_USER_HOME: "/user",
      ANDROID_SDK_HOME: "/sdk",
    };

    assert.equal(resolveAvdHome(env, fixtureHome), "/custom/avds");
  });

  it("falls to ANDROID_EMULATOR_HOME/avd before the user and legacy homes", () => {
    const env = {
      ANDROID_EMULATOR_HOME: "/emu",
      ANDROID_USER_HOME: "/user",
      ANDROID_SDK_HOME: "/sdk",
    };

    assert.equal(resolveAvdHome(env, fixtureHome), "/emu/avd");
  });

  it("falls to ANDROID_USER_HOME/avd before the legacy ANDROID_SDK_HOME", () => {
    assert.equal(
      resolveAvdHome({ ANDROID_USER_HOME: "/user", ANDROID_SDK_HOME: "/sdk" }, fixtureHome),
      "/user/avd",
    );
  });

  it("still supports the legacy ANDROID_SDK_HOME/.android/avd", () => {
    assert.equal(resolveAvdHome({ ANDROID_SDK_HOME: "/sdk" }, fixtureHome), "/sdk/.android/avd");
  });

  it("treats an empty or blank variable as unset", () => {
    assert.equal(resolveAvdHome({ ANDROID_AVD_HOME: "" }, fixtureHome), "/home/developer/.android/avd");
    assert.equal(resolveAvdHome({ ANDROID_SDK_HOME: "   " }, fixtureHome), "/home/developer/.android/avd");
    assert.equal(
      resolveAvdHome({ ANDROID_EMULATOR_HOME: "", ANDROID_USER_HOME: "/user" }, fixtureHome),
      "/user/avd",
    );
  });
});

describe("explicit virtual-device selection", () => {
  const nowMs = Date.now();
  const plan = (extra) =>
    planAcquisition({
      capacityIds: ["emulator-5554", "emulator-5556"],
      leases: [],
      owner: "runner",
      nowMs,
      ttlMs: HOUR_MS,
      requestedDeviceId: "emulator-5556",
      ...extra,
    });
  it("claims the requested device rather than the first free device", () => {
    assert.equal(plan().deviceId, "emulator-5556");
  });
  it("never substitutes a free sibling when the requested device is occupied", () => {
    assert.equal(
      plan({
        leases: [
          {
            deviceId: "emulator-5556",
            owner: "foreign",
            acquiredAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + HOUR_MS).toISOString(),
          },
        ],
      }).action,
      "wait",
    );
  });
  it("refuses a mismatch with an existing live own lease instead of replacing it", () => {
    assert.equal(
      plan({
        leases: [
          {
            deviceId: "emulator-5554",
            owner: "runner",
            acquiredAt: new Date(nowMs).toISOString(),
            expiresAt: new Date(nowMs + HOUR_MS).toISOString(),
          },
        ],
      }).action,
      "mismatch",
    );
  });
  it("does not select an absent requested device", () => {
    assert.equal(plan({ requestedDeviceId: "emulator-9999" }).action, "unavailable");
  });
});

for (const platform of ["android", "ios"]) {
  for (const acquisition of ["claim", "reuse"]) {
    it(`${platform} ${acquisition} exported generation cannot adopt a same-owner successor`, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "ml-exp-"));
      const owner = path.join(root, "owner");
      await mkdir(owner);
      const device = platform === "android" ? "emulator-5554" : "UDID-1";
      const env = {
        ...process.env,
        MOBILE_DEVICE_LEASE_DIR: path.join(root, "leases"),
        MOBILE_DEVICE_FAKE_CAPACITY: device,
      };
      const run = (args, extra = {}) =>
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [scriptPath, ...args, "--platform", platform, "--owner", owner],
            { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] },
          );
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (x) => {
            stdout += x;
          });
          child.stderr.on("data", (x) => {
            stderr += x;
          });
          child.once("close", (code) => resolve({ code, stdout, stderr }));
        });
      const acquireArgs = ["acquire", "--no-boot", "--wait-seconds", "0"];
      const meta = path.join(env.MOBILE_DEVICE_LEASE_DIR, platform, device + ".lock", "meta.json");
      try {
        let earlierAcquiredAt;
        if (acquisition === "reuse") {
          assert.equal((await run(acquireArgs)).code, 0);
          earlierAcquiredAt = JSON.parse(await readFile(meta, "utf8")).acquiredAt;
        }
        const old = run(acquireArgs, { MOBILE_DEVICE_TEST_EMIT_DELAY_MS: "1500" });
        for (let i = 0; i < 100 && !existsSync(meta); i++)
          await new Promise((r) => setTimeout(r, 10));
        if (earlierAcquiredAt) {
          for (
            let i = 0;
            i < 100 && JSON.parse(await readFile(meta, "utf8")).acquiredAt === earlierAcquiredAt;
            i++
          )
            await new Promise((r) => setTimeout(r, 10));
          assert.notEqual(JSON.parse(await readFile(meta, "utf8")).acquiredAt, earlierAcquiredAt);
        }
        const original = JSON.parse(await readFile(meta, "utf8")).token;
        assert.equal((await run(["release", "--token", original])).code, 0);
        const successor = await run(acquireArgs);
        assert.equal(successor.code, 0, successor.stderr);
        const current = JSON.parse(await readFile(meta, "utf8")).token;
        assert.notEqual(current, original);
        const exported = await old;
        assert.equal(exported.code, 0, exported.stderr);
        assert.ok(
          exported.stdout.includes(original),
          "old acquire must export its own captured generation",
        );
        assert.ok(!exported.stdout.includes(current));
        for (const operation of [
          ["renew"],
          ["release"],
          ["exec", "--", process.execPath, "-e", "process.exit(0)"],
        ]) {
          const args =
            operation[0] === "exec"
              ? [
                  "exec",
                  "--token",
                  original,
                  "--platform",
                  platform,
                  "--owner",
                  owner,
                  "--",
                  process.execPath,
                  "-e",
                  "process.exit(0)",
                ]
              : [...operation, "--token", original];
          const result = await run(args);
          assert.notEqual(result.code, 0, operation[0]);
          assert.equal(JSON.parse(await readFile(meta, "utf8")).token, current);
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
