# Command reference

After installation, invoke commands with `pnpm exec`, `npm exec --`, or their
direct bin names on PATH. During development in this repository, use the package
aliases or `node scripts/<entry>.mjs`.

## Device allocation

```sh
device-lease acquire --platform android
device-lease acquire --platform ios
device-lease list
device-lease list --platform ios --json
```

| Option | Effect |
| --- | --- |
| `--platform android\|ios` | Select the device platform |
| `--device <serial-or-udid>` | Request an exact available identity without accepting another device |
| `--owner <identity>` | Override the caller's checkout identity |
| `--label <text>` | Attach a human-readable task label to metadata |
| `--ttl-minutes <number>` | Lease lifetime; default 240, minimum 1 |
| `--wait-seconds <number>` | Acquisition capacity wait; default 1800; 0 disables queuing |
| `--no-boot` | Avoid attempting to boot spare Android pool AVDs |
| `--exclusive` | Refuse acquisition if this owner already has a live lease on the platform |
| `--ios-family iphone\|ipad\|all` | iOS discovery family; default iphone |
| `--avd-prefix <name>` | Android pool prefix; overrides `MOBILE_AVD_POOL_PREFIX` |
| `--json` | Return acquisition identity and token as JSON instead of shell exports |
| `--token <uuid>` | Fence an operation to a particular acquisition generation |
| `--allow-physical` | Explicitly opt physical Android devices into allocation |

Normal repeated acquisition renews and reuses the same owner's available device.
One owner holds at most one device on each platform. A requested device
conflicting with that owner's existing lease fails rather than silently moving
the session.

`acquire` writes exports or JSON to stdout and diagnostics to stderr. A failed
acquisition returns nonzero and emits `false`, so shell evaluation cannot silently
succeed with an empty pin. `list` writes its human-readable inventory to stderr.
`renew` prints the renewed device ID.

Release without `--platform` considers both platforms and normally removes only
this owner's leases. Supplying or inheriting a token restricts release to that
generation. A privileged `--force` release option exists for manual recovery;
agents should not use it to take another task's device.

Capacity polling and Android boot attempts have separate budgets. An on-demand
boot attempt can take up to 180 seconds, so `--wait-seconds` is not a strict
overall wall-clock limit. Use `--no-boot` with zero wait for an immediate capacity
decision. Each registry mutation has a 60-second mutex wait.

## Lease status and idle renewal

`device-lease list` shows each recorded lease's owner, remaining TTL, expiry,
last renewal and observed device state. Use `--platform android|ios` to narrow
the inventory and `--json` for structured stdout. Text inventory uses stderr.
New leases show `not-yet` before their first renewal; pre-0.1.4 records without
a renewal timestamp show `unknown-legacy`. Expired records stay visible with
zero remaining TTL; invalid expiry information is reported as unknown.

Status reads metadata and runs bounded SDK inventory queries. It does not claim,
renew, release, boot or reclaim devices. JSON distinguishes `present`, `absent`
from a successful inventory, and `unavailable` when a query fails or is invalid.
Failure details remain in `observations`. A shut-down virtual device can still
have a valid lease after a restart. Device state does not prove its owner has
finished; stored ownership and expiry remain authoritative.

Acquiring a lease does **not** start a background renewer. `exec` renews only
before and during its child. For a manual session, keep the lease during user
testing and feedback across replies, and renew before its stored deadline:

```sh
device-lease renew --platform android --token '<captured-token>'
```

Use `--platform ios` for iOS. Pass the same `--ttl-minutes` on renew/exec when
using a custom lifetime; otherwise those commands use the default 240 minutes.
Claim automatic idle renewal only after starting and verifying a real renewer.
Otherwise report the actual expiry and arrange renewal before it. If ownership
expires or is lost, stop device commands and resolve ownership before continuing.

**Only when the user finishes testing, requests release or switches devices**,
and all device commands finish, release the captured acquisition generation:

```sh
device-lease release --platform android --token '<captured-token>'
```

Installation, a screenshot and the end of an agent turn do not meet that release
condition. A finite unattended session can release when its complete device work
finishes. See [standing agent rules](agent-instructions.md).

## Execute against an existing lease

```sh
device-lease exec --platform android -- adb shell input tap 540 1200
device-lease exec --platform ios -- xcrun simctl io MOBILE_DEVICE screenshot shot.png
```

The wrapper renews before starting the command and heartbeats at a quarter of
its configured TTL. Use the same `--ttl-minutes` when intentionally using a
custom lifetime. The heartbeat ends when the child finishes; the lease remains
recorded until release or expiry. It propagates the child command's exit status.

