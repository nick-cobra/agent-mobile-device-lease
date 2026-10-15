import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(source, "scripts/device-lease.mjs");
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ml-a-")));
  const home = join(root, "home"), app = join(root, "app"), registry = join(root, "registry");
  for (const path of [home, app, registry]) mkdirSync(path);
  const sentinel = join(registry, "sentinel");
  writeFileSync(sentinel, "held generation");
  const env = { ...process.env, HOME: home, PATH: "", CODEX_HOME: join(home, ".codex"),
    XDG_CONFIG_HOME: join(home, ".config"), MOBILE_DEVICE_LEASE_DIR: registry, MOBILE_DEVICE_OWNER: app };
  const snapshot = path => readdirSync(path).sort().map(name => {
    const file = join(path, name), stat = lstatSync(file);
    return [name, stat.mode, stat.isDirectory() ? snapshot(file) : readFileSync(file).toString("base64")];
  });
  const run = args => {
    const before = snapshot(root);
    const result = spawnSync(process.execPath, [cli, "adoption-check", ...args], { env, cwd: app, encoding: "utf8", timeout: 5000 });
    assert.deepEqual(snapshot(root), before, "inspection must not change the application, home or registry");
    return result;
  };
  try { fn({ root, home, app, registry, env, run }); assert.equal(readFileSync(sentinel, "utf8"), "held generation"); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("adoption check reports this installation and missing personal candidates without SDK access", () => fixture(f => {
  const r = f.run(["--scope", "personal", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.installation.version, JSON.parse(readFileSync(join(source, "package.json"))).version);
  assert.equal(report.installation.packageRoot, source);
  assert.equal(report.registry, f.registry);
  assert.equal(report.owner, f.app);
  assert.equal(report.config.status, "missing");
  assert.ok(report.instructions.some(x => x.path === join(f.home, ".agents/skills/mobile-device-lease/SKILL.md") && x.status === "missing"));
  assert.equal(report.agentLoading, "unverified");
  assert.deepEqual(report.launchers, []);
}));

test("configured paths resolve relative to the config and are observed without executing or reading instructions", () => fixture(f => {
  const dir = join(f.root, "personal adapters"); mkdirSync(dir);
  writeFileSync(join(dir, "rules.md"), "SECRET_INSTRUCTION_CONTENT");
  writeFileSync(join(dir, "launcher.mjs"), "throw Error('must never execute')");
  const path = join(dir, "adoption.json");
  writeFileSync(path, JSON.stringify({ version: 1, instructions: ["rules.md", "missing.md", "~/other-rules.md"], launchers: [{ platform: "ios", path: "launcher.mjs" }] }));
  const args = ["--scope", "personal", "--config", path];
  const r = f.run([...args, "--json"]); assert.equal(r.status, 1, "explicit missing instruction paths are a configuration problem");
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.instructions.map(x => x.status), ["present", "missing", "missing"]);
  assert.equal(report.instructions[2].path, join(f.home, "other-rules.md"));
  assert.equal(report.launchers[0].path, join(dir, "launcher.mjs"));
  assert.equal(report.launchers[0].targeting, "unverified");
  assert.equal(r.stdout.includes("SECRET_INSTRUCTION_CONTENT"), false);
  const text = f.run(args); assert.equal(text.status, 1);
  assert.match(text.stderr, /Version:/); assert.match(text.stderr, /Registry:/);
  assert.match(text.stderr, /Instruction.*present/); assert.match(text.stderr, /Launcher.*ios.*present/);
  assert.match(text.stderr, /does not prove.*loaded/);
}));

test("project default configuration is local to the caller, not the installed package", () => fixture(f => {
  writeFileSync(join(f.app, ".mobile-device-lease.json"), JSON.stringify({ version: 1, instructions: ["AGENTS.md"], launchers: [] }));
  writeFileSync(join(f.app, "AGENTS.md"), "rules");
  const r = f.run(["--scope", "project", "--json"]); assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(r.stdout);
  assert.equal(report.config.path, join(f.app, ".mobile-device-lease.json"));
  assert.equal(report.instructions[0].status, "present");
}));

for (const [label, value] of [
  ["invalid JSON", '{"secret":"DO_NOT_ECHO",'],
  ["unknown keys", JSON.stringify({ version: 1, secret: "DO_NOT_ECHO" })],
  ["invalid launcher", JSON.stringify({ version: 1, launchers: [{ platform: "other", path: "launcher" }] })],
  ["oversized", " ".repeat(65537)],
]) test(`adoption check rejects ${label} without echoing configuration contents`, () => fixture(f => {
  const path = join(f.root, "config.json"); writeFileSync(path, value);
  const r = f.run(["--scope", "personal", "--config", path, "--json"]);
  assert.equal(r.status, 1);
  const report = JSON.parse(r.stdout); assert.equal(report.ok, false);
  assert.equal(report.config.status, "error");
  assert.equal((r.stdout + r.stderr).includes("DO_NOT_ECHO"), false);
}));

test("explicit missing config and non-file instruction locations are distinguished", () => fixture(f => {
  const missing = JSON.parse(f.run(["--scope", "personal", "--config", "absent.json", "--json"]).stdout);
  assert.equal(missing.ok, false); assert.equal(missing.config.status, "missing");
  writeFileSync(join(f.app, ".mobile-device-lease.json"), JSON.stringify({ version: 1, instructions: ["."] }));
  const r = f.run(["--scope", "project", "--json"]); assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).instructions[0].status, "not-file");
}));

test("adoption check requires an explicit scope and complete option values", () => fixture(f => {
  for (const args of [[], ["--scope", "other"], ["--scope", "personal", "--config"], ["--scope", "--json"]]) {
    const r = f.run(args); assert.equal(r.status, 1); assert.match(r.stderr, /scope|config/);
  }
}));
