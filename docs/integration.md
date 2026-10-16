# Integrating into an application

Start with [Adoption](adoption.md): choose personal installation for your own
agents or committed integration for a project/team. Both paths use the same
registry for overlapping devices. Installation alone does not enlist agents or
fix an existing launcher's device selection.

## Project installation

For a project/team adoption, add the pinned GitHub release as a development dependency and commit the
application's dependency lockfile. The application keeps its build and test
commands; the package provides allocation, device execution and cleanup.

Optional aliases in the application's existing `package.json` are:

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

Merge these entries into the existing scripts object. Do not replace the
application's manifest with this package's manifest.

Use the installed bin names. Keep the lease, renewal, recovery and build-slot
engines in this dependency so library fixes arrive through a version update.
The application owns its launcher adapters and configuration.

For personal adoption, install the global CLI and keep the application manifest
unchanged. Use direct bin names in the examples below instead of `pnpm exec`.

## Give every consumer the same identity

Commands resolve the caller's Git worktree root from their working directory.
Outside Git they use the canonical current directory. Explicit `--owner` takes
precedence over `MOBILE_DEVICE_OWNER`.

Run an agent's commands in its own checkout. Two agents sharing one checkout
share the default owner and can adopt the same lease. If a custom owner is
needed, configure it in every consumer and preserve its acquisition token.

## Wrap an existing preview flow

For manual testing, acquire persistently and capture the returned identity/token.
For a launcher that honours `ANDROID_SERIAL` or `IOS_SIMULATOR`, use:

```sh
pnpm exec device-lease acquire --platform android --json
pnpm exec device-lease exec --platform android --token '<captured-token>' -- node scripts/mobile-preview.mjs
```

