import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

// Installed packages belong to the calling checkout, never node_modules.
export function resolveOwner({ explicit, env = process.env, cwd = process.cwd() } = {}) {
  if (explicit || env.MOBILE_DEVICE_OWNER) return explicit || env.MOBILE_DEVICE_OWNER;
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000,
  });
  const root = git.status === 0 && git.stdout.trim() ? git.stdout.trim() : resolve(cwd);
  return realpathSync(root);
}
