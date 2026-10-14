# Standing agent instructions

Installing the CLI does not opt agents into the lease protocol. Choose a block
for your adoption scope and merge it into the appropriate instruction source.
Do not overwrite existing instructions. See [Adoption](adoption.md) for personal
rule locations, existing-chat refresh and shared-registry configuration.

## Personal rule

Save this in your agent client's personal instructions. It uses globally
installed commands and does not require application repository changes.

```md
## Shared mobile devices on this machine

Before any shared Android emulator or iOS simulator interaction, acquire a lease
with device-lease acquire --platform <android|ios> from the application's
worktree. Each independent agent uses its own worktree.

Use device-lease exec --platform <android|ios> -- <command> for raw SDK commands.
Use MOBILE_DEVICE for an explicit target; never choose the first device or booted.
For one complete task, device-session --platform <android|ios> -- <launcher>
acquires exclusively, renews during the launcher and releases the captured token.
Use exec if a lease already exists for a task spanning several calls.

Installing the CLI or wrapping a launcher does not make that launcher's internal
device selection safe. Inspect it first. If it ignores ANDROID_SERIAL,
MOBILE_DEVICE_ID or IOS_SIMULATOR, use a personal adapter outside the application
repository that pins installation, testing and screenshots to the captured
identity/token. Keep MOBILE_DEVICE_OWNER and MOBILE_DEVICE_TOKEN in child calls.

Keep the lease until all device work and background tasks finish. Use
mobile-build-slot around heavy builds when sharing host capacity. All projects
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
work with pnpm exec device-lease acquire --platform <android|ios>.

Use the project's lease-aware preview launcher. Wrap raw SDK commands with
pnpm exec device-lease exec --platform <android|ios> -- <command>.
Use MOBILE_DEVICE as an explicit device operand; never pick the first device
or use booted. A launcher must honour the pin internally; wrapping it alone is
insufficient. Keep the captured owner, identity and token throughout all work.

pnpm exec device-session --platform <android|ios> -- <launcher> acquires
exclusively, renews during the complete task and releases its captured token.
Use exec for an existing task lease. Finish background device work before
returning. Use pnpm exec mobile-build-slot around heavy build phases.

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
