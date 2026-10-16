import { constants } from "node:os";
import { performance } from "node:perf_hooks";

// Renewal has no child command and never acquires or releases a lease. The
// caller supplies generation-fenced reads and cancellable, serialised writes.
export async function runKeepAlive({ durationMs, heartbeatMs, readLease, renewLease, onEvent, identity }) {
  const end = performance.now() + durationMs;
  const renewalEndsAt = new Date(Date.now() + durationMs).toISOString();
  let stopped, started = false, pending, lastConfirmedExpiresAt;
  let heartbeat, monitor, deadline;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const active = () => !stopped && performance.now() < end;
  const read = () => { try { return readLease() || null; } catch { return null; } };
  const stop = (reason, code, detail) => {
    if (stopped) return;
    stopped = { reason, code, ...(detail ? { detail } : {}) };
    clearInterval(heartbeat); clearInterval(monitor); clearTimeout(deadline);
    resolveDone();
  };
  const event = (name, lease, extra = {}) => onEvent({
    event: name, ...identity, pid: process.pid, renewalEndsAt,
    renewalHealthy: name !== "stopped", expiresAt: lease?.expiresAt ?? null,
    lastRenewedAt: lease?.lastRenewedAt ?? null,
    lastConfirmedExpiresAt: lastConfirmedExpiresAt ?? null, ...extra,
  });
  const renew = async () => {
    try {
      const renewed = await renewLease(active);
      if (!active()) return;
      const lease = read();
      if (!renewed || !lease) { stop("ownership-lost", 1); return; }
      lastConfirmedExpiresAt = lease.expiresAt;
      event(started ? "renewed" : "started", lease);
      started = true;
    } catch (error) { stop("renewal-failed", 1, `Renewal failed: ${error.message}`); }
  };
  const schedule = () => {
    if (pending || !active()) return;
    pending = renew().finally(() => { pending = undefined; });
  };
  const interrupt = signal => stop("interrupted", 128 + constants.signals[signal], signal);
  const onInt = () => interrupt("SIGINT");
  const onTerm = () => interrupt("SIGTERM");
  process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
  try {
    deadline = setTimeout(() => {
      if (!read()) stop("ownership-lost", 1);
      else stop("duration-complete", started ? 0 : 1, started ? undefined : "Lifetime ended before renewal could start.");
    }, durationMs);
    monitor = setInterval(() => { if (!read()) stop("ownership-lost", 1); }, 1000);
    heartbeat = setInterval(schedule, heartbeatMs);
    if (!read()) stop("ownership-lost", 1);
    else schedule();
    await done;
    // The mutex callback checks active again immediately before writing. Wait
    // for its cancelled attempt to settle before reporting a stopped process.
    if (pending) await pending;
    event("stopped", read(), { ...stopped, started });
    return stopped.code;
  } finally {
    clearInterval(heartbeat); clearInterval(monitor); clearTimeout(deadline);
    process.off("SIGINT", onInt); process.off("SIGTERM", onTerm);
  }
}
