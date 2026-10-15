import { accessSync, closeSync, constants, fstatSync, openSync, readSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const limits = "At most 64 instruction and 64 launcher paths are supported.";
function fileStatus(path) {
  try {
    if (!statSync(path).isFile()) return { path, status: "not-file" };
    accessSync(path, constants.R_OK);
    return { path, status: "present" };
  } catch (error) {
    return { path, status: error.code === "ENOENT" ? "missing" : "unreadable", ...(error.code === "ENOENT" ? {} : { errorCode: error.code ?? "UNKNOWN" }) };
  }
}
function object(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function validPath(value) { return typeof value === "string" && value.trim().length > 0 && value.length <= 4096 && !value.includes("\0"); }
function validate(config) {
  if (!object(config) || Object.keys(config).some(k => !["version", "instructions", "launchers"].includes(k)) || config.version !== 1) {
    throw Error("Expected version: 1 with optional instructions and launchers arrays; unknown fields are rejected.");
  }
  for (const key of ["instructions", "launchers"]) {
    if (config[key] !== undefined && (!Array.isArray(config[key]) || config[key].length > 64)) throw Error(limits);
  }
  if ((config.instructions ?? []).some(p => !validPath(p))) throw Error("Each instruction must be a non-empty file path.");
  if ((config.launchers ?? []).some(l => !object(l) || Object.keys(l).some(k => !["platform", "path"].includes(k)) || !["android", "ios"].includes(l.platform) || !validPath(l.path))) {
    throw Error("Each launcher needs platform android or ios and a non-empty path; unknown fields are rejected.");
  }
}
function loadConfig(path) {
  // Bounded regular-file reads avoid blocking on a FIFO or dumping configuration
  // contents through Node's JSON parse errors. Configuration is data, never code.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw Error("Configuration must be a regular JSON file.");
    const bytes = Buffer.alloc(65537);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > 65536) throw Error("Configuration exceeds 64 KiB.");
    let config;
    try { config = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw Error("Invalid JSON configuration."); }
    validate(config);
    return config;
  } finally { closeSync(fd); }
}

export function adoptionReport({ scope, configPath, leaseRoot, owner, avdPoolPrefix, env = process.env, cwd = process.cwd(), home = homedir() }) {
  if (!["personal", "project"].includes(scope)) throw Error("adoption-check requires --scope personal or --scope project.");
  const expand = (value, base) => resolve(base, value === "~" ? home : value.startsWith("~/") ? join(home, value.slice(2)) : value);
  const defaultPath = scope === "personal"
    ? join(env.XDG_CONFIG_HOME || join(home, ".config"), "agent-mobile-device-lease/adoption.json")
    : join(cwd, ".mobile-device-lease.json");
  const path = expand(configPath ?? defaultPath, cwd);
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const candidates = scope === "personal" ? [
    join(codexHome, "AGENTS.md"), join(codexHome, "AGENTS.override.md"),
    join(home, ".agents/skills/mobile-device-lease/SKILL.md"),
    join(codexHome, "skills/mobile-device-lease/SKILL.md"),
  ] : [join(cwd, "AGENTS.md"), join(cwd, "AGENTS.override.md"), join(cwd, ".agents/skills/mobile-device-lease/SKILL.md")];
  let config = {}, configStatus = { path, status: "present", source: configPath ? "explicit" : "default" };
  try { config = loadConfig(path); }
  catch (error) {
    configStatus = { ...configStatus, status: error.code === "ENOENT" ? "missing" : "error",
      detail: error.code ? `Configuration could not be read (${error.code}).` : error.message };
  }
  const configured = configStatus.status === "present";
  const instructions = (configured && config.instructions !== undefined
    ? config.instructions.map(p => ({ ...fileStatus(expand(p, dirname(path))), source: "configured" }))
    : candidates.map(p => ({ ...fileStatus(resolve(p)), source: "candidate" })));
  const launchers = (config.launchers ?? []).map(l => ({ ...fileStatus(expand(l.path, dirname(path))), platform: l.platform, source: "configured", targeting: "unverified" }));
  const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
  return {
    ok: (configured || (configStatus.status === "missing" && !configPath)) &&
      [...instructions, ...launchers].every(f => f.status === "present" || (f.status === "missing" && f.source === "candidate")),
    scope, installation: { version, packageRoot, cli: join(packageRoot, "scripts/device-lease.mjs"), node: process.version },
    cwd: resolve(cwd), owner, registry: resolve(leaseRoot), avdPoolPrefix,
    config: configStatus, instructions, launchers, agentLoading: "unverified",
    notes: [
      "File presence does not prove an agent loaded the instructions or a skill was invoked. Confirm in the agent's active session.",
      "Launcher targeting is unverified: inspect internal device selection and test with a captured lease before use.",
      "No launcher declarations means integration is unknown; direct wrapped SDK use needs no adapter.",
      "Compare this registry in every participating environment; installation alone does not establish adoption.",
    ],
  };
}

export function formatAdoption(report) {
  const quoted = value => JSON.stringify(value);
  return [
    `Scope: ${report.scope}`, `Version: ${report.installation.version}`, `Installation: ${quoted(report.installation.packageRoot)}`,
    `CLI: ${quoted(report.installation.cli)}`, `Node: ${report.installation.node}`, `Caller: ${quoted(report.cwd)}`,
    `Registry: ${quoted(report.registry)}`, `Owner: ${quoted(report.owner)}`, `Android pool prefix: ${quoted(report.avdPoolPrefix)}`,
    `Configuration: ${report.config.status} ${quoted(report.config.path)} (${report.config.source})${report.config.detail ? ` — ${report.config.detail}` : ""}`,
    ...report.instructions.map(f => `Instruction: ${f.status} ${quoted(f.path)} (${f.source})`),
    ...report.launchers.map(f => `Launcher: ${f.platform} ${f.status} ${quoted(f.path)} (configured; targeting unverified)`),
    ...(report.launchers.length ? [] : ["Launchers: none declared (integration unknown)"]),
    ...report.notes,
  ].join("\n");
}
