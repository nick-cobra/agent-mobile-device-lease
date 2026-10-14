# Agent Mobile Device Lease guide

## How device leasing works

We give each agent's Git worktree an exclusive, renewable **device lease**. The
lease records which Android emulator or iOS simulator that worktree owns. Our
launchers, installation commands and screenshot commands resolve that lease and
target the same device throughout the task.

This prevents one agent from installing its build while another agent is taking
screenshots or testing on that device. When every device is occupied, a new agent
waits for capacity instead of taking another agent's device.

The design can be reused with any mobile stack. Its essential parts are a shared
lease registry, consistent owner identity, safe concurrent updates, explicit
device targeting and renewal. Build commands and application identifiers are
project-specific adapters.

The package supplies the lease manager, execution and session wrappers, Android
pool provisioner and build-slot wrapper. Install it once for personal use or
pin it in the application for team use, then use its command-line tools. Application build and preview launchers remain
project-specific integrations; the `dev:*:local` examples below illustrate those
launchers and are not provided by this package.

Choose [personal or project/team adoption](adoption.md) before integrating.
Installation alone does not make agents participate.

**Scope:** this is a cooperative protocol on one development machine. It does
not make the emulator reject commands from an unrelated process. Every agent,
launcher and automation tool using the shared pool must participate. The default
registry is shared across worktrees running as the same operating-system user.

## The normal agent workflow

Each parallel agent works in its own checkout. Run these commands from that
checkout, after starting the local web/API server.

These project examples use the optional package-script aliases shown below.
Without aliases, use `pnpm exec device-lease`; personal installations use
`device-lease` directly. The lease engines stay in the installed library.

### Android

```sh
# Acquire a device before building or interacting with the UI.
pnpm -s device:lease acquire --platform android

# Replace <web-port> with the port printed by the local server.
pnpm dev:android:local --port <web-port>

# The wrapper injects the leased Android serial into the child process.
pnpm -s device:lease exec --platform android -- adb shell input tap 540 1200
pnpm -s device:lease exec --platform android -- adb exec-out screencap -p > shot.png

# Release after the entire device session is finished.
pnpm -s device:lease release --platform android
```

### iOS

```sh
pnpm -s device:lease acquire --platform ios
pnpm dev:ios:local --port <web-port>

# MOBILE_DEVICE is replaced with the leased simulator UDID.
pnpm -s device:lease exec --platform ios -- xcrun simctl io MOBILE_DEVICE screenshot shot.png

pnpm -s device:lease release --platform ios
```

`simctl` needs an explicit device operand; an environment variable alone does
not select its target. The wrapper rejects a literal `booted` operand because
it can resolve to another worktree's simulator.

The `dev:*:local` commands above represent project-specific adapters. Implement
them with the lease checks described below. Select the local backend deliberately
and document how each launcher behaves when `--port` is omitted.

Useful management commands:

```sh
pnpm -s device:lease list
pnpm -s device:lease renew --platform android
pnpm -s device:lease recover --platform android
pnpm -s device:lease recover --platform ios

# Without --platform, release checks both platforms for this owner.
pnpm -s device:lease release
```

`list` reports device, age, owner and expired state to stderr. `acquire` prints
shell-compatible assignments to stdout, including the device ID and acquisition
token. Ordinary separate-shell use does not require evaluating those assignments.

## Why ownership lives on disk

Agent tool calls often start a fresh shell. An `export ANDROID_SERIAL=...` in one
call will not necessarily exist in the next. Recording ownership only in shell
variables therefore leaves the launcher free to select a different device.

Store leases outside the repository:

```text
$XDG_STATE_HOME/shared-mobile/device-leases/
  android/
    .lease-op.sock
    emulator-5554.lock/
      meta.json
  ios/
    .lease-op.sock
    <simulator-udid>.lock/
      meta.json
```

When `XDG_STATE_HOME` is unset, its base is `~/.local/state`.
`MOBILE_DEVICE_LEASE_DIR` overrides the entire lease root.

An illustrative lease record is:

```json
{
  "deviceId": "emulator-5554",
  "owner": "/worktrees/project/task-a",
  "token": "unique-acquisition-uuid",
  "label": "task-a visual review",
  "acquiredAt": "2026-10-14T00:00:00.000Z",
  "expiresAt": "2026-10-14T04:00:00.000Z"
}
```

