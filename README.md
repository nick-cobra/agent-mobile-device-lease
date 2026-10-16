# Agent Mobile Device Lease

Give each agent's worktree an exclusive Android emulator or iOS simulator.
Keep that device selected across builds, installations, UI commands, captures
and the user's manual testing.
When capacity is occupied, wait for a free device rather than interrupting another
agent's session.

The tool runs locally, uses Node built-ins and has no runtime package dependencies.
It does not require an account, hosted service or paid tier.

## Choose how to adopt it

> Do you want this for your own agents on this machine, or as a shared project workflow?

| | Personal | Project/team |
| --- | --- | --- |
| Install | Once on your Mac, globally | Pinned development dependency in the application |
| Agent participation | Standing personal instructions | Committed project instructions |
| Launchers | Optional adapter outside application repositories | Shared lease-aware launchers |
| Application changes | None required | Manifest, lockfile, instructions and integration |

Both paths coordinate through the **same registry** when sharing devices. The
installation location does not own the lease: the caller's worktree does.
Installing the CLI alone does not make agents use it. Complete the matching
instructions and launcher steps in [Adoption](docs/adoption.md).

## Protection boundary

Leases coordinate participating agents on one machine. They do not block
operating-system access to devices. Unwrapped SDK commands and launchers that
ignore the pin can bypass the protocol. Direct commands reject conflicting
selectors in **directly wrapped** `adb`, `simctl` and `xcrun simctl` commands;
it cannot inspect commands hidden inside arbitrary scripts or shells.

