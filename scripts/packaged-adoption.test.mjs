import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
    const expectedVersion = JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
    for (const [installedCli, app, packageRoot, scope] of [
      [personalCli, personalApp, join(personalPrefix, "lib/node_modules/agent-mobile-device-lease"), "personal"],
      [projectCli, projectApp, join(projectApp, "node_modules/agent-mobile-device-lease"), "project"],
    ]) {
      const config = join(root, `${scope}-adoption.json`);
      const skill = join(packageRoot, "examples/skills/mobile-device-lease/SKILL.md");
      await writeFile(config, JSON.stringify({ version: 1, instructions: [skill], launchers: [{ platform: "ios", path: join(packageRoot, "examples/ios-personal-task.mjs") }] }));
      const report = JSON.parse(succeeds(invoke(installedCli, ["adoption-check", "--scope", scope, "--config", config, "--json"], app)).stdout);
      assert.equal(report.installation.version, expectedVersion);
      assert.equal(await realpath(report.installation.packageRoot), await realpath(packageRoot));
      assert.equal(report.registry, env.MOBILE_DEVICE_LEASE_DIR);
      assert.equal(report.owner, await realpath(app));
      assert.equal(report.instructions[0].status, "present");
      assert.equal(report.launchers[0].status, "present");
      assert.equal(report.agentLoading, "unverified");
      assert.equal(report.launchers[0].targeting, "unverified");
      const copiedSkill = join(root, `${scope}-skill/SKILL.md`);
      await mkdir(dirname(copiedSkill)); await copyFile(skill, copiedSkill);
      assert.equal(await readFile(copiedSkill, "utf8"), await readFile(skill, "utf8"));
    }
    const acquisition = ["acquire", "--platform", "android", "--no-boot", "--wait-seconds", "0", "--json"];
    const lease = JSON.parse(succeeds(invoke(personalCli, acquisition, personalApp)).stdout);
    assert.equal(lease.owner, await realpath(personalApp));
    assert.equal(existsSync(join(personalApp, "package.json")), false, "personal installation must not modify the application manifest");
    assert.equal(existsSync(join(personalPrefix, "lib/node_modules/agent-mobile-device-lease/examples/android-personal-task.mjs")), true);
    assert.equal(existsSync(join(projectApp, "node_modules/agent-mobile-device-lease/docs/adoption.md")), true);
    const executed = succeeds(invoke(personalCli, ["exec", "--platform", "android", "--", process.execPath, "-e", "process.stdout.write(JSON.stringify({owner:process.env.MOBILE_DEVICE_OWNER,deviceId:process.env.MOBILE_DEVICE_ID,token:process.env.MOBILE_DEVICE_TOKEN}))"], personalApp));
    assert.deepEqual(JSON.parse(executed.stdout), { owner: lease.owner, deviceId: lease.deviceId, token: lease.token }, "packaged execution helper retains the captured identity");
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

    // Execute copied examples outside the package: global npm modules are not
    // normally importable from a personal script's directory. The executing
    // CLI supplies the installed helper URL, without adding app dependencies.
    const bin = join(root, "sdk");
    await mkdir(bin);
    env.PATH = `${bin}:${env.PATH}`;
    env.AMDL_CALL_LOG = join(root, "sdk-calls");
    const sdk = `#!${process.execPath}
const f=require('node:fs'), args=process.argv.slice(2);
f.appendFileSync(process.env.AMDL_CALL_LOG, JSON.stringify({tool:require('node:path').basename(process.argv[1]),args})+'\\n');
if(args.includes('instrument')) console.log('OK (1 test)');
if(args.includes('exec-out')) process.stdout.write(Buffer.from([0,255,128,10]));
if(args.includes('screenshot')) f.writeFileSync(args.at(-1),'ios-image');
if(process.env.AMDL_TEST_FAILURE==='1' && args.includes('test-without-building')) process.exit(65);
`;
    for (const name of ["adb", "xcrun", "xcodebuild"]) await writeFile(join(bin, name), sdk, { mode: 0o755 });
    for (const [installedCli, app, packageRoot, scope] of [
      [personalCli, personalApp, join(personalPrefix, "lib/node_modules/agent-mobile-device-lease"), "personal"],
      [projectCli, projectApp, join(projectApp, "node_modules/agent-mobile-device-lease"), "project"],
    ]) {
      for (const platform of ["android", "ios"]) {
        env.MOBILE_DEVICE_FAKE_CAPACITY = platform === "android" ? "emulator-5554" : "SIM-OWNED";
        const owned = JSON.parse(succeeds(invoke(installedCli, ["acquire", "--platform", platform, "--no-boot", "--wait-seconds", "0", "--json"], app)).stdout);
        const example = join(root, `${scope}-${platform}-task.mjs`);
        await copyFile(join(packageRoot, `examples/${platform}-personal-task.mjs`), example);
        const shot = join(root, `${scope}-${platform}.png`);
        const args = platform === "android" ? ["app.apk", "tests.apk", "com.example.app.test/Runner", shot] : ["Example.app", "Tests.xctestrun", "com.example.app", shot];
        succeeds(invoke(installedCli, ["exec", "--platform", platform, "--token", owned.token, "--", process.execPath, example, ...args], app));
        assert.deepEqual(await readFile(shot), platform === "android" ? Buffer.from([0,255,128,10]) : Buffer.from("ios-image"));
        const meta = JSON.parse(await readFile(join(env.MOBILE_DEVICE_LEASE_DIR, platform, `${owned.deviceId}.lock/meta.json`), "utf8"));
        assert.equal(meta.token, owned.token, "manual workflow retains the captured lease after screenshots");
        if (platform === "ios") {
          env.AMDL_TEST_FAILURE = "1";
          await rm(shot);
          const failed = invoke(installedCli, ["exec", "--platform", platform, "--token", owned.token, "--", process.execPath, example, ...args], app);
          assert.notEqual(failed.status, 0);
          assert.equal(existsSync(shot), false, "failed XCTest must prevent later launch/capture");
          delete env.AMDL_TEST_FAILURE;
        } else if (scope === "project") {
          const imported = succeeds(invoke(installedCli, ["exec", "--platform", platform, "--", process.execPath, "--input-type=module", "-e", 'import {captureDevice} from "agent-mobile-device-lease/scripts/lib/adapter.mjs"; console.log(captureDevice().identity.deviceId)'], app));
          assert.equal(imported.stdout.trim(), owned.deviceId);
        }
        succeeds(invoke(installedCli, ["release", "--platform", platform, "--token", owned.token], app));
      }
    }
    const calls = (await readFile(env.AMDL_CALL_LOG, "utf8")).trim().split("\n").map(JSON.parse);
    for (const call of calls) {
      if (call.tool === "adb") assert.deepEqual(call.args.slice(0,2), ["-s", "emulator-5554"]);
      if (call.tool === "xcodebuild") {
        assert.ok(call.args.includes("platform=iOS Simulator,id=SIM-OWNED"));
        assert.deepEqual(call.args.slice(-2), ["-parallel-testing-enabled", "NO"]);
      }
    }
    assert.equal(existsSync(join(personalApp, "package.json")), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
