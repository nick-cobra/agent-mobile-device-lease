import { spawn } from "node:child_process";
import { constants } from "node:os";

// Pass arguments directly to the child; no shell evaluation is involved.
export function runChild(command, args, { env = process.env, capture = false, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(command, args, {
      env, cwd, detached: grouped,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
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
      resolve({ code: signal ? 128 + (constants.signals[signal] ?? 1) : (code ?? 1), stdout, stderr });
    });
  });
}