That runs the application's preview script under the lease heartbeat and keeps
the lease after it returns. Retain it through the user's testing and feedback
across replies. Renew before expiry while idle; `acquire` starts no background
renewer and `exec` renews only while its child runs. Release only when the user
finishes, requests release or switches devices, after all device commands finish,
using the captured token. See [manual-session examples](../README.md#manual-testing-and-session-lifetime).

For idle renewal, the explicit
[keep-alive command](commands.md#keep-a-manual-session-renewed) can run separately
from the launcher with the same captured owner/device/token. Verify its started
record and process liveness, track its finite duration, and stop it before final
release. It does not run the launcher or release when its duration ends.

For finite unattended work whose entire device lifecycle ends inside one child,
use `pnpm exec device-session --platform android -- node scripts/mobile-check.mjs`.
That automatically releases on child exit, including failure. A returning
installer followed by human testing must use the persistent workflow above.
Adapt these illustrative script names to the application's own commands. Finish
background device commands before returning; idle user testing is a persistent
lease, not detached background SDK work.

For tools requiring positional targets, use `MOBILE_DEVICE` where the identity
belongs, or construct arguments from `MOBILE_DEVICE_ID` inside the child.
Do not let a preview launcher ignore the pin and choose the first connected
device or the first booted simulator.

You can wrap only the heavy build phase with `mobile-build-slot`. That prevents
competing Gradle/Xcode builds from starving the host while agents use different
devices. It should not keep the build slot occupied during manual UI inspection.

## Integrate a custom launcher directly

The shared helpers are importable from the installed package source when a
project needs tighter control. Before adding a direct helper integration,
prefer the CLI wrapper because it already implements mutation locking, renewal
and token checks.

A direct launcher must:

1. Resolve the same owner and registry as the CLI.
2. Read a live lease and capture its device ID and acquisition token.
3. Reject stale environment pins and any target belonging to another owner.
4. Resolve simulator names to UDIDs before checking ownership.
5. Renew before the operation and maintain renewal during long work.
6. Recheck the captured generation before installation or recovery.
7. Pass the exact identity to install, launch, login, interaction and capture.
8. For manual testing, retain ownership while waiting for user feedback and renew before expiry. Release only its captured generation when the user finishes, requests release or switches devices, after all device commands finish. A finite unattended workflow may release after its entire device lifecycle ends.

The CLI's `acquire --json` output supplies `{platform, deviceId, token, owner}`.
Use the token returned by that acquisition; rereading current metadata during
cleanup may adopt a successor's token. Avoid overlapping same-owner tasks.

## Reuse the adapter helper

In a project with the installed dependency:

```js
import { captureDevice } from "agent-mobile-device-lease/scripts/lib/adapter.mjs";

const device = captureDevice(); // Capture once, before changing cwd or environment.
await device.adb(["install", "-r", "./build/app.apk"]);
```

Run that script under `device-lease exec` or `device-session` as appropriate for
its lifetime. `captureDevice` requires the wrapped child's platform, owner,
device ID and token. It snapshots the registry/environment and preserves the
configured TTL. Each asynchronous operation invokes the same installed CLI with
the captured owner/device/token, so stale generations or mismatched device IDs
fail before SDK work and active commands receive
the existing ownership-loss and signal cancellation. The helper never acquires
or releases a lease. It does not renew while the adapter is idle.

For a personal script outside any application's dependency tree, load the helper
from the executing installation instead of relying on Node's global npm imports:

```js
const { captureDevice } = await import(process.env.MOBILE_DEVICE_ADAPTER_MODULE);
const device = captureDevice();
```

`exec` supplies that module URL and `MOBILE_DEVICE_TTL_MINUTES` to wrapped children.
No application manifest change or separate helper copy is needed. Do not set the
module URL manually to a different installation. Both packaged examples use it.

The helper returns a frozen `identity` and these methods:

| Method | Behaviour |
| --- | --- |
| `adb(args, options)` | Android only; supplies the captured `-s` selector |
| `simctl(args, options)` | iOS only; use `MOBILE_DEVICE` for each device operand |
| `xcodebuild(args, options)` | iOS `test-without-building` with an app-provided `-xctestrun`; supplies the captured simulator destination and disables parallel testing |
| `run(command, args, options)` | Wrapped custom launcher; its internal SDK calls must still honour the pin |

Operations throw on failure. `{capture: true}` returns `{code, stdout, stderr}`;
add `binary: true` for binary stdout such as Android screenshots. Captured output
is limited to 32 MiB; exceeding it stops the supervised operation and rejects
its result. SDK selector
checks still reject conflicting targets. The XCTest helper rejects explicit
destination/parallel overrides; other arbitrary scripts or test configurations
remain application-owned and cooperative. It cannot inspect hidden SDK calls or
undo device work already accepted. See [cancellation limits](commands.md#execute-against-an-existing-lease).

## Migrate an existing lease registry

Before enabling the new tool, inspect the existing manager's registry, owner
derivation and mutation lock. If the managers use compatible metadata and the
same socket mutex, set `MOBILE_DEVICE_LEASE_DIR` to the existing root for the
migration. Verify owner equality and token behaviour with disposable test state.

Changing only the environment variable prefix does not automatically connect
two registries. If managers have incompatible locking protocols, do not run them
concurrently on the same pool. Finish outstanding sessions and migrate the pool
as a coordinated change, or use completely disjoint devices.

## Prove application integration

Start with the [opt-in installed-package smoke harness](installed-smoke.md)
on dedicated idle virtual devices. It uses disposable callers and verifies
lease fencing and direct SDK targeting without application source. Then check
these application-specific behaviours from the application's worktree:

- Acquisition identifies the calling application checkout rather than the package directory.
- A repeat CLI call in another shell resolves the same device.
- A second owner cannot claim a held exact device.
- A wrapped SDK read reports the selected emulator or simulator.
- The existing preview launcher resolves the same device and respects the token.
- Normal release makes capacity available again.

Then perform one real build, installation and UI capture using the app's normal
local backend. Confirm that the displayed build belongs to the tested worktree.
Record the tested platform, environment and limitations before recommending the
tool to other projects. This package does not configure the application's backend,
signing credentials, login fixtures or framework-specific build paths.

## Personal migration of a first-device installer

An existing installer may run `adb devices`, choose the first row, then call
`adb -s <first> install`. Wrapping that installer does not fix its explicit
selector. Replace that device-selection path with the captured lease, or use
a personal adapter that performs its device phases outside the repository.
Do not run the original unsafe installer inside the wrapper.

The copyable [Android personal task](../examples/android-personal-task.mjs)
uses the captured owner, device and token for both APK installations, a real
instrumentation test invocation and a screenshot. Copy it to a personal
location such as `~/.local/share/mobile-device-lease/android-personal-task.mjs`.
Build the APKs with the application's normal commands. For a finite unattended
test with no later manual testing, run from its worktree:

```sh
device-session --platform android -- node \
  "$HOME/.local/share/mobile-device-lease/android-personal-task.mjs" \
  ./build/app.apk ./build/app-test.apk \
  com.example.app.test/androidx.test.runner.AndroidJUnitRunner ./shot.png
```

Replace the paths and test package/runner with the application's real outputs.
The adapter does not search for or select an emulator. Each operation runs
through `device-lease exec --owner <captured-owner> --token <captured-token>`
and passes `adb -s <captured-device>`. A stale token fails before the next
operation. Instrumentation must report `OK (...)`; an SDK process exiting zero
alone is not test success. A failed test prevents the screenshot and the outer
session cleans up its captured generation. The screenshot shows the state left
by the tests; add an explicitly pinned app launch if a particular screen is
required. Provide real application tests rather than interpreting boot readiness
as application verification.

For manual testing, acquire persistently first and invoke the adapter with
`device-lease exec --platform android --token '<captured-token>' -- node ...`
instead of `device-session`. That leaves the task's lease in place after the
screenshot, through user testing and later replies. Renew before expiry during
idle periods; release only under the manual-session condition above.
If adapting the original installer directly is preferable, pass the captured
serial into all of its device phases and remove any first-device discovery.
It must return only after testing and capture finish. Apply the same pattern
on iOS using the captured UDID in each `simctl` operation. The wrapper validates
direct SDK calls; it cannot discover hidden targeting decisions inside scripts.

## iOS installation, tests and capture

The [iOS personal task](../examples/ios-personal-task.mjs) uses the same helper
for boot readiness, installation, a real `xcodebuild test-without-building`
invocation, launch and capture. Copy it to a personal location such as
`~/.local/share/mobile-device-lease/ios-personal-task.mjs`, or into a project's
launcher directory for shared adoption.

The application supplies a simulator-compatible app, bundle ID and `.xctestrun`
file with real tests. Build them with its normal workflow and boot only the
leased simulator if it is shut down. Apple's [command-line testing guide](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)
describes the build-for-testing/test-without-building artefacts.

For a finite unattended workflow with no existing lease or later manual testing:

```sh
device-session --platform ios -- node \
  "$HOME/.local/share/mobile-device-lease/ios-personal-task.mjs" \
  ./build/Example.app ./build/Tests.xctestrun com.example.app ./ios-shot.png
```

For manual testing, acquire once with `device-lease acquire --platform ios --json`
and run that adapter under `device-lease exec --platform ios --token '<captured-token>' -- node ...`.
Keep the lease and renew while awaiting feedback. The adapter does not release it.
XCTest uses the captured UDID with parallel testing disabled to avoid selecting
cloned destinations. A failed test command prevents launch/capture. The app's
test configuration, signing, login, backend and expected screenshot state are
application responsibilities; successful stub tests of the adapter do not
establish an application's UI behaviour.
