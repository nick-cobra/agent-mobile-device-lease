import { accessSync, constants, statSync } from "node:fs";
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
