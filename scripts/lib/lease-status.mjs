import { readLeases } from "./device-lease-store.mjs";
import { DEFAULT_TTL_MINUTES, isExpired } from "./device-lease.mjs";
import { findExecutable, probeSdk } from "./sdk-tools.mjs";

function observe(platform, env) {
  const name = platform === "android" ? "adb" : "xcrun";
  const probe = probeSdk(name, findExecutable(name, { env }), platform === "android" ? ["devices", "-l"] : ["simctl", "list", "devices", "-j"], env);
  if (!probe.ok) return { diagnostic: probe, devices: null };
  try {
    const devices = new Map();
    if (platform === "android") {
      if (!/^List of devices attached/m.test(probe.stdout)) throw new Error("Invalid adb device inventory");
      for (const line of probe.stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(device|offline|unauthorized|recovery|sideload|bootloader)(?:\s|$)/.exec(line);
        if (match) devices.set(match[1], match[2]);
      }
    } else {
      const parsed = JSON.parse(probe.stdout);
      if (!parsed.devices || typeof parsed.devices !== "object" || Array.isArray(parsed.devices) || !Object.values(parsed.devices).every(Array.isArray)) throw new Error("Invalid simulator inventory");
      for (const device of Object.values(parsed.devices).flat()) {
        if (typeof device.udid !== "string" || typeof device.state !== "string") throw new Error("Invalid simulator entry");
        devices.set(device.udid, device.state);
      }
    }
    return { diagnostic: { ok: true, kind: "ok", detail: probe.detail }, devices };
  } catch (error) { return { diagnostic: { ok: false, kind: "invalid-inventory", detail: error.message }, devices: null }; }
}

export function leaseStatus({ leaseRoot, platforms, env = process.env, nowMs = Date.now(), fallbackTtlMs = DEFAULT_TTL_MINUTES * 60000 }) {
  const observations = {}, leases = [];
  for (const platform of platforms) {
    const records = readLeases(leaseRoot, platform);
    // An empty registry needs no SDK probe and never creates a directory.
    const observed = records.length ? observe(platform, env) : { diagnostic: { ok: true, kind: "not-needed", detail: "No leases" }, devices: new Map() };
    observations[platform] = observed.diagnostic;
    for (const lease of records) {
      let expiry = Date.parse(lease.expiresAt ?? "");
      if (!Number.isFinite(expiry)) expiry = Date.parse(lease.acquiredAt ?? "") + fallbackTtlMs;
      const renewed = Date.parse(lease.lastRenewedAt ?? "");
      leases.push({ platform, deviceId: lease.deviceId, owner: lease.owner, label: lease.label ?? null,
        expiresAt: Number.isFinite(expiry) ? new Date(expiry).toISOString() : null,
        remainingTtlSeconds: Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - nowMs) / 1000)) : null,
        expired: isExpired(lease, nowMs, fallbackTtlMs),
        lastRenewedAt: Number.isFinite(renewed) ? new Date(renewed).toISOString() : null,
        renewalKnown: lease.lastRenewedAt === null || Number.isFinite(renewed),
        deviceState: observed.devices === null ? { availability: "unavailable", state: null }
          : observed.devices.has(lease.deviceId) ? { availability: "present", state: observed.devices.get(lease.deviceId) }
          : { availability: "absent", state: null } });
    }
  }
  return { observedAt: new Date(nowMs).toISOString(), registry: leaseRoot, observations, leases };
}

export function formatTtl(seconds) {
  return seconds === null ? "unknown" : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}
