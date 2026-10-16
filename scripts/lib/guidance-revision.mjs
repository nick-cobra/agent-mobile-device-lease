import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

// Version the guidance contract independently of CLI-only releases. Update every
// shipped standing-rule/skill marker when this shared guidance revision changes.
export const GUIDANCE_REVISION = 1;
const prefix = "agent-mobile-device-lease-guidance";
const limit = 65536;
const base = { expectedRevision: GUIDANCE_REVISION, declaredRevision: null };

export function guidanceRevision(file, { inspect = false, source = "configured" } = {}) {
  if (!inspect) return { ...base, status: "unknown", reason: source === "candidate" ? "unconfigured-candidate" : "inspection-not-enabled" };
  if (file.status !== "present") return { ...base, status: file.status === "missing" ? "missing" : "unknown", reason: `file-${file.status}` };
  let fd;
  try {
    // A path can change after metadata inspection. Non-blocking open plus a
    // descriptor check prevents a swapped FIFO/device from becoming a read.
    fd = openSync(file.path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { ...base, status: "unknown", reason: "not-regular-file" };
    if (stat.size > limit) return { ...base, status: "unknown", reason: "read-limit" };
    const bytes = Buffer.alloc(limit + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > limit) return { ...base, status: "unknown", reason: "read-limit" };
    if (length !== stat.size || fstatSync(fd).size !== length) return { ...base, status: "unknown", reason: "incomplete-or-changing-file" };
    const markers = bytes.subarray(0, length).toString("utf8").split(/\r?\n/).filter(line => line.includes(prefix));
    if (!markers.length) return { ...base, status: "missing", reason: "no-marker" };
    if (markers.length !== 1) return { ...base, status: "ambiguous", reason: "multiple-markers" };
    const match = /^<!-- agent-mobile-device-lease-guidance: (0|[1-9][0-9]*) -->$/.exec(markers[0].trim());
    if (!match || !Number.isSafeInteger(Number(match[1]))) return { ...base, status: "unknown", reason: "malformed-marker" };
    const declaredRevision = Number(match[1]);
    return { expectedRevision: GUIDANCE_REVISION, declaredRevision,
      status: declaredRevision === GUIDANCE_REVISION ? "matching" : declaredRevision < GUIDANCE_REVISION ? "outdated" : "newer",
      ...(declaredRevision > GUIDANCE_REVISION ? { reason: "newer-revision-compatibility-unverified" } : {}),
    };
  } catch (error) {
    return { ...base, status: "unknown", reason: "read-error", errorCode: error.code ?? "UNKNOWN" };
  } finally { if (fd !== undefined) closeSync(fd); }
}
