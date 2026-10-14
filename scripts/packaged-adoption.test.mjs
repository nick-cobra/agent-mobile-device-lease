import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("offline personal and project installations coordinate through the same registry", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ml-p-"));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env, MOBILE_DEVICE_LEASE_DIR: join(root, "leases"), MOBILE_DEVICE_FAKE_CAPACITY: "emulator-5554", PATH: `${dirname(process.execPath)}:${process.env.PATH}` };
  for (const key of ["MOBILE_DEVICE_OWNER", "MOBILE_DEVICE_TOKEN", "MOBILE_DEVICE_COMPAT_PREFIX", "MOBILE_AVD_POOL_PREFIX"]) delete env[key];
  const invoke = (command, args, cwd = source) => spawnSync(command, args, { env, cwd, encoding: "utf8", timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
  const succeeds = (result) => { assert.equal(result.status, 0, result.stderr + result.stdout); return result; };
  try {
    const packed = JSON.parse(succeeds(invoke("npm", ["pack", "--json", "--pack-destination", root])).stdout)[0];
    const tarball = join(root, packed.filename);
    const personalPrefix = join(root, "personal");
    const personalApp = join(root, "personal-app");
    const projectApp = join(root, "project-app");
    await mkdir(personalApp);
    await mkdir(projectApp);
    succeeds(invoke("git", ["init", "-q"], personalApp));
    succeeds(invoke("git", ["init", "-q"], projectApp));
    succeeds(invoke("npm", ["install", "--offline", "--global", "--prefix", personalPrefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]));
    succeeds(invoke("npm", ["install", "--offline", "--prefix", projectApp, "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball]));
    const personalCli = join(personalPrefix, "bin/device-lease");
    const projectCli = join(projectApp, "node_modules/.bin/device-lease");
    const acquisition = ["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json"];
    const lease = JSON.parse(succeeds(invoke(personalCli, acquisition, personalApp)).stdout);
    assert.equal(lease.owner, await realpath(personalApp));
    assert.equal(existsSync(join(personalApp, "package.json")), false, "personal installation must not modify the application manifest");
    assert.equal(existsSync(join(personalPrefix, "lib/node_modules/agent-mobile-device-lease/examples/android-personal-task.mjs")), true);
    assert.equal(existsSync(join(projectApp, "node_modules/agent-mobile-device-lease/docs/adoption.md")), true);
    const blocked = invoke(projectCli, acquisition, projectApp);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /held|busy|capacity|available/i);
    const rejected = invoke(personalCli, ["exec", "--platform", "android", "--", "adb", "-s", "emulator-5556", "shell", "true"], personalApp);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /selector|leased device/i);
    succeeds(invoke(personalCli, ["release", "--platform", "android", "--token", lease.token], personalApp));
    const next = JSON.parse(succeeds(invoke(projectCli, acquisition, projectApp)).stdout);
    assert.equal(next.owner, await realpath(projectApp));
    assert.notEqual(next.token, lease.token);
    succeeds(invoke(projectCli, ["release", "--platform", "android", "--token", next.token], projectApp));
  } finally { await rm(root, { recursive: true, force: true }); }
});
