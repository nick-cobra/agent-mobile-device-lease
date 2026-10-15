# Standing agent instructions

Installing the CLI does not opt agents into the lease protocol. Choose a block
for your adoption scope and merge it into the appropriate instruction source.
Do not overwrite existing instructions. See [Adoption](adoption.md) for personal
rule locations, existing-chat refresh and shared-registry configuration. A
packaged [personal skill template](personal-skill.md) provides reusable task
guidance alongside these rules; it does not guarantee automatic participation.
Inspect configured locations with `device-lease adoption-check --scope personal`
or `pnpm exec device-lease adoption-check --scope project`.

## Personal rule

Save this in your agent client's personal instructions. It uses globally
installed commands and does not require application repository changes.

```md
## Shared mobile devices on this machine

Before any shared Android emulator or iOS simulator interaction, acquire a lease
with device-lease acquire --platform <android|ios> --json from the application's
worktree. Each independent agent uses its own worktree. Capture the returned
owner, deviceId and token once for the whole session.

Use device-lease exec --platform <android|ios> --token <captured-token> -- <command>
for raw SDK commands.
Use MOBILE_DEVICE for an explicit target; never choose the first device or booted.
Use persistent acquire + exec for manual testing spanning calls or replies.
A session includes installation, agent UI checks, screenshots, the user's manual
testing and waiting for feedback. An installer returning, a screenshot finishing
or an agent turn ending does not finish that session. Keep it reserved while the
user tests. Release only when the user says testing is finished, asks to release
it or switches away from that device, and all device commands have finished:
device-lease release --platform <android|ios> --token <captured-token>.

Leases expire unless renewed, including during idle periods. Acquisition alone
starts no background renewer; exec renews only while its child runs. Renew before
the stored expiry with device-lease renew --platform <android|ios>
--token <captured-token>. Inspect device-lease list --json for actual expiry.
Use the same --ttl-minutes on renew/exec when using a custom lifetime.
Claim automatic idle renewal only after starting and verifying a real renewal
process. Otherwise report the deadline and arrange renewal before it; do not
promise indefinite reservation. If ownership expires or is lost, stop device
commands and resolve ownership before continuing.

Use device-session --platform <android|ios> -- <command> only for finite
unattended work whose whole device lifecycle finishes inside its child. It
releases the captured token when that child exits, even on failure. Do not use
it for an installer or launcher that returns before the user's manual testing.

Installing the CLI or wrapping a launcher does not make that launcher's internal
device selection safe. Inspect it first. If it ignores ANDROID_SERIAL,
MOBILE_DEVICE_ID or IOS_SIMULATOR, use a personal adapter outside the application
repository that pins installation, testing and screenshots to the captured
identity/token. Keep MOBILE_DEVICE_OWNER and MOBILE_DEVICE_TOKEN in child calls.

Finish background device commands before releasing. Use mobile-build-slot only
around heavy builds when sharing host capacity. All projects
sharing devices must use the same registry and compatible lease protocol.
Do not assume shell exports persist across tool calls. Compare registry/owner
with device-lease doctor --platform <android|ios> before first use.

Wait when capacity is held. Never take another owner's device, force-release a
lease, or reset/shut down the entire pool. Recovery targets only the owned virtual
device and must preserve application crashes/ANRs. Configure MOBILE_APP_PACKAGES
or MOBILE_APP_PACKAGE_PREFIXES before Android recovery. Keep fake/test capacity
settings out of real sessions. Leases are cooperative; unwrapped SDK calls can
bypass them.
```

## Project rule

Commit this in the application's `AGENTS.md` or equivalent shared instructions
after pinning the dependency and adapting the project's launcher.

```md
## Shared mobile devices

Each independent agent uses its own Git worktree. Acquire before shared device
work with pnpm exec device-lease acquire --platform <android|ios> --json.
Capture the returned owner, deviceId and token once for the whole session.

Use the project's lease-aware preview launcher. Wrap raw SDK commands with
pnpm exec device-lease exec --platform <android|ios> --token <captured-token> -- <command>.
Use MOBILE_DEVICE as an explicit device operand; never pick the first device
or use booted. A launcher must honour the pin internally; wrapping it alone is
insufficient. Keep the captured owner, identity and token throughout all work.

Use persistent acquire + exec for manual testing spanning calls or replies.
A session includes installation, agent UI checks, screenshots, the user's manual
testing and waiting for feedback. An installer returning, a screenshot finishing
or an agent turn ending does not finish that session. Keep it reserved while the
user tests. Release only when the user says testing is finished, asks to release
it or switches away from that device, and all device commands have finished:
pnpm exec device-lease release --platform <android|ios> --token <captured-token>.

Leases expire unless renewed, including during idle periods. Acquisition alone
starts no background renewer; exec renews only while its child runs. Renew before
the stored expiry with pnpm exec device-lease renew --platform <android|ios>
--token <captured-token>. Inspect pnpm exec device-lease list --json for actual expiry.
Use the same --ttl-minutes on renew/exec when using a custom lifetime.
Claim automatic idle renewal only after starting and verifying a real renewal
process. Otherwise report the deadline and arrange renewal before it; do not
promise indefinite reservation. If ownership expires or is lost, stop device
commands and resolve ownership before continuing.

Use pnpm exec device-session --platform <android|ios> -- <command> only for finite
unattended work whose whole device lifecycle finishes inside its child. It
releases the captured token when that child exits, even on failure. Do not use
it for an installer or launcher that returns before the user's manual testing.

Finish background commands before releasing. Use pnpm exec mobile-build-slot
only around heavy build phases, not while waiting for feedback.

All projects sharing devices use the same registry and compatible mutation
protocol. Do not rely on exports persisting across tool calls. Wait for capacity;
never force-release another task's lease or reset/shut down the entire pool.
Recovery targets only the owned virtual device. Configure application package
IDs/prefixes to preserve crashes and ANRs. Do not use test capacity in real work.
Leases coordinate participants; unwrapped commands can bypass them.
```

Replace `pnpm exec` with `npm exec --` when that is the project's package manager.
Keep the application's backend, build, login and test instructions alongside
this rule; the device tool does not configure them.

These rules define intended session lifetime; they do not change TTL or prevent
an explicit valid release. See [manual-session examples and renewal](../README.md#manual-testing-and-session-lifetime)
and the [adapter helper](integration.md#reuse-the-adapter-helper).
