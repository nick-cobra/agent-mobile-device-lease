# Integrating into an application

## Install instead of copying

Add the pinned GitHub release as a development dependency and commit the
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
