#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { makeArgReader } from "./lib/args.mjs";
import { isPlatform } from "./lib/device-lease.mjs";
import { runChild } from "./lib/run-child.mjs";
import { resolveOwner } from "./lib/owner.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const cli = resolve(scriptDir, "device-lease.mjs");
const separator = process.argv.indexOf("--");
const childArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const flags = makeArgReader(separator < 0 ? process.argv : process.argv.slice(0, separator));
const platform = flags.argValue("--platform", process.env.MOBILE_DEVICE_PLATFORM);
const owner = resolveOwner({ explicit: flags.argValue("--owner") });
const env = { ...process.env };
// A new session must never inherit a prior run's acquisition token.
delete env.MOBILE_DEVICE_TOKEN;

let lease;
try {
  if (!isPlatform(platform) || !childArgs.length) {
    throw new Error("Usage: node scripts/device-session.mjs --platform <android|ios> [lease options] -- <command> [args]");
  }
  const acquireArgs = [cli, "acquire", "--platform", platform, "--owner", owner, "--exclusive", "--json"];
  for (const flag of ["--device", "--label", "--ttl-minutes", "--wait-seconds", "--ios-family"]) {
    if (!flags.hasArg(flag)) continue;
    const value = flags.argValue(flag, "");
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires an explicit value.`);
    acquireArgs.push(flag, value);
  }
  if (flags.hasArg("--no-boot")) acquireArgs.push("--no-boot");
  const acquired = await runChild(process.execPath, acquireArgs, { env, capture: true });
  if (acquired.stderr) process.stderr.write(acquired.stderr);
  if (acquired.code !== 0) throw new Error("Device acquisition failed; the session command was not started.");
  lease = JSON.parse(acquired.stdout);
  if (lease.platform !== platform || lease.owner !== owner || !lease.deviceId || !lease.token) {
    throw new Error("Acquisition did not return a valid lease identity.");
  }
  const execArgs = [cli, "exec", "--platform", platform, "--owner", owner, "--token", lease.token];
  if (flags.hasArg("--ttl-minutes")) execArgs.push("--ttl-minutes", flags.argValue("--ttl-minutes"));
  process.exitCode = (await runChild(process.execPath, [...execArgs, "--", ...childArgs], { env })).code;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (lease?.token) {
    const released = await runChild(process.execPath, [cli, "release", "--platform", platform, "--owner", owner, "--token", lease.token], { env, capture: true });
    if (released.stderr) process.stderr.write(released.stderr);
    if (released.code !== 0) process.exitCode = process.exitCode || released.code;
  }
}
