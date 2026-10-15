import { accessSync, constants, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";

export function androidSdkRoot(env = process.env) {
  return env.ANDROID_SDK_ROOT || env.ANDROID_HOME || join(homedir(), "Library/Android/sdk");
}
export function findExecutable(name, { preferred, env = process.env } = {}) {
  const candidates = [preferred, ...(env.PATH ?? "").split(delimiter).map((dir) => resolve(dir || ".", name))].filter(Boolean);
  return candidates.find((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  }) ?? null;
}
export function androidTool(name, env = process.env) {
  const relative = name === "adb" ? "platform-tools/adb" : name === "emulator" ? "emulator/emulator" : `cmdline-tools/latest/bin/${name}`;
  return findExecutable(name, { preferred: join(androidSdkRoot(env), relative), env });
}

function diagnosticOutput(value) {
  const text = String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  return text.length > 4096 ? `${text.slice(0, 4096)}… [truncated]` : text;
}

// Observational SDK probes only. Diagnostics are bounded separately from the
// inventory output so a noisy SDK cannot flood the text or JSON report.
export function probeSdk(name, executable, args, env = process.env) {
  if (!executable) return { ok: false, kind: "missing-executable", detail: `Missing executable ${name}; check SDK installation and PATH` };
  if (!args) return { ok: true, kind: "ok", detail: executable, stdout: "" };
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  if (result.status === 0 && !result.error) return { ok: true, kind: "ok", detail: executable, stdout: result.stdout };
  const stderr = diagnosticOutput(result.stderr), stdout = diagnosticOutput(result.stdout);
  const evidence = `${result.error?.message ?? ""}\n${stderr}\n${stdout}`;
  const kind = result.error?.code === "ENOENT" ? "missing-executable"
    : ["EACCES", "EPERM"].includes(result.error?.code) || /permission denied|operation not permitted|sandbox[^\n]*(?:denied|prohibit)|(?:EACCES|EPERM)\b/i.test(evidence) ? "permission-restriction"
    : result.error?.code === "ETIMEDOUT" ? "timeout"
    : result.error?.code === "ENOBUFS" ? "output-limit" : "sdk-failure";
  const reason = result.error?.message ?? (result.signal ? `command stopped by ${result.signal}` : `command exited ${result.status}`);
  return { ok: false, kind, exitCode: result.status, signal: result.signal, errorCode: result.error?.code ?? null, stderr, stdout,
    detail: `${executable}: ${reason} (${kind})${stderr ? `; stderr: ${stderr}` : ""}${stdout ? `; stdout: ${stdout}` : ""}${kind === "permission-restriction" ? "; check SDK service access and the agent's sandbox/host permissions" : ""}` };
}