The owner defaults to the caller's Git checkout root, resolved from the command's
working directory and canonicalised to its real path. Outside Git, it uses the
current directory. Installing the CLI into `node_modules` does not change this
identity. Preview launchers must use the same owner, so their lookups agree
across separate processes. A process ID would be a poor owner because the
acquisition command exits before the next agent command starts.

One owner can hold at most one device per platform. Reacquiring normally returns
and renews its existing available device. If that device has disappeared, the
manager can claim a replacement and remove the owner's obsolete lease.

Two agents sharing the same checkout share this default identity and can reuse
the same lease. Use separate worktrees for independent agents. The CLI supports
`--owner` / `MOBILE_DEVICE_OWNER`, but the preview launchers must use
the same owner; a custom owner needs corresponding launcher changes.

## How acquisition stays consistent under concurrency

A file containing a device ID is insufficient when several agents can update
it simultaneously. The design combines a persistent device claim with a short-lived
mutex around changes to the registry.

For each platform, acquisition performs these steps:

1. Discover eligible devices outside the mutation mutex.
2. Enter the platform's lease-operation mutex.
3. Read the current leases and reclaim expired records.
4. Reuse this owner's device, claim a free device, or report that capacity is full.
5. Write or renew metadata and verify the acquisition token.
6. Leave the mutex before waiting or attempting to boot additional Android capacity.

The device claim uses `mkdir` on `<deviceId>.lock`. An existing directory makes
that claim fail. Each new claim gets a random UUID token, and the manager reads
it back before reporting success.

The mutation mutex uses a Unix domain socket at `.lease-op.sock`. A listening
process holds the critical section; contenders wait. When the process exits,
its listener closes. The lease manager also handles the socket filesystem entry that can
remain after a crash by probing it and reclaiming the abandoned entry. The
installed library owns this implementation and its concurrency tests.

The mutex covers acquisition, renewal, release and expired-record removal.
Expired-record removal rechecks the on-disk record before deleting it. Renewal
writes a temporary metadata file and atomically renames it over `meta.json`,
leaving the claim directory in place.

These details matter because a stale read can otherwise remove a newly issued
lease or renew a successor's record. Do not replace this protocol with a
read-then-write JSON file or a check that merely asks whether a lock file exists.

## Expiry renewal and acquisition tokens

The reference lease lifetime is **240 minutes**, and its default capacity wait
is **1800 seconds**. Both are configurable. The minimum accepted lease lifetime
is one minute.

Expiry comes from the holder's stored `expiresAt`. A contender's shorter
`--ttl-minutes` must not shorten somebody else's existing lease. Reclamation is
performed when acquisition scans the registry; there is no background daemon
that shuts down a device when its lease expires.

Acquisition tokens distinguish successive claims, including successive runs
with the same owner. `renew`, `exec` and `release` validate a token when supplied
through `--token` or `MOBILE_DEVICE_TOKEN`. This prevents an old run's cleanup from
releasing a newer run's lease.

```sh
# Request a particular device without accepting a substitute.
pnpm -s device:lease acquire --platform android --device emulator-5556

# Refuse reuse if this owner already has a live lease on the platform.
pnpm -s device:lease acquire --platform android --exclusive

# Replace <acquisition-token> with the token returned by acquire.
pnpm -s device:lease release --platform android --token <acquisition-token>
```

Token checks are optional in the ordinary checkout-based CLI workflow. For
automation that can overlap successive runs, persist the token in that run's
state and pass it on each operation. Do not recover an old run's token by reading
the current lease record: that record could already describe its successor.

The `exec` wrapper captures the acquisition token regardless of whether the
caller supplied `--token`. It renews before starting its child and fences every
subsequent heartbeat to that captured token. It schedules renewal every
quarter of its configured TTL while that child runs. It uses asynchronous
`spawn`, so the event loop can execute the heartbeat. A heartbeat next to a
blocking `spawnSync` build would not run during the build.

The reference preview launchers use synchronous build commands. They renew at startup
and recheck ownership before installation. For a long build or recording, the
outer `exec` wrapper can maintain the heartbeat:

```sh
pnpm -s device:lease exec --platform android -- pnpm dev:android:local --port <web-port>
```

A separate read-only check runs every second while the command is active. It
does not wait for a heartbeat's mutation mutex. A changed owner/token/device,
expired lease or unverifiable metadata triggers cancellation; renewal errors
also stop the command. A final ownership check fences short commands' results.

