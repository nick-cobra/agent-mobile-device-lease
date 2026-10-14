#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { makeArgReader } from "./lib/args.mjs";
import {
  DEFAULT_AVD_POOL_SIZE,
  PINNED_SYSTEM_IMAGE_PACKAGE,
  avdPoolNames,
  hasPinnedSystemImage,
  parseAvdNames,
  parseAvdPath,
  resolveAvdHome,
  resolveAvdPoolPrefix,
  toSystemImagePackage,
  withHardwareKeyboard,
} from "./lib/device-lease.mjs";

const { argValue, hasArg } = makeArgReader(process.argv);

const sdkRoot =
  process.env.ANDROID_SDK_ROOT ||
  process.env.ANDROID_HOME ||
  join(homedir(), "Library/Android/sdk");
const size = Number(argValue("--size", String(DEFAULT_AVD_POOL_SIZE)));
const deviceProfile = argValue("--device-profile", "pixel_6");
const requestedPackage = argValue("--package", process.env.MOBILE_ANDROID_SYSTEM_IMAGE);
let avdPoolPrefix;
try {
  const requestedPrefix = argValue("--avd-prefix", process.env.MOBILE_AVD_POOL_PREFIX);
  if (hasArg("--avd-prefix") && (!requestedPrefix || requestedPrefix.startsWith("--"))) fail("--avd-prefix requires an explicit value.");
  avdPoolPrefix = resolveAvdPoolPrefix(requestedPrefix);
} catch (error) { fail(error.message); }


function bin(relative, fallback) {
  const candidate = join(sdkRoot, relative);
  return existsSync(candidate) ? candidate : fallback;
}

const avdHome = resolveAvdHome(process.env, homedir());

const emulatorBin = bin("emulator/emulator", "emulator");
const avdManagerBin = bin("cmdline-tools/latest/bin/avdmanager", "avdmanager");

function output(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return result.status === 0 ? result.stdout : null;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function installedSystemImages() {
  const root = join(sdkRoot, "system-images");
  if (!existsSync(root)) return [];

  const images = [];
  for (const api of readdirSync(root)) {
    const apiDir = join(root, api);
    for (const tag of safeReadDir(apiDir)) {
      for (const abi of safeReadDir(join(apiDir, tag))) {
        images.push({ api, tag, abi });
      }
    }
  }
  return images;
}

function safeReadDir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function existingAvds() {
  const stdout = output(emulatorBin, ["-list-avds"]);
  if (stdout === null) {
    fail(`Could not run "${emulatorBin} -list-avds". Install the Android emulator package.`);
  }
  return parseAvdNames(stdout);
}

if (hasArg("--list")) {
  const existing = existingAvds();
  console.log(`AVDs (${existing.length}):`);
  for (const name of existing) {
    console.log(`  ${name}${name.startsWith(`${avdPoolPrefix}-`) ? "  (pool)" : ""}`);
  }
  process.exit(0);
}

if (!Number.isInteger(size) || size < 1) {
  fail("--size must be a positive integer.");
}

const image = requestedPackage
  ? { package: requestedPackage }
  : (() => {
      const installed = installedSystemImages();
      if (!hasPinnedSystemImage(installed)) {
        fail(
          `The pinned system image is not installed: ${PINNED_SYSTEM_IMAGE_PACKAGE}\n\n` +
            "Install it:\n" +
            `  sdkmanager "${PINNED_SYSTEM_IMAGE_PACKAGE}"\n\n` +
            "Or choose one yourself, having checked that it boots:\n" +
            "  pnpm android:avds --package <system-images;api;tag;abi>\n\n" +
            `Installed under ${join(sdkRoot, "system-images")}:\n` +
            (installed.length === 0
              ? "  (none)"
              : installed.map((entry) => `  ${toSystemImagePackage(entry)}`).join("\n")),
        );
      }
      return { package: PINNED_SYSTEM_IMAGE_PACKAGE };
    })();

const existing = new Set(existingAvds());
const wanted = avdPoolNames(size, avdPoolPrefix);
const missing = wanted.filter((name) => !existing.has(name));

console.log(`System image: ${image.package}`);
console.log(`Pool: ${wanted.join(", ")}`);

if (missing.length === 0) {
  console.log("Every pool AVD already exists. Nothing to do.");
  process.exit(0);
}

for (const name of missing) {
  console.log(`Creating ${name}…`);
  const result = spawnSync(
    avdManagerBin,
    ["create", "avd", "--name", name, "--package", image.package, "--device", deviceProfile],
    { encoding: "utf8", input: "no\n", stdio: ["pipe", "inherit", "inherit"] },
  );

  if (result.status !== 0) {
    fail(
      `Failed to create ${name}. If the device profile is unknown, pass ` +
        `--device-profile <id> (see \`${avdManagerBin} list device\`).`,
    );
  }

  enableHardwareKeyboard(name);
}

console.log(
  `\nCreated ${missing.length} AVD(s). Agents now acquire one with:\n` +
    `  eval "$(node scripts/device-lease.mjs acquire --platform android)"`,
);
function enableHardwareKeyboard(name) {
  const pointer = readIfPresent(join(avdHome, `${name}.ini`));
  const avdDir = pointer === undefined ? undefined : parseAvdPath(pointer);
  const configPath = join(avdDir ?? join(avdHome, `${name}.avd`), "config.ini");

  const current = readIfPresent(configPath);
  if (current === undefined) {
    console.warn(`  Warning: no config.ini at ${configPath}; hw.keyboard left unset for ${name}.`);
    return;
  }

  const updated = withHardwareKeyboard(current);
  if (updated === current) return;

  try {
    writeFileSync(configPath, updated);
  } catch (error) {
    console.warn(
      `  Warning: could not enable hw.keyboard for ${name} (${configPath}): ${error.message}\n` +
        "  Typing on that emulator will not work until `hw.keyboard = yes` is set there.",
    );
  }
}

function readIfPresent(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
