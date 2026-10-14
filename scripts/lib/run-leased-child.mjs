import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:os";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function descendantGroups(pid) {
  const groups = new Set([pid]);
  // Nested wrappers start their own groups. Capture them before signalling the
  // parent, while the ancestry still proves that they belong to this command.
  const result = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid="], {
    encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("Cannot inspect the command process tree with ps; cancellation requires host process access.");
  const rows = result.stdout.split("\n").flatMap((line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    return row ? [{ pid: Number(row[1]), parent: Number(row[2]), group: Number(row[3]) }] : [];
  });
  const descendants = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (descendants.has(row.parent) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
    }
  }
  for (const row of rows) {
    // Never signal a group whose leader is outside the captured ancestry.
    if (descendants.has(row.pid) && descendants.has(row.group)) groups.add(row.group);
  }
  return groups;
}

// The captured lease belongs to the caller. This helper only supervises the
// process group it starts; it never releases a lease or stops a device.
export async function runLeasedChild(argv, {
  env,
  ownsLease,
  renewLease,
  heartbeatMs,
  ownershipPollMs = 1000,
  terminationGraceMs = 750,
}) {
  const [command, ...args] = argv;
  const child = spawn(command, args, { env, stdio: "inherit", detached: true });
  let finished = false, lost = false, interrupted;
  let heartbeat, monitor, renewing = false, stopping;
  let groups;

  const active = () => !finished && !lost && !interrupted;
  const checkOwnership = () => {
    try { return ownsLease() === true; }
    catch { return false; }
  };
  const signalGroup = (signal) => {
    if (!child.pid) return;
    for (const group of groups ?? [child.pid]) {
      try { process.kill(-group, signal); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  };
  const stop = (immediate = false) => {
    if (!groups && child.pid) {
      try { groups = descendantGroups(child.pid); }
      catch (error) {
        // Stop the known group even if host restrictions hide its descendants.
        // The diagnostic makes that protection limit visible to the caller.
        groups = new Set([child.pid]);
        process.stderr.write(`${error.message}\n`);
      }
    }
    if (immediate) signalGroup("SIGKILL");
    if (!stopping) {
      stopping = (async () => {
        if (immediate) return;
        signalGroup("SIGTERM");
        // Keep the escalation even if the group leader exits first: a
        // descendant may ignore SIGTERM and still be using the device.
        await delay(terminationGraceMs);
        signalGroup("SIGKILL");
      })();
    }
    return stopping;
  };
  const loseOwnership = () => {
    if (lost) return;
    lost = true;
    clearInterval(heartbeat);
    clearInterval(monitor);
    stop();
  };
  const onSignal = (signal) => {
    interrupted = signal;
    stop();
  };
  const onInt = () => onSignal("SIGINT");
  const onTerm = () => onSignal("SIGTERM");
  const onExit = () => {
    if (!finished || lost || interrupted) {
      try { stop(true); } catch {}
    }
  };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("exit", onExit);

  try {
    const result = new Promise((resolve, reject) => {
      child.once("error", (error) => reject(new Error(`Could not run ${command}: ${error.message}`)));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    monitor = setInterval(() => {
      if (active() && !checkOwnership()) loseOwnership();
    }, ownershipPollMs);
    heartbeat = setInterval(async () => {
      if (!active() || renewing) return;
      if (!checkOwnership()) { loseOwnership(); return; }
      renewing = true;
      try {
        const renewed = await renewLease(active);
        if (active() && (!renewed || !checkOwnership())) loseOwnership();
      } catch {
        if (active()) loseOwnership();
      } finally { renewing = false; }
    }, heartbeatMs);

    // Cover a transfer between the CLI's initial renewal and child startup.
    if (!checkOwnership()) loseOwnership();
    const { code, signal } = await result;
    finished = true;
    // Fast commands can finish before the first monitor tick.
    if (!checkOwnership()) loseOwnership();
    if (stopping) await stopping;
    return {
      code: lost ? 1 : interrupted ? 128 + constants.signals[interrupted] : signal ? 1 : (code ?? 1),
      lost,
    };
  } catch (error) {
    stop(true);
    if (stopping) await stopping;
    throw error;
  } finally {
    finished = true;
    clearInterval(heartbeat);
    clearInterval(monitor);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("exit", onExit);
  }
}