Cancellation captures observable descendant process groups with `ps`, signals
them with `SIGTERM` and escalates to `SIGKILL` after 750 ms, even if the group
leader exits first. It includes nested wrappers' separate SDK groups. Only
groups belonging to the spawned command are signalled; no device shutdown or
successor release is performed. See [the command reference](commands.md#execute-against-an-existing-lease)
for host permission, scheduling, daemonisation and forced-termination limits.
Lease expiry cannot stop unrelated, unwrapped device commands.

## Every consumer must target the leased device

The lease manager and the launcher must agree on the registry, platform and
owner. Launcher selection considers an explicit device flag, an inherited
device pin, then the lease recorded for the checkout. It also checks whether a
resolved target belongs to another worktree.

The checks that matter when adapting a launcher are:

- Resolve simulator names to UDIDs before checking ownership.
- Reject inherited pins that conflict with the checkout's live lease.
- Refuse an expired own lease instead of silently falling back to a default device.
- Check an explicitly selected device against other owners' live leases.
- Renew and recheck the selected lease after a long build, immediately before installation.
- Use the same device identity for install, launch, login, interaction and capture.

For Android, the wrapper injects `ANDROID_SERIAL` for `adb`, along with
`ADB_DEVICE_SERIAL` for the preview launcher. Launchers can also pass `adb -s <serial>`
explicitly. For iOS, pass the leased UDID as the relevant `simctl` operand and as
the Xcode destination.

The wrapper is not a parser that validates every arbitrary child command.
An explicit conflicting `adb -s` or literal simulator UDID can override the
intended target. Automation adapters must construct arguments from the lease.
When a UI automation or MCP tool cannot accept a device selector and does not
honour an injected selector, use a tool that can be pinned.

The reference design retains single-developer launcher fallbacks and manual override flags.
For a shared agent pool, require acquisition before device actions and keep
force overrides out of normal agent commands.

## Provisioning and recovery

Leases allocate capacity; they do not create parallelism from one device.
Provision an Android pool with three AVDs initially, for example `mobile-agent-1`
through `mobile-agent-3`:

```sh
pnpm android:avds
pnpm android:avds --list
pnpm android:avds --size 4
```

The provisioner preserves existing AVDs, selects a pinned system image and
enables the hardware keyboard. The acquisition manager can boot a stopped pool
AVD when attached capacity is occupied. It boots only AVDs with the configured
pool prefix; it does not automatically boot arbitrary personal AVDs.

iOS uses existing available simulators. The reference discovery recognises
names containing `iPhone`; its `--ios-family` option also supports `ipad` and
`all`. Create several simulators using installed runtime and device identifiers,
and adapt the discovery rule if the other project needs different families.
Create iOS simulators separately or add a dedicated iOS pool provisioner.

Recovery requires a live lease and acts only on that leased virtual device.
Android recovery checks runtime health and system error dialogs, while preserving
application crashes and ANRs as evidence. iOS recovery checks and settles
the leased simulator's state. `--reboot` requests a bounded restart.

For Android recovery, set `MOBILE_APP_PACKAGES` or `--app-packages` to a
comma-separated list of the application's package IDs, including debug variants.
A blocking error dialog is preserved if these IDs have not been configured. Never use a global emulator shutdown, simulator reset or
device-pool cleanup to fix one agent's session.

## Keep device leases and build capacity separate

A device lease protects the test session. A second mechanism limits heavy
Gradle and Xcode builds, which can starve running emulators even when each agent
owns a different device.

The reference design serialises those build phases with a listener on loopback TCP port
`46781`. The operating system releases the listener when its owning process
exits. A metadata file records the holder for diagnostics; the TCP listener is
the actual lock. The default build-slot wait is 15 minutes.

`MOBILE_BUILD_LOCK_PORT` changes the port. All participating projects and
worktrees must use the same port if they need one shared build slot. The slot is
released after the heavy build phase, while the device lease stays held through
installation and testing.

## Adapting this to another project

### Choose the scope of the shared pool

If multiple projects use the **same devices**, they must use the same lease
root. Configure every participating launcher and CLI with one shared path:

```sh
export MOBILE_DEVICE_LEASE_DIR="$HOME/.local/state/shared-mobile/device-leases"
```

Configure that consistently in each task's environment; setting it in one
temporary agent shell does not configure future tool calls. Keep the registry
on the local machine. This implementation is not a distributed lock service.

Separate roots are appropriate only for pools that cannot overlap. Renaming
`shared-mobile/device-leases` to `<project>/device-leases` independently in each project
would let both registries claim the same serial or UDID.

### Library and application responsibilities

The following source map explains the installed library. Consumers configure
the package and integrate its commands into their application launchers.

| Source | Responsibility |
| --- | --- |
| `scripts/device-lease.mjs` | CLI, concurrency control, claims, renewal, execution and recovery |
| `scripts/lib/device-lease.mjs` | Selection, expiry, exports, discovery and pool defaults |
| `scripts/lib/device-lease-store.mjs` | Shared on-disk reads used by the CLI and launchers |
| `scripts/lib/mobile-build-lock.mjs` | Optional host-wide heavy-build slot |
| `scripts/provision-android-avds.mjs` | Android pool creation and keyboard configuration |
| `scripts/device-session.mjs` | Acquire, execute with a heartbeat and release with a token |
| `scripts/mobile-build.mjs` | Run a project build in the shared host build slot |
| `scripts/lib/owner.mjs` | Resolve the caller's checkout identity |

The CLI and Android provisioner share the library's argument reader in
`scripts/lib/args.mjs`. It has no application or backend dependencies.

The core uses Node built-ins. Device operations additionally need the Android
SDK tools or Xcode's `xcrun simctl`. The Unix-socket mutex and host recovery
commands need platform review before Windows support can be added.

For project/team integration, optional aliases in the application's existing
`package.json` call the installed bins:

```json
{
  "scripts": {
    "device:lease": "device-lease",
    "device:session": "device-session",
    "android:avds": "android-device-pool",
    "mobile:build": "mobile-build-slot"
  }
}
```

Configure application package IDs, SDK paths, the AVD prefix/image and simulator
family through the supported options and environment variables. The application
supplies build paths and launcher commands. Keep registry and captured
owner/device/token consistent across those integrations.

### Verify application integration

The library's process-level tests cover its claim, renewal, release and build-slot
contracts. Application tests should call the installed CLI and exercise their
own launcher boundaries. Use a temporary lease directory and fake device
capacity for concurrency tests; do not use the live pool for race tests.

The relevant integration checks are:

1. Concurrent owners receive distinct devices, and overflow waits or fails.
2. A repeat acquisition reuses the owner's device across separate shells.
3. Release cannot remove another owner's lease or a successor token's lease.
4. Expired claims are reclaimed without deleting newly issued claims.
5. Renewal preserves the holder's expiry contract under concurrent operations.
6. `exec` targets the leased device and rejects `booted`.
7. Launchers reject stale pins and another owner's device before installation.
8. Physical devices are excluded from automatic allocation unless deliberately opted in.
9. Recovery touches only the owned virtual device and preserves application failures.
10. A crashed build-slot holder releases its kernel-owned slot.

For library contributions, clone this tool repository and run its own tests:

```sh
npm test
```

Consumers do not need a tool-repository checkout. Test the application's
installation, launch, testing and capture flow as described in
[Integration](integration.md#prove-application-integration).

## An agent instruction block to reuse

For project/team adoption, add this to the application's `AGENTS.md` after the
installed commands and launchers have been integrated. For personal adoption,
use the [personal rule](agent-instructions.md#personal-rule) instead:

```md
### Shared mobile devices

Each independent agent uses a separate Git worktree.

Before building for, installing on, or interacting with an Android emulator or
iOS simulator, acquire the worktree's lease:

- Android: pnpm -s device:lease acquire --platform android
- iOS: pnpm -s device:lease acquire --platform ios

Use the project's lease-aware preview launcher. For raw device commands, use
pnpm -s device:lease exec --platform <android|ios> -- <command>.
Use MOBILE_DEVICE as the simulator operand; do not use booted.

Keep the lease through installation, interaction and evidence capture. Renew
before a long session or use the exec wrapper to maintain a heartbeat. Release
only after all commands using the device have finished.

If capacity is full, wait or provision more devices. Do not take another
worktree's device, use force overrides, or shut down/reset the whole pool.
Recover only the leased virtual device. Keep application crashes as evidence.

All projects sharing devices must use the same lease registry. Do not rely on
shell exports persisting between agent tool calls.
```
