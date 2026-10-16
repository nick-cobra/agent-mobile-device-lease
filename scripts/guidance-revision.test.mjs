import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const source = dirname(dirname(fileURLToPath(import.meta.url)));
const marker = revision => `<!-- agent-mobile-device-lease-guidance: ${revision} -->`;
function fixture(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ml-rev-"))), app = join(root, "app"), registry = join(root, "registry");
  mkdirSync(app); mkdirSync(registry);
  writeFileSync(join(registry, "sentinel"), "same-generation");
  const rules = join(app, "AGENTS.md"), config = join(app, ".mobile-device-lease.json");
  const env = { ...process.env, HOME: join(root, "home"), CODEX_HOME: join(root, "home/.codex"), XDG_CONFIG_HOME: join(root, "home/.config"), MOBILE_DEVICE_LEASE_DIR: registry, MOBILE_DEVICE_OWNER: app, PATH: "" };
  const run = (contents, { inspect = true, json = true, scope = "project" } = {}) => {
    writeFileSync(rules, contents);
    writeFileSync(config, JSON.stringify({ version: 1, instructions: [inspect ? { path: "AGENTS.md", inspectGuidance: true } : "AGENTS.md"] }));
    const result = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", scope, "--config", config, ...(json ? ["--json"] : [])], { cwd: app, env, encoding: "utf8", timeout: 5000 });
    assert.equal(readFileSync(rules, "utf8"), contents, "guidance inspection must be read-only");
    assert.equal(readFileSync(join(registry, "sentinel"), "utf8"), "same-generation");
    return { ...result, report: json ? JSON.parse(result.stdout) : undefined };
  };
  try { fn({ root, app, env, registry, rules, config, run }); }
  finally { try { chmodSync(rules, 0o600); } catch {} rmSync(root, { recursive: true, force: true }); }
}

for (const [value, status, declared] of [
  [marker(1), "matching", 1],
  [marker(0), "outdated", 0],
  [marker(2), "newer", 2],
  ["custom unversioned guidance", "missing", null],
  [marker("1.0"), "unknown", null],
  [marker("not-a-number"), "unknown", null],
  [marker("9007199254740992"), "unknown", null],
  [`${marker(1)}\n${marker(1)}`, "ambiguous", null],
  [`${marker(1)}\n${marker(2)}`, "ambiguous", null],
  [`${marker(1)}\n${marker("bad")}`, "ambiguous", null],
]) test(`guidance reports ${status} for ${JSON.stringify(value)}`, () => fixture(f => {
  const result = f.run(value + "\nPRIVATE_RULE_TEXT_MUST_NOT_APPEAR");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.installation.guidanceRevision, 1);
  const inspected = result.report.instructions[0].guidance;
  assert.equal(inspected.expectedRevision, 1); assert.equal(inspected.status, status);
  assert.equal(inspected.declaredRevision, declared);
  assert.equal(result.report.agentLoading, "unverified");
  assert.equal((result.stdout + result.stderr).includes("PRIVATE_RULE_TEXT_MUST_NOT_APPEAR"), false);
}));

test("legacy string declarations remain presence-only without reading marker content", () => fixture(f => {
  const result = f.run(marker(1), { inspect: false });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.instructions[0].guidance.status, "unknown");
  assert.equal(result.report.instructions[0].guidance.declaredRevision, null);
  assert.equal(result.report.instructions[0].guidance.reason, "inspection-not-enabled");
}));

test("default candidates remain presence-only even with a current marker", () => fixture(f => {
  writeFileSync(f.rules, marker(1));
  const result = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  const candidate = JSON.parse(result.stdout).instructions.find(x => x.path === f.rules);
  assert.equal(candidate.guidance.status, "unknown"); assert.equal(candidate.guidance.reason, "unconfigured-candidate");
}));

test("oversized guidance cannot claim a matching marker from a partial read", () => fixture(f => {
  const result = f.run(marker(1) + "\n" + "x".repeat(65536));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.instructions[0].guidance.status, "unknown");
  assert.equal(result.report.instructions[0].guidance.reason, "read-limit");
}));

test("personal text reports expected and declared revisions without exposing rules", () => fixture(f => {
  const result = f.run(marker(1) + "\nDO_NOT_ECHO_THIS_RULE", { json: false, scope: "personal" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /guidance.*matching.*expected=1.*declared=1/i);
  assert.doesNotMatch(result.stderr, /DO_NOT_ECHO_THIS_RULE/);
  assert.match(result.stderr, /does not prove.*loaded/);
}));

test("an explicitly disabled guidance check preserves presence-only behaviour", () => fixture(f => {
  writeFileSync(f.rules, marker(1));
  writeFileSync(f.config, JSON.stringify({ version: 1, instructions: [{ path: "AGENTS.md", inspectGuidance: false }] }));
  const r = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).instructions[0].guidance.reason, "inspection-not-enabled");
}));

test("guidance opt-in rejects unknown keys and non-boolean inspection flags", () => fixture(f => {
  writeFileSync(f.rules, marker(1));
  for (const value of [{ path: "AGENTS.md", inspectGuidance: "yes" }, { path: "AGENTS.md", inspectGuidance: true, secret: "DO_NOT_ECHO" }]) {
    writeFileSync(f.config, JSON.stringify({ version: 1, instructions: [value] }));
    const r = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1); assert.equal(JSON.parse(r.stdout).config.status, "error");
    assert.doesNotMatch(r.stdout + r.stderr, /DO_NOT_ECHO/);
  }
}));

test("missing and non-file opted-in guidance remain distinct inspection errors", () => fixture(f => {
  writeFileSync(f.config, JSON.stringify({ version: 1, instructions: [{ path: "absent.md", inspectGuidance: true }, { path: ".", inspectGuidance: true }] }));
  const r = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 5000 });
  assert.equal(r.status, 1, r.stderr);
  const files = JSON.parse(r.stdout).instructions;
  assert.equal(files[0].guidance.status, "missing"); assert.equal(files[0].guidance.reason, "file-missing");
  assert.equal(files[1].guidance.status, "unknown"); assert.equal(files[1].guidance.reason, "file-not-file");
}));

test("unreadable opted-in guidance reports permissions without rule content", { skip: process.getuid?.() === 0 ? "Root can read mode-000 files" : false }, () => fixture(f => {
  writeFileSync(f.rules, "PRIVATE_UNREADABLE_RULE"); chmodSync(f.rules, 0);
  writeFileSync(f.config, JSON.stringify({ version: 1, instructions: [{ path: "AGENTS.md", inspectGuidance: true }] }));
  try {
    const r = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 5000 });
    assert.equal(r.status, 1, r.stderr);
    const file = JSON.parse(r.stdout).instructions[0];
    assert.equal(file.status, "unreadable"); assert.equal(file.guidance.status, "unknown");
    assert.doesNotMatch(r.stdout + r.stderr, /PRIVATE_UNREADABLE_RULE/);
  } finally { chmodSync(f.rules, 0o600); }
}));

test("an opted-in FIFO is rejected without opening or blocking on its contents", () => fixture(f => {
  const fifo = join(f.app, "pipe");
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8", timeout: 3000 }); assert.equal(made.status, 0, made.stderr);
  writeFileSync(f.config, JSON.stringify({ version: 1, instructions: [{ path: fifo, inspectGuidance: true }] }));
  const r = spawnSync(process.execPath, [join(source, "scripts/device-lease.mjs"), "adoption-check", "--scope", "project", "--json"], { cwd: f.app, env: f.env, encoding: "utf8", timeout: 3000 });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(JSON.parse(r.stdout).instructions[0].guidance.reason, "file-not-file");
}));
