import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("global and project smoke bins run from offline installations without a tool checkout", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "ml-sm-pack-"));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = { ...process.env, PATH: `${join(root, "bin")}:${dirname(process.execPath)}:${process.env.PATH}`, MOBILE_DEVICE_LEASE_DIR: join(root, "registry") };
  const invoke = (command, args, cwd = root) => {
    const r = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024 });
    assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout;
  };
  try {
    await mkdir(join(root, "bin"));
    const sdk = `#!${process.execPath}
const a=process.argv.slice(2),ios=require('node:path').basename(process.argv[1])==='xcrun';
if(a.includes('version')||a.includes('--version'))console.log(ios?'xcrun version 72.':'Android Debug Bridge version 1.0.41');
else if(a.includes('devices'))console.log(ios?JSON.stringify({devices:{fixture:[{udid:'11111111-1111-4111-8111-111111111111',isAvailable:true,state:'Booted'}]}}):'List of devices attached\\nemulator-5554 device');
else console.log(ios?a[a.indexOf('getenv')+1]:a[a.indexOf('-s')+1]);
`;
    for (const bin of ["adb", "xcrun"]) await writeFile(join(root, "bin", bin), sdk, { mode: 0o755 });
    const tar = JSON.parse(invoke("npm", ["pack", "--json", "--pack-destination", root], source))[0];
    const personal = join(root, "personal"), project = join(root, "project"), caller = join(root, "caller");
    await mkdir(project); await mkdir(caller);
    invoke("npm", ["install", "--offline", "--global", "--prefix", personal, "--ignore-scripts", "--no-audit", "--no-fund", join(root, tar.filename)]);
    invoke("npm", ["install", "--offline", "--prefix", project, "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", join(root, tar.filename)]);
    const expected = JSON.parse(await readFile(join(source, "package.json"), "utf8")).version;
    for (const [bin, platform, device] of [
      [join(personal, "bin/device-lease-smoke"), "android", "emulator-5554"],
      [join(project, "node_modules/.bin/device-lease-smoke"), "ios", "11111111-1111-4111-8111-111111111111"],
    ]) {
      env.MOBILE_DEVICE_FAKE_CAPACITY = device;
      const report = JSON.parse(invoke(bin, ["--platform", platform, "--device", device, "--stubbed", "--json"], caller));
      assert.equal(report.ok, true); assert.equal(report.installedVersion, expected);
      assert.equal(report.validationMode, "stubbed"); assert.equal(report.liveSdkValidated, false);
      assert.equal(report.cleanup, "passed");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
