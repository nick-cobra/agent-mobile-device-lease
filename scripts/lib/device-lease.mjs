export const DEFAULT_TTL_MINUTES = 240;
export const DEFAULT_WAIT_SECONDS = 1800;

export const PLATFORMS = ["android", "ios"];

export function isPlatform(value) {
  return PLATFORMS.includes(value);
}
export function parseAdbDevices(stdout) {
  if (!stdout) return [];

  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial && state === "device")
    .map(([serial]) => serial);
}
export function assessAndroidDeviceHealth({ bootCompleted, packagePath } = {}) {
  if (String(bootCompleted ?? "").trim() !== "1") {
    return { healthy: false, reason: "Android boot has not completed" };
  }

  if (
    !String(packagePath ?? "")
      .trim()
      .startsWith("package:")
  ) {
    return { healthy: false, reason: "Android package service is unavailable" };
  }

  return { healthy: true, reason: "ready" };
}

function androidPackageName(value) {
  const candidate = String(value ?? "")
    .trim()
    .split(":")[0];
  return /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(candidate) ? candidate : null;
}
export function parseAndroidBlockingDialog({ windowDump } = {}) {
  const focusedWindow = String(windowDump ?? "")
    .split(/\r?\n/)
    .find((line) => /^\s*m(?:CurrentFocus|FocusedWindow)=/.test(line));
  if (!focusedWindow) return null;

  const blocking =
    /Application Not Responding|Application Error|is(?:n['’]t| not) responding|keeps stopping/i.exec(
      focusedWindow,
    );
  if (!blocking) return null;

  const direct = /Application (?:Not Responding|Error):\s*([A-Za-z][A-Za-z0-9_.:]*)/i.exec(
    focusedWindow,
  )?.[1];
  const kind = /Application Error|keeps stopping/i.test(blocking[0]) ? "crash" : "anr";

  return {
    kind,
    packageName: androidPackageName(direct),
  };
}

function isApplicationAndroidPackage(packageName, appPackages) {
  return appPackages.includes(packageName);
}

export function androidRecoveryDecision({
  health,
  blockingDialog,
  windowProbeSucceeded,
  emulator,
  forceReboot = false,
  appPackages = [],
} = {}) {
  if (health?.healthy && windowProbeSucceeded === false) {
    return { action: "fail-window-probe" };
  }
  if (isApplicationAndroidPackage(blockingDialog?.packageName, appPackages)) {
    return { action: "fail-app", packageName: blockingDialog.packageName };
  }

  const needsRecovery = forceReboot || !health?.healthy || Boolean(blockingDialog);
  if (!needsRecovery) return { action: "healthy" };
  if (!emulator) return { action: "refuse-hardware" };
  if (blockingDialog && !blockingDialog.packageName) return { action: "fail-unknown-app" };

  if (blockingDialog && appPackages.length === 0) return { action: "fail-unknown-app" };

  if (forceReboot) return { action: "reboot", reason: "restart requested" };

  if (!health?.healthy) {
    return { action: "reboot", reason: health?.reason ?? "Android runtime is unavailable" };
  }
  if (blockingDialog?.packageName) {
    return {
      action: "clear-system-dialog",
      packageName: blockingDialog.packageName,
    };
  }
  return {
    action: "reboot",
    reason: "blocking Android system dialog",
  };
}
export function selectAndroidEmulatorProcess({
  serial,
  listenerPids,
  processCommands,
  processExecutables,
  processStartTimes,
  canonicalEmulatorDir,
  availableAvdNames,
} = {}) {
  const port = Number(/^emulator-(\d+)$/.exec(String(serial ?? ""))?.[1]);
  if (!Number.isInteger(port)) return null;

  const available = new Set(availableAvdNames ?? []);
  const canonicalDir = String(canonicalEmulatorDir ?? "").replace(/\/+$/, "");
  const matches = [...new Set(listenerPids ?? [])].flatMap((rawPid) => {
    const pid = Number(rawPid);
    const command = String(processCommands?.[String(rawPid)] ?? processCommands?.[pid] ?? "");
    const executablePath = String(
      processExecutables?.[String(rawPid)] ?? processExecutables?.[pid] ?? "",
    ).trim();
    const startTime = String(
      processStartTimes?.[String(rawPid)] ?? processStartTimes?.[pid] ?? "",
    ).trim();
    const avdMatch = /(?:^|\s)-avd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
    const avdName = avdMatch?.[1] ?? avdMatch?.[2] ?? avdMatch?.[3];
    const commandExecutable = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(command);
    const commandPath = commandExecutable?.[1] ?? commandExecutable?.[2] ?? commandExecutable?.[3];
    const relativeExecutable =
      canonicalDir && executablePath.startsWith(`${canonicalDir}/`)
        ? executablePath.slice(canonicalDir.length + 1)
        : "";
    const isCanonicalEmulator =
      relativeExecutable === "emulator" ||
      /^qemu\/[^/]+\/qemu-system-[A-Za-z0-9_-]+$/.test(relativeExecutable);

    return Number.isInteger(pid) &&
      pid > 1 &&
      isCanonicalEmulator &&
      commandPath === executablePath &&
      startTime &&
      available.has(avdName)
      ? [{ pid, port, avdName, executablePath, startTime }]
      : [];
  });

  return matches.length === 1 ? matches[0] : null;
}

export function sameAndroidEmulatorProcess(left, right) {
  return Boolean(
    left &&
    right &&
    left.pid === right.pid &&
    left.port === right.port &&
    left.avdName === right.avdName &&
    left.executablePath === right.executablePath &&
    left.startTime === right.startTime,
  );
}
export function isLocalEmulatorSerial(serial) {
  return typeof serial === "string" && /^emulator-\d+$/.test(serial);
}
export function findPhysicalAndroidDevices(devices, classifyDevice) {
  if (!Array.isArray(devices)) return [];

  return devices.filter((device) => classifyDevice(device) === "physical");
}

export function canPreferPhysicalAndroidDevice({ deviceCount, physicalCount, unknownCount }) {
  return deviceCount <= 1 || (physicalCount === 1 && unknownCount === 0);
}
export function isEmulatorProps({ kernelQemu, characteristics } = {}) {
  if (String(kernelQemu ?? "").trim() === "1") return true;
  return String(characteristics ?? "")
    .split(",")
    .map((part) => part.trim())
    .includes("emulator");
}

export function classifyAndroidDeviceProps({ kernelQemu, characteristics } = {}) {
  const qemu = String(kernelQemu ?? "").trim();
  const deviceCharacteristics = String(characteristics ?? "").trim();
  if (qemu === "1" || isEmulatorProps({ kernelQemu, characteristics })) return "emulator";
  if (qemu === "0" || deviceCharacteristics !== "") return "physical";
  return "unknown";
}
export function selectLeasableAndroidSerials(attached, readProps, { allowPhysical = false } = {}) {
  const serials = Array.isArray(attached) ? attached : [];
  if (allowPhysical) return { leasable: serials, rejected: [] };

  const leasable = serials.filter(
    (serial) => isLocalEmulatorSerial(serial) || isEmulatorProps(readProps?.(serial)),
  );
  return { leasable, rejected: serials.filter((serial) => !leasable.includes(serial)) };
}
export function physicalLeaseMarker({ allowPhysical = false, deviceId } = {}) {
  return allowPhysical && !isLocalEmulatorSerial(deviceId) ? { physical: true } : {};
}
export function parseSimctlIphones(jsonText, family = "iphone") {
  if (!["iphone", "ipad", "all"].includes(family)) throw new Error("Invalid iOS device family.");
  if (!jsonText) return [];

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }

  return Object.values(parsed?.devices ?? {})
    .flat()
    .filter(
      (device) =>
        device?.isAvailable &&
        ((family !== "ipad" && device?.name?.includes("iPhone")) ||
          (family !== "iphone" && device?.name?.includes("iPad"))),
    )
    .map((device) => ({ udid: device.udid, name: device.name, state: device.state }));
}
export function parseAvdNames(stdout) {
  if (!stdout) return [];

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^(INFO|WARNING|ERROR)\b/.test(line));
}
export function resolveLeaseRoot(env, homeDir) {
  const override = env?.MOBILE_DEVICE_LEASE_DIR;
  if (override) return override;

  return `${env?.XDG_STATE_HOME || `${homeDir}/.local/state`}/shared-mobile/device-leases`;
}
export function isExpired(meta, nowMs, fallbackTtlMs) {
  const expiresAt = Date.parse(meta?.expiresAt ?? "");
  if (Number.isFinite(expiresAt)) return nowMs >= expiresAt;

  const acquiredAt = Date.parse(meta?.acquiredAt ?? "");
  if (!Number.isFinite(acquiredAt)) return true;

  return nowMs - acquiredAt >= fallbackTtlMs;
}
export function planAcquisition({ capacityIds, leases, owner, nowMs, ttlMs, requestedDeviceId }) {
  const live = leases.filter((lease) => !isExpired(lease, nowMs, ttlMs));

  if (requestedDeviceId) {
    if (live.some((lease) => lease.owner === owner && lease.deviceId !== requestedDeviceId)) {
      return { action: "mismatch", deviceId: null };
    }
    if (!capacityIds.includes(requestedDeviceId)) {
      return { action: "unavailable", deviceId: null };
    }
    capacityIds = [requestedDeviceId];
  }

  const mine = live.find((lease) => lease.owner === owner && capacityIds.includes(lease.deviceId));
  if (mine) {
    return { action: "reuse", deviceId: mine.deviceId };
  }

  const heldByOthers = new Set(
    live.filter((lease) => lease.owner !== owner).map((l) => l.deviceId),
  );
  const free = capacityIds.find((id) => !heldByOthers.has(id));
  if (free) {
    return { action: "claim", deviceId: free };
  }

  return { action: "wait", deviceId: null, blockedBy: [...heldByOthers] };
}
export function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}
export function formatExportLines({ platform, deviceId, name, token }) {
  const assign = (key, value) => `${key}=${shellQuote(value)}`;

  const lines = [assign("MOBILE_DEVICE_PLATFORM", platform), assign("MOBILE_DEVICE_ID", deviceId)];

  if (platform === "android") {
    lines.push(assign("ADB_DEVICE_SERIAL", deviceId), assign("ANDROID_SERIAL", deviceId));
  } else {
    lines.push(assign("IOS_SIMULATOR", deviceId));
  }

  if (name) lines.push(assign("MOBILE_DEVICE_NAME", name));
  if (token) lines.push(assign("MOBILE_DEVICE_TOKEN", token));

  return lines;
}

