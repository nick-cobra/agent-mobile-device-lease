import { spawn } from "node:child_process";
import { constants } from "node:os";

// Pass arguments directly to the child; no shell evaluation is involved.
export function runChild(command, args, { env = process.env, capture = false, binary = false, maxBuffer = Infinity, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      env, cwd, detached: grouped,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "", stderr = "", capturedBytes = 0, overflow = false;
    const chunks = [];
    if (capture) {
      const collect = (chunk, isError) => {
        if (overflow) return;
        capturedBytes += chunk.length;
        if (capturedBytes > maxBuffer) { overflow = true; forward("SIGTERM"); return; }
        if (isError) stderr += chunk;
        else if (binary) chunks.push(chunk);
        else stdout += chunk;
      };
      child.stdout.on("data", chunk => collect(chunk, false));
      child.stderr.on("data", chunk => collect(chunk, true));
    }
    const forward = (signal) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") reject(error);
      }
    };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    const cleanup = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      if (overflow) { reject(new Error(`Captured command output exceeded ${maxBuffer} bytes; command stopped.`)); return; }
      resolve({ code: signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1), stdout: binary ? Buffer.concat(chunks) : stdout, stderr });
    });
  });
}
