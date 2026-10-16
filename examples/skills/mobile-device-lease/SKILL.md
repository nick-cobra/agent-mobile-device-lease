---
name: mobile-device-lease
description: Coordinate shared Android emulators and iOS simulators with the globally installed Agent Mobile Device Lease CLI during app installation, device tests, interaction, captures and manual testing.
---

# Personal mobile device leases

Use the globally installed CLI from the application's worktree. Keep application
repositories unchanged for personal adoption; store any personal adapters outside
them. Application build, backend, login and test choices remain application-owned.

## Establish ownership

- Run `device-lease adoption-check --scope personal` to inspect this installation,
  registry, instruction locations and declared launchers. File presence does not
  prove instructions were loaded or launcher targeting is correct. Use
  `device-lease doctor --platform android` (or `ios`) for SDK/capacity diagnostics.
- Every participant sharing devices must resolve the same registry and compatible
  pool settings. Each independent agent uses a separate worktree. Never use fake
  capacity in real work or take another owner's device when capacity is held.
- Before device interaction, run `device-lease acquire --platform <android|ios>
  --json`. Capture the returned owner, deviceId and token once, plus any custom
  TTL. Preserve them across tool calls and replies; shell exports may not persist.
  Do not reread metadata to adopt a successor's token.

## Pin every device operation

Run SDK commands through `device-lease exec --platform <android|ios>
--owner '<captured-owner>' --token '<captured-token>' --device '<captured-device>'
-- <command>`. Use `MOBILE_DEVICE` for explicit device operands, for example
`xcrun simctl io MOBILE_DEVICE screenshot shot.png`. Android receives the captured
`ANDROID_SERIAL`. Never select the first device or use `booted`/`all`.

Inspect existing launchers before wrapping them. A script choosing another device
internally can bypass the pin. Adapt it to the captured identity or use a personal
adapter. The installed `captureDevice` helper is available in wrapped children
through `MOBILE_DEVICE_ADAPTER_MODULE`; it preserves captured ownership for Android
and iOS operations. Preserve `MOBILE_DEVICE_OWNER` and `MOBILE_DEVICE_TOKEN` in
nested calls. Leases coordinate participants; they do not block OS access.

Use `mobile-build-slot` only around heavy builds, separately from the device lease.
Finish background device commands before returning from a launcher. If ownership
expires or is lost, stop device commands and resolve ownership before continuing.
Recovery must target only the owned virtual device, preserve app crashes/ANRs and
use configured application package IDs/prefixes. Never reset the entire pool.

## Keep manual sessions alive

Use persistent `acquire` + `exec` for installation followed by manual testing.
Keep the lease while the user tests and while waiting for feedback across replies.
An installer returning, a screenshot finishing or an agent turn ending does not
finish that session.

Acquisition starts no idle renewer. `exec` renews only during its child; idle leases
still expire. Inspect `device-lease list --json` for the actual deadline. Renew
before expiry with `device-lease renew --platform <android|ios>
--owner '<captured-owner>' --token '<captured-token>'`. Repeat a custom
`--ttl-minutes` on renew/exec. Claim automatic idle renewal only after starting and
verifying a real renewal process. Otherwise report the deadline and arrange renewal
before it; do not promise indefinite reservation. Device shutdown after a restart
does not end a valid lease or prove its owner is finished.

For a release including `keep-alive`, explicitly run `device-lease keep-alive
--platform <android|ios> --owner <captured-owner> --device <captured-device>
--token <captured-token> --duration-minutes 60 --json` in a persistent process
session. Check its `started` event and live PID before claiming renewal; track
its health and finite deadline across replies. It preserves the stored TTL
unless overridden. Stop the verified own renewer and wait for exit before
final captured-token release. Stopping renewal leaves the lease held. See
the installed command reference for availability and status fields.

Release only when the user finishes testing, requests release or switches devices,
after all device commands finish: `device-lease release --platform <android|ios>
--owner '<captured-owner>' --token '<captured-token>'`.

For finite unattended work whose whole device lifecycle ends inside its child,
`device-session --platform <android|ios> -- <command>` acquires, renews and releases
on child exit, including failure. It is unsuitable for a returning installer
followed by human testing. It refuses to adopt an existing lease; use `exec` when
ownership is already established.