export const AVD_POOL_PREFIX = "mobile-agent";
export const DEFAULT_AVD_POOL_SIZE = 3;

export function avdPoolNames(size, prefix = AVD_POOL_PREFIX) {
  return Array.from({ length: size }, (_, index) => `${prefix}-${index + 1}`);
}
export function bootableAvdCandidates(allAvdNames, runningAvdNames, prefix = AVD_POOL_PREFIX) {
  const running = new Set(runningAvdNames);

  return allAvdNames.filter((name) => name.startsWith(`${prefix}-`) && !running.has(name));
}
export function toSystemImagePackage({ api, tag, abi }) {
  return `system-images;${api};${tag};${abi}`;
}
export const PINNED_SYSTEM_IMAGE = Object.freeze({
  api: "android-36",
  tag: "google_apis_playstore",
  abi: "arm64-v8a",
});
export const PINNED_SYSTEM_IMAGE_PACKAGE = toSystemImagePackage(PINNED_SYSTEM_IMAGE);
export function hasPinnedSystemImage(images) {
  return images.some(
    ({ api, tag, abi }) =>
      api === PINNED_SYSTEM_IMAGE.api &&
      tag === PINNED_SYSTEM_IMAGE.tag &&
      abi === PINNED_SYSTEM_IMAGE.abi,
  );
}
export function formatAge(meta, nowMs) {
  const acquiredAt = Date.parse(meta?.acquiredAt ?? "");
  if (!Number.isFinite(acquiredAt)) return "unknown";

  const minutes = Math.max(0, Math.round((nowMs - acquiredAt) / 60000));
  if (minutes < 60) return `${minutes}m`;

  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * `config.ini` contents with the hardware keyboard enabled.
 *
 * The match is anchored on `=` after the key, NOT on the key as a prefix:
 * `hw.keyboard.charmap` and `hw.keyboard.lid` are sibling settings that live in
 * the same file, and a prefix match would overwrite whichever came first and
 * silently drop the real one. Replaces every occurrence — the emulator reads
 * the last, so rewriting only the first would leave a stale `no` winning.
 *
 * Idempotent, so re-provisioning an already-fixed AVD is a no-op. Keys are
 * written with spaces around `=`, matching how the emulator writes the file.
 */
export function withHardwareKeyboard(contents) {
  const text = String(contents ?? "");
  const assignment = /^[ \t]*hw\.keyboard[ \t]*=.*$/gm;

  if (assignment.test(text)) {
    return text.replace(assignment, "hw.keyboard = yes");
  }

  const separator = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${separator}hw.keyboard = yes\n`;
}

/**
 * Where an AVD's own directory lives, read from the pointer `.ini` that
 * `avdmanager` writes beside it.
 *
 * Not assumed to be `<avdHome>/<name>.avd`: `path=` is authoritative and can
 * point elsewhere when ANDROID_AVD_HOME or a relocated SDK is in play. Returns
 * undefined when the pointer has no usable `path=`, so the caller can fall back
 * rather than write to a guessed directory.
 */
export function parseAvdPath(iniContents) {
  const match = String(iniContents ?? "").match(/^[ \t]*path[ \t]*=[ \t]*(.+?)[ \t]*$/m);
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}

/**
 * Where `avdmanager` puts AVDs, in Android's documented precedence order.
 *
 * Getting this wrong is silent in the direction that matters: if the resolved
 * directory is not the one `avdmanager` wrote to, the newly created AVD is
 * simply not found, `hw.keyboard` is never enabled, and the emulator boots
 * without a keyboard exactly as before.
 *
 * The chain, from the emulator's environment-variable docs:
 *   ANDROID_AVD_HOME                     — the AVD directory itself
 *   $ANDROID_EMULATOR_HOME/avd           — emulator config dir
 *   $ANDROID_USER_HOME/avd               — modern user dir
 *   $ANDROID_SDK_HOME/.android/avd       — legacy, superseded by ANDROID_USER_HOME
 *   ~/.android/avd                       — default
 *
 * An empty-string variable counts as unset. Exported shells routinely carry
 * `ANDROID_SDK_HOME=`, and treating that as a real value resolves the whole
 * chain to `/.android/avd`.
 */
export function resolveAvdHome(env = {}, homeDir = "") {
  const value = (name) => {
    const raw = env[name];
    return typeof raw === "string" && raw.trim() !== "" ? raw : undefined;
  };

  const avdHome = value("ANDROID_AVD_HOME");
  if (avdHome) return avdHome;

  const emulatorHome = value("ANDROID_EMULATOR_HOME");
  if (emulatorHome) return `${emulatorHome}/avd`;

  const userHome = value("ANDROID_USER_HOME");
  if (userHome) return `${userHome}/avd`;

  const sdkHome = value("ANDROID_SDK_HOME");
  if (sdkHome) return `${sdkHome}/.android/avd`;

  return `${homeDir}/.android/avd`;
}
