# Integrating into an application

Start with [Adoption](adoption.md): choose personal installation for your own
agents or committed integration for a project/team. Both paths use the same
registry for overlapping devices. Installation alone does not enlist agents or
fix an existing launcher's device selection.

## Project installation instead of copying

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

Copying the package's `scripts/` directory is also supported. If copying, use
`node scripts/device-lease.mjs` and the other entry files rather than installed
bin names. Include all `scripts/lib/` helpers.

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

For a launcher that honours `ANDROID_SERIAL` or `IOS_SIMULATOR`, use:

```sh
pnpm exec device-session --platform android -- node scripts/mobile-preview.mjs
```

That example runs the application's own preview script under the lease heartbeat.
Adapt the script filename to the application. Keep the session process alive
until all device interactions are complete; do not launch background work and
exit the session immediately.

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
8. Release only its own captured generation after device work finishes.

The CLI's `acquire --json` output supplies `{platform, deviceId, token, owner}`.
Use the token returned by that acquisition; rereading current metadata during
cleanup may adopt a successor's token. Avoid overlapping same-owner tasks.

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

Start with installed-package smoke tests from the application's worktree:

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
Build the APKs with the application's normal commands, then from its worktree:

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

For an already-held lease, invoke the adapter with `device-lease exec` instead
of `device-session`. That leaves the task's lease in place for later calls.
If adapting the original installer directly is preferable, pass the captured
serial into all of its device phases and remove any first-device discovery.
It must return only after testing and capture finish. Apply the same pattern
on iOS using the captured UDID in each `simctl` operation. The wrapper validates
direct SDK calls; it cannot discover hidden targeting decisions inside scripts.
