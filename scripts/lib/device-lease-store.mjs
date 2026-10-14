
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { isExpired, resolveLeaseRoot } from "./device-lease.mjs";

export { resolveLeaseRoot };

export function platformDir(leaseRoot, platform) {
  return join(leaseRoot, platform);
}

export function lockPath(leaseRoot, platform, deviceId) {
  return join(platformDir(leaseRoot, platform), `${deviceId.replace(/[^A-Za-z0-9._-]/g, "_")}.lock`);
}
export function readLeases(leaseRoot, platform) {
  const dir = platformDir(leaseRoot, platform);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".lock"))
    .map((entry) => {
      try {
        return JSON.parse(readFileSync(join(dir, entry, "meta.json"), "utf8"));
      } catch {
        return { deviceId: entry.replace(/\.lock$/, ""), owner: "unknown", acquiredAt: null };
      }
    });
}
export function leasedDeviceFor({ leaseRoot, platform, owner, nowMs, fallbackTtlMs }) {
  const mine = readLeases(leaseRoot, platform).find(
    (lease) => lease.owner === owner && !isExpired(lease, nowMs, fallbackTtlMs),
  );

  return mine?.deviceId ?? null;
}
export function findOwnLease({ leaseRoot, platform, owner }) {
  return readLeases(leaseRoot, platform).find((lease) => lease.owner === owner) ?? null;
}
export function liveLeaseForDevice({ leaseRoot, platform, deviceId, nowMs, fallbackTtlMs }) {
  return (
    readLeases(leaseRoot, platform).find(
      (lease) => lease.deviceId === deviceId && !isExpired(lease, nowMs, fallbackTtlMs),
    ) ?? null
  );
}
