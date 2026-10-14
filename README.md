# Agent Mobile Device Lease

Give each agent's worktree an exclusive Android emulator or iOS simulator.
Keep that device selected across builds, installations, UI commands and captures.
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
npm install --global github:nick-cobra/agent-mobile-device-lease#v0.1.3
device-lease doctor --platform android
```

For a project/team workflow, install in the application and commit its lockfile:

```sh
pnpm add -D github:nick-cobra/agent-mobile-device-lease#v0.1.3
# Or: npm install --save-dev github:nick-cobra/agent-mobile-device-lease#v0.1.3
pnpm exec device-lease doctor --platform android
```

For iOS, use `--platform ios`. A doctor's nonzero result lists missing
prerequisites or absent capacity. It never boots, provisions or claims a device.

Requirements: Node 22 or later; Android SDK tools for Android; Xcode and an
installed simulator runtime for iOS. This release targets macOS. Core lease and
build-lock tests also run on Linux; host recovery needs platform validation.
Windows and remote-device coordination are not supported yet.

Run device commands from the application's checkout. Each independent agent
should use a separate Git worktree. The examples below use project-local
`pnpm exec`; personal installations use the same commands without that prefix.

## Use a device throughout an agent task

```sh
pnpm exec device-lease acquire --platform android

# Build with your own project's command.
# Optional: wrap that command in the shared build slot.
pnpm exec mobile-build-slot -- ./gradlew assembleDebug

# Replace this APK path with the output of your build.
pnpm exec device-lease exec --platform android -- adb install -r ./build/app.apk
pnpm exec device-lease exec --platform android -- adb shell input tap 540 1200
pnpm exec device-lease exec --platform android -- adb exec-out screencap -p > shot.png

pnpm exec device-lease release --platform android
```

The wrapper sets `ANDROID_SERIAL`, so these commands target the leased device.
The lease remains recorded between separate agent shell calls.

For one command, use automatic acquisition, renewal and token-protected cleanup:

```sh
pnpm exec device-session --platform android -- adb shell getprop sys.boot_completed
```

`device-session` refuses to adopt an existing lease owned by the same worktree.
Use `device-lease exec` when you already acquired a lease for the full task.

For iOS, acquire a simulator and address it explicitly:

```sh
pnpm exec device-lease acquire --platform ios
pnpm exec device-lease exec --platform ios -- xcrun simctl boot MOBILE_DEVICE
pnpm exec device-lease exec --platform ios -- xcrun simctl bootstatus MOBILE_DEVICE -b
pnpm exec device-lease exec --platform ios -- xcrun simctl install MOBILE_DEVICE ./build/Example.app
pnpm exec device-lease exec --platform ios -- xcrun simctl io MOBILE_DEVICE screenshot shot.png
pnpm exec device-lease release --platform ios
```

Boot only when the selected simulator is shut down; `simctl boot` reports an
error for an already booted simulator. Acquisition allocates the simulator;
your preview launcher or explicit boot command starts it.

`MOBILE_DEVICE` is replaced with the leased UDID. A literal `booted` operand is
refused. Arguments are passed directly to the command without shell evaluation.

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
- [Validation](docs/validation.md) records checks and their limits.

To contribute, clone the tool repository and run `npm test`. The tests use
temporary registries, fake capacity and stub SDK commands, so they do not need
booted devices.

MIT licensed. See [LICENSE](LICENSE).
