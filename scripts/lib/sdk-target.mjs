import { basename } from "node:path";

// Validate only a directly invoked SDK command. Arbitrary scripts and shells
// must implement the same pinning contract in their own launchers.
export function assertSdkTarget(argv, { platform, deviceId }) {
  const executable = basename(argv[0]);
  if (executable === "adb") {
    if (platform !== "android") throw new Error("adb requires an Android leased device.");
    const args = argv.slice(1);
    let i = 0;
    for (; i < args.length && args[i].startsWith("-"); i++) {
      const arg = args[i];
      if (arg === "--exit-on-write-error") continue;
      if (arg === "-s" || arg.startsWith("-s")) {
        const selected = arg === "-s" ? args[++i] : arg.slice(2);
        if (selected !== deviceId) throw new Error(`Refusing adb selector ${selected ?? "(missing)"}; leased device is ${deviceId}.`);
        continue;
      }
      // -d/-e/-t select independently of ANDROID_SERIAL; alternate servers
      // cannot be reconciled with the identities in this local registry.
      throw new Error(`Refusing adb selector or unsupported global option ${arg}; use the leased device ${deviceId}.`);
    }
    if (["kill-server", "disconnect", "connect", "pair", "attach", "detach", "server", "reconnect"].includes(args[i])) {
      throw new Error(`Refusing global adb command ${args[i]} under a device lease.`);
    }
    return;
  }

  let simctlIndex = executable === "simctl" ? 0 : -1;
  if (executable === "xcrun") {
    let i = 1;
    while (argv[i]?.startsWith("-")) {
      if (["--sdk", "-sdk", "--toolchain", "-toolchain"].includes(argv[i])) i += 2;
      else if (["--run", "-r", "--verbose", "-v", "--log", "-l", "--no-cache", "-n"].includes(argv[i])) i++;
      else if (["--find", "-f"].includes(argv[i])) return; // tool lookup only
      else {
        if (argv.includes("simctl")) throw new Error("Unsupported xcrun option; cannot verify its simctl target.");
        return;
      }
    }
    if (argv[i] === "simctl") simctlIndex = i;
  }
  if (simctlIndex < 0) return;
  if (platform !== "ios") throw new Error("simctl requires an iOS leased device.");
  const args = argv.slice(simctlIndex + 1);
  const verb = args[0];
  if (["list", "help"].includes(verb)) return;
  const deviceCommands = new Set([
    "boot", "bootstatus", "shutdown", "erase", "delete", "rename", "upgrade",
    "install", "uninstall", "launch", "terminate", "spawn", "io", "openurl",
    "get_app_container", "listapps", "getenv", "addmedia", "privacy", "ui",
    "status_bar", "location", "keychain", "pbcopy", "pbpaste", "pbsync",
    "notify_post", "notify_get_state", "notify_set_state",
  ]);
  if (!deviceCommands.has(verb)) throw new Error(`Refusing unrecognised or global simctl command ${verb ?? "(missing)"} under a device lease.`);
  let i = 1;
  // launch/spawn may put documented options before the device operand. Unknown
  // options fail closed instead of guessing which argument names the device.
  if (verb === "launch" || verb === "spawn") {
    const switches = new Set(["-w", "--wait-for-debugger", "--console", "--console-pty", "--terminate-running-process", "--standalone"]);
    while (args[i]?.startsWith("-")) {
      const arg = args[i++];
      if (switches.has(arg) || /^--(?:stdout|stderr|arch)=.+/.test(arg)) continue;
      if (["--stdout", "--stderr", "--arch"].includes(arg) && args[i]) { i++; continue; }
      throw new Error(`Unsupported simctl ${verb} option ${arg}; cannot verify its leased device operand.`);
    }
  }
  if (args[i] !== deviceId) throw new Error(`Refusing simctl device ${args[i] ?? "(missing)"}; leased device is ${deviceId}. Use MOBILE_DEVICE.`);
  if (["delete", "erase", "shutdown"].includes(verb) && args.length !== i + 1) throw new Error(`Refusing multiple or ambiguous simctl ${verb} device operands.`);
}
