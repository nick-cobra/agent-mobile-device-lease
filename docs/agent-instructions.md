# Application agent instructions

Copy the block below into an application's `AGENTS.md` after installing and
integrating the package. Adapt only the project's preview command and environment
source; keep the shared registry and ownership requirements intact.

```md
## Shared mobile devices

Each independent agent uses its own Git worktree.

Acquire a lease before building for, installing on, or interacting with a shared
Android emulator or iOS simulator:

- pnpm exec device-lease acquire --platform android
- pnpm exec device-lease acquire --platform ios

Use the project's lease-aware preview launcher. Wrap raw commands with
pnpm exec device-lease exec --platform <android|ios> -- <command>.
Use MOBILE_DEVICE as a simulator operand; never use booted.

For one managed command, device-session acquires exclusively, renews during the
command and releases its captured acquisition token afterwards. Use exec with
an existing lease when the task spans multiple commands.

Keep the lease until build, installation, interaction and evidence capture have
finished. Do not release while a background command still uses the device.
Use mobile-build-slot around heavy build phases when sharing host capacity.

All projects sharing devices use the same lease registry. Do not rely on shell
exports persisting across agent tool calls. If migrating managers, prove their
locking and owner compatibility before sharing a pool.

If capacity is full, wait or provision more devices. Do not take another
worktree's device or use force overrides. Recover only the owned virtual device.
Never reset or shut down the entire pool. Preserve application crashes and ANRs.

For Android recovery, configure MOBILE_APP_PACKAGES with all application package
IDs, including debug variants. Keep test-only capacity overrides out of real
device sessions.
```
