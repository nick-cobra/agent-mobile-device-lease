#!/usr/bin/env node
import { acquireMobileBuildLock } from "./lib/mobile-build-lock.mjs";
import { makeArgReader } from "./lib/args.mjs";
import { runChild } from "./lib/run-child.mjs";
import { resolveOwner } from "./lib/owner.mjs";

const separator = process.argv.indexOf("--");
const childArgs = separator < 0 ? [] : process.argv.slice(separator + 1);
const flags = makeArgReader(separator < 0 ? process.argv : process.argv.slice(0, separator));
const owner = resolveOwner({ explicit: flags.argValue("--owner") });
const waitSeconds = Number(flags.argValue("--wait-seconds", "900"));

let release;
try {
  if (!childArgs.length || !Number.isFinite(waitSeconds) || waitSeconds < 0) {
    throw new Error("Usage: node scripts/mobile-build.mjs [--label name] [--wait-seconds 900] -- <build command> [args]");
  }
  release = await acquireMobileBuildLock({
    owner, label: flags.argValue("--label", "mobile build"), waitMs: waitSeconds * 1000,
  });
  process.exitCode = (await runChild(childArgs[0], childArgs.slice(1))).code;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
} finally {
  await release?.();
}