While `exec` runs, it checks the captured lease every second. Lost ownership or
expiry stops its command and captured descendant process groups (`SIGTERM`,
then `SIGKILL` after 750 ms) and returns failure. This is cooperative host
process supervision; see [execution limits](docs/commands.md#execute-against-an-existing-lease).

## Install

No checkout of this tool repository is required.

For personal use, install once and then add the [personal agent rule](docs/agent-instructions.md):

```sh
npm install --global github:nick-cobra/agent-mobile-device-lease#v0.1.6
device-lease doctor --platform android
device-lease adoption-check --scope personal
```

For a project/team workflow, install in the application and commit its lockfile:

```sh
pnpm add -D github:nick-cobra/agent-mobile-device-lease#v0.1.6
# Or: npm install --save-dev github:nick-cobra/agent-mobile-device-lease#v0.1.6
pnpm exec device-lease doctor --platform android
pnpm exec device-lease adoption-check --scope project
```

For iOS, use `--platform ios`. A doctor's nonzero result lists missing
prerequisites or absent capacity. It never boots, provisions or claims a device.

The package includes a copyable [personal skill template](docs/personal-skill.md)
alongside the standing rules. The read-only [adoption check](docs/commands.md#inspect-adoption)
reports the running version, registry, instruction locations and declared launchers.
It does not prove an agent loaded a rule or that a launcher respects the device pin.

Version 0.1.6 provides [opt-in copied-guidance revision checks](docs/commands.md#inspect-copied-guidance-revisions).
Existing string paths remain presence-only; only explicitly opted-in files have
bounded marker reads. Matching declarations do not prove rule content or loading.

When upgrading, also merge the updated [standing rule](docs/agent-instructions.md)
into your personal or project instructions. Updating the CLI does not refresh
saved agent rules; see [existing-chat refresh](docs/adoption.md#personal-your-agents-on-your-mac).

Requirements: Node 22 or later; Android SDK tools for Android; Xcode and an
installed simulator runtime for iOS. This release targets macOS. Core lease and
build-lock tests also run on Linux; host recovery needs platform validation.
Windows and remote-device coordination are not supported yet.

Run device commands from the application's checkout. Each independent agent
should use a separate Git worktree. The examples below use project-local
`pnpm exec`; personal installations use the same commands without that prefix.

## Manual testing and session lifetime

**Keep the lease while the user tests the running app, including while waiting
for feedback across agent replies.** Installation, screenshots and the end of an
agent turn do not finish a manual session. Use persistent `acquire` + `exec`.
Release only when the user finishes testing, requests release or switches away
from that device, after all device commands finish.

Leases still expire unless renewed. Acquisition does **not** start an idle
background renewer. `exec` renews before and during its child command, then its
heartbeat stops. Renew before the stored expiry during idle periods; never claim
automatic renewal without a running, verified renewer. If that cannot be ensured,
report the actual deadline and arrange renewal or finish testing before it.

Version 0.1.6 adds an explicit [bounded keep-alive command](docs/commands.md#keep-a-manual-session-renewed)
for idle manual sessions. It starts only when
requested, requires the captured token and leaves the lease held when renewal
stops. Verify its live process and `started` record before claiming automatic
renewal, and track its finite deadline across replies.

## Android manual session

Capture the owner, device ID and token from this acquisition. Replace the quoted
token placeholder below with that captured token on every call; do not reread
the registry to adopt a successor's token or assume exports survive tool calls.

```sh
pnpm exec device-lease acquire --platform android --json

# Build with your application's command; retain renewal during a long build.
pnpm exec device-lease exec --platform android --token '<captured-android-token>' -- mobile-build-slot -- ./gradlew assembleDebug

# Replace this APK path with the output of your build.
pnpm exec device-lease exec --platform android --token '<captured-android-token>' -- adb install -r ./build/app.apk
pnpm exec device-lease exec --platform android --token '<captured-android-token>' -- adb shell input tap 540 1200
pnpm exec device-lease exec --platform android --token '<captured-android-token>' -- adb exec-out screencap -p > shot.png
```

The wrapper sets `ANDROID_SERIAL`, so these commands target the leased device.
Leave the lease held for the user's testing. Inspect freshness and renew before
expiry, including while waiting for feedback:

```sh
pnpm exec device-lease list --platform android
pnpm exec device-lease renew --platform android --token '<captured-android-token>'
```

**Only after the user finishes, requests release or switches devices**, and all
device commands finish:

```sh
pnpm exec device-lease release --platform android --token '<captured-android-token>'
```

## Finite unattended session

When the whole device lifecycle finishes inside one child command and there is
no later manual testing, use automatic acquisition, renewal and captured-token
cleanup:

```sh
pnpm exec device-session --platform android -- adb shell getprop sys.boot_completed
```

`device-session` refuses to adopt an existing lease owned by the same worktree.
Use `device-lease exec` when you already acquired a lease for the full task.
Do not wrap a returning installer with `device-session` when the user will keep
testing the installed app: the session releases as soon as its child exits,
including on failure. See the [launcher examples](docs/integration.md#wrap-an-existing-preview-flow).

## iOS manual session

Acquire a simulator, capture its identity/token, and address it explicitly:

```sh
pnpm exec device-lease acquire --platform ios --json
# Boot only if this selected simulator is shut down.
pnpm exec device-lease exec --platform ios --token '<captured-ios-token>' -- xcrun simctl boot MOBILE_DEVICE
pnpm exec device-lease exec --platform ios --token '<captured-ios-token>' -- xcrun simctl bootstatus MOBILE_DEVICE -b
pnpm exec device-lease exec --platform ios --token '<captured-ios-token>' -- xcrun simctl install MOBILE_DEVICE ./build/Example.app
pnpm exec device-lease exec --platform ios --token '<captured-ios-token>' -- xcrun simctl io MOBILE_DEVICE screenshot shot.png
```

Boot only when the selected simulator is shut down; `simctl boot` reports an
error for an already booted simulator. Acquisition allocates the simulator;
your preview launcher or explicit boot command starts it. `MOBILE_DEVICE` is
replaced with the leased UDID. A literal `booted` operand is refused. Arguments
are passed directly to the command without shell evaluation.

Keep this lease during the user's testing. Check expiry and renew while idle:

```sh
pnpm exec device-lease list --platform ios --json
pnpm exec device-lease renew --platform ios --token '<captured-ios-token>'
```

Only after the manual-session release condition above is met:

```sh
pnpm exec device-lease release --platform ios --token '<captured-ios-token>'
```

`list` shows remaining TTL, last renewal and observed device state together.
A shut-down simulator after a restart may still have a valid lease; shutdown
does not prove its owner has finished. Query failure is shown as unavailable,
separately from a device absent from a successful inventory. Status never renews
or reclaims a lease. Use the same `--ttl-minutes` on renew/exec for a custom TTL.
See [status and renewal](docs/commands.md#lease-status-and-idle-renewal).

## Provide enough devices

Android acquisition can boot spare pool AVDs on demand. Create the pool once:

```sh
pnpm exec android-device-pool --size 3
```

The default image is `system-images;android-36;google_apis_playstore;arm64-v8a`.
This is an Apple Silicon starting configuration. Choose an installed image
compatible with your machine and verify that it boots; pass another image with
`--package` or `MOBILE_ANDROID_SYSTEM_IMAGE`. The provisioner does not download
SDKs and does not replace existing AVDs.

For iOS, create several simulators in Xcode first. Default discovery recognises
available devices whose names contain `iPhone`. `--ios-family ipad` and
`--ios-family all` select other supported families.

## Share one registry

All worktrees and projects using the same devices must use the same registry.
The default is `$XDG_STATE_HOME/shared-mobile/device-leases`, or
`~/.local/state/shared-mobile/device-leases` if XDG state is unset.

Override it consistently in every task environment if needed:

```sh
export MOBILE_DEVICE_LEASE_DIR="$HOME/.local/state/shared-mobile/device-leases"
```

Different registries cannot protect overlapping device pools. When migrating
from an existing lease manager, configure both managers to use the same root;
verify metadata and locking compatibility before running them together.

See the protection boundary above. Sharing a registry is required for both
personal and team adoption; a shared instruction alone cannot connect separate
registries.

## Learn more

- [Adoption](docs/adoption.md) starts with the personal/project choice.
- [Command reference](docs/commands.md) covers options, variables and recovery.
- [Project integration](docs/integration.md) covers launchers and migration.
- [Design guide](docs/guide.md) explains persistence, concurrency and expiry.
- [Agent instructions](docs/agent-instructions.md) includes personal and project standing rules.
- [Personal skill](docs/personal-skill.md) explains the packaged reusable template.
- [Validation](docs/validation.md) records checks and their limits.
- [Installed smoke test](docs/installed-smoke.md) checks an explicitly selected dedicated virtual device and defines release evidence.

To contribute, clone the tool repository and run `npm test`. The tests use
temporary registries, fake capacity and stub SDK commands, so they do not need
booted devices.

MIT licensed. See [LICENSE](LICENSE).
