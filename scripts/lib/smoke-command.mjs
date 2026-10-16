import { spawn, spawnSync } from "node:child_process";

// Only the command we start and groups whose leaders are its descendants are
// signalled. Keep escalation after the leader exits: a grandchild may remain.
export function smokeCommand(command, args, { env, cwd, signal, timeoutMs = 15000 } = {}) {
  const child = spawn(command, args, { env, cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", kind, stopping, timer, settle;
  const stop = reason => {
    if (stopping) return;
    kind = reason;
    const groups = new Set(child.pid ? [child.pid] : []);
    const ps = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: 1000, maxBuffer: 4 * 1024 * 1024 });
    const rows = (ps.stdout ?? "").split("\n").flatMap(line => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
      return m ? [{ pid: +m[1], parent: +m[2], group: +m[3] }] : [];
    });
    const family = new Set(groups);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) if (family.has(row.parent) && !family.has(row.pid)) { family.add(row.pid); changed = true; }
    }
    for (const row of rows) if (family.has(row.pid) && family.has(row.group)) groups.add(row.group);
    const send = sig => { for (const group of groups) { try { process.kill(-group, sig); } catch {} } };
    send("SIGTERM");
    stopping = new Promise(resolve => setTimeout(() => {
      send("SIGKILL");
      // A hidden/reparented process can retain a pipe despite the known groups
      // stopping. Bound the observation too; never claim a successful command.
      child.stdout.destroy(); child.stderr.destroy();
      settle({ code: null }); resolve();
    }, 1500));
    if (ps.status !== 0) kind = "process-inspection-restricted";
  };
  const onAbort = () => stop(signal.reason === "timeout" ? "timeout" : "interrupted");
  const result = new Promise(resolve => {
    settle = resolve;
    child.once("error", error => resolve({ code: null, kind: error.code === "ENOENT" ? "missing-executable" : "spawn-failure" }));
    child.once("close", code => resolve({ code }));
  });
  for (const [stream, append] of [[child.stdout, value => { stdout += value; }], [child.stderr, value => { stderr += value; }]]) {
    stream.on("data", value => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + value.length > 65536) stop("output-limit");
      else append(value.toString());
    });
  }
  signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => stop("timeout"), Math.max(1, timeoutMs));
  if (signal?.aborted) onAbort();
  return { child, result: (async () => {
    try {
      const value = await result;
      if (stopping) await stopping;
      return { ...value, stdout, stderr, kind: kind ?? value.kind };
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); }
  })() };
}