`MOBILE_DEVICE` can appear as a whole argument or a placeholder in a value such
as `target=MOBILE_DEVICE`. Variable names such as `MOBILE_DEVICE_LEASE_DIR` are
left intact. Direct wrapped `adb` rejects a conflicting `-s`, alternate global
selectors (`-d`, `-e`, `-t`) and server/global operations. A matching `-s` is
accepted. Command-specific flags after the adb verb, such as `install -t`, are
preserved. Direct `simctl` / `xcrun simctl` requires the captured UDID for device
commands and refuses `all`, `booted`, conflicting devices and unrecognised global
operations. Read-only `list` and `help` are allowed. Launch/spawn options are
validated before the device operand; unsupported options fail closed. Arbitrary
scripts or shells must honour the pin internally; the wrapper cannot inspect
their SDK calls. [ADB's selector rules](https://android.googlesource.com/platform/packages/modules/adb/+/HEAD/docs/user/adb.1.md).

The running command is fenced to the owner, device and acquisition token captured
at startup, even when `--token` was omitted. A separate read-only monitor checks
that identity and stored expiry every **one second**, independently of renewal
and its mutex wait. Missing/unreadable metadata, expiry, a changed owner or a
changed token stops execution. A final check rejects success from a fast command
that finishes before the first monitor tick.

On loss, the wrapper captures its command's descendant process groups with the
host's `ps`, sends `SIGTERM`, then sends `SIGKILL` after **750 ms**. Escalation
continues if the root exits first, so a descendant ignoring `SIGTERM` is stopped.
The wrapper returns nonzero, preserves successor metadata and does not release
the task lease. Nested wrappers' separate groups are included when their ancestry
can still be observed. `SIGINT`/`SIGTERM` received by the wrapper follows the same
cleanup and returns 130/143 respectively.

These intervals are scheduled on the local event loop, not a hard real-time
guarantee. SDK work already accepted by a device cannot be undone. Host process
inspection must be permitted to find detached descendant groups; restrictions
are reported and the known command group is still stopped. Processes that have
already daemonised/reparented beyond observable ancestry and a wrapper forcibly
killed with `SIGKILL` cannot be reliably cleaned up. Keep device work supervised
and finish it before the launcher returns. Unwrapped SDK access remains outside
the protocol. Do not release or force-transfer a device during active work.

## Run an automatic device session

Use this only for finite unattended work whose whole device lifecycle finishes
inside the child. For installation followed by human testing, use persistent
`acquire` + `exec` and the [manual-session rule](../README.md#manual-testing-and-session-lifetime).

```sh
device-session --platform android -- adb shell getprop sys.boot_completed
```

The session wrapper accepts `--device`, `--owner`, `--label`, `--ttl-minutes`,
`--wait-seconds`, `--ios-family` and `--no-boot`. It acquires exclusively, keeps
the child under the execution heartbeat and releases using the captured token.
An existing same-owner lease is left untouched. Child failure still triggers
cleanup. Abrupt process termination can leave a lease until expiry.
Automatic release follows child exit; it does not wait for later user feedback.

## Serialise a heavy build

```sh
mobile-build-slot --label Android -- ./gradlew assembleDebug
mobile-build-slot --label iOS -- xcodebuild -project Example.xcodeproj -scheme Example build
```

The wrapper holds a loopback TCP listener during the child command. Default port
is 46781 and default wait is 900 seconds. Use the same configured port across
all participating projects. The diagnostic metadata file is not the lock.
This command does not allocate a device; acquire a device separately when the
build and subsequent installation form a device session.

## Provision Android capacity

```sh
android-device-pool --size 3
android-device-pool --list
android-device-pool --package 'system-images;android-36;google_apis_playstore;x86_64'
```

`--size` defaults to 3 and `--device-profile` defaults to `pixel_6`.
The pool prefix is `mobile-agent`; configure `MOBILE_AVD_POOL_PREFIX` / `--avd-prefix` if managing a different
pool. Use the same prefix for provisioning and allocation. The lease manager boots only stopped AVDs with
that prefix. The provisioner creates missing AVDs and enables their hardware
keyboard. Existing AVDs are not recreated or reconfigured.

SDK discovery uses `ANDROID_SDK_ROOT`, then `ANDROID_HOME`, then the macOS SDK
location. Set an SDK variable on other hosts. Put `adb` on PATH. SDK image and
profile availability are local prerequisites, not downloaded dependencies.

## Diagnose prerequisites and capacity

```sh
device-lease doctor --platform android
device-lease doctor --platform ios --ios-family all
device-lease doctor --platform android --json
```

The doctor reports the registry, owner, SDK executable discovery and visible
capacity. Android checks `adb` on PATH and `emulator` / `avdmanager` in the
configured SDK root or PATH. iOS queries available simulators with
`xcrun simctl`. It reads lease metadata without renewing, acquiring or releasing,
and never boots devices, creates AVDs, changes SDKs or creates the registry.
An Android inventory query can start the usual ADB server. Executable discovery
does not prove Java/profile/system-image readiness; stopped devices are not
boot-tested. Capacity is an observational snapshot, not a reservation, and
Android AVD/ready-emulator counts can overlap.

The Android check covers allocation and pool provisioning; an existing pool can
still be leased without `avdmanager`. Missing prerequisites or no visible
capacity return nonzero. Held capacity is
reported separately; waiting for a lease is normal. The provisioner names a
missing `avdmanager` executable rather than suggesting a device-profile error.

Failed SDK probes include bounded stderr/stdout, exit status and a diagnostic
kind in text/JSON output. `missing-executable` identifies installation/PATH
problems; `permission-restriction` requires explicit permission-denied evidence.
An ambiguous service error stays `sdk-failure`, not a guessed sandbox diagnosis.
Timeout and output-limit failures are identified separately. Check the SDK's
actual error and the environment's service access before changing installation.

## Recover the owned virtual device

```sh
device-lease recover --platform android --app-packages com.example.app,com.example.app.debug
device-lease recover --platform ios
device-lease recover --platform android --reboot --app-packages com.example.app,com.example.app.debug
```

Recovery requires a live lease and refuses physical hardware. It holds the
platform mutation mutex during destructive recovery. Android checks boot health,
package service and the focused error window. Configured application crashes
and ANRs are preserved. If a blocking dialog cannot be identified, or application
packages have not been configured, recovery stops before dismissing it.

A known unrelated package's blocking dialog may be cleared with `am force-stop`.
Runtime recovery can restart the owned emulator once. Host process recovery
requires `lsof`, `ps` and a provable SDK emulator executable; ambiguity stops the
operation. iOS settles the owned simulator and can perform one requested reboot.
Recovery uses no global shutdown or reset command.

Application families can be protected with `MOBILE_APP_PACKAGE_PREFIXES` or
`--app-package-prefixes`. For example, `com.example.club` protects that exact
package and its dot-separated variants; it does not match `com.example.clubevil`.

For migration from a different environment interface, set
`MOBILE_DEVICE_COMPAT_PREFIX=LEGACY_DEVICE`. Acquisition and wrapped child
commands then also receive `LEGACY_DEVICE_ID`, `LEGACY_DEVICE_PLATFORM` and
the available name/token exports. `LEGACY_DEVICE` becomes an additional device
operand placeholder. Neutral exports remain available. Compatibility prefixes
must start with an uppercase letter and contain only uppercase letters, digits
or underscores. This setting does not translate incoming legacy variables;
an application adapter must map its inputs to the neutral variables explicitly.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `MOBILE_DEVICE_LEASE_DIR` | Override the shared registry root |
| `XDG_STATE_HOME` | Base for default registry and diagnostic metadata |
| `MOBILE_DEVICE_OWNER` | Override the default caller checkout identity |
| `MOBILE_DEVICE_PLATFORM` | Default platform for commands other than unrestricted release |
| `MOBILE_DEVICE_TOKEN` | Optional acquisition-generation fence |
| `MOBILE_DEVICE_ADAPTER_MODULE` | Installed adapter helper module URL supplied to wrapped children |
| `MOBILE_DEVICE_TTL_MINUTES` | Configured TTL supplied to wrapped children for nested adapter operations |
| `MOBILE_APP_PACKAGES` | Comma-separated Android application package IDs to preserve during recovery |
| `MOBILE_APP_PACKAGE_PREFIXES` | Comma-separated protected Android application package families |
| `MOBILE_AVD_POOL_PREFIX` | Android pool prefix shared by provisioning and allocation |
| `MOBILE_DEVICE_COMPAT_PREFIX` | Optional legacy device export and operand prefix |
| `MOBILE_ANDROID_SYSTEM_IMAGE` | Default image for the Android provisioner |
| `MOBILE_BUILD_LOCK_PORT` | Shared loopback build-slot port |
| `MOBILE_BUILD_LOCK` | Build-holder diagnostic metadata path |
| `MOBILE_BUILD_LOCK_DISABLED` | Set to 1 to bypass build serialisation for an intentional manual use |
| `ANDROID_HOME` or `ANDROID_SDK_ROOT` | Android SDK location |

Acquisition exports `MOBILE_DEVICE_ID`, `MOBILE_DEVICE_NAME`,
`MOBILE_DEVICE_PLATFORM` and `MOBILE_DEVICE_TOKEN`; Android also exports
`ANDROID_SERIAL` / `ADB_DEVICE_SERIAL`, and iOS exports `IOS_SIMULATOR`. Wrapped children also receive the captured
`MOBILE_DEVICE_OWNER`, so nested adapters retain explicit owner overrides.
`MOBILE_DEVICE_FAKE_CAPACITY` and `MOBILE_DEVICE_TEST_*` are test seams; do not
configure them in real agent sessions.

Use a short local registry path: Unix socket path lengths are limited by the
host operating system. Do not store the registry on a remote/shared filesystem.
