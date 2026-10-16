# Choose your adoption scope

> Do you want this for your own agents on this machine, or as a shared project workflow?

Installation makes the commands available. Adoption makes every participating
agent acquire, preserve and release leases. Pick the scope before changing an
application repository. Both paths use the same device protocol and registry.

## Personal: your agents on your Mac

1. Install once with `npm install --global github:nick-cobra/agent-mobile-device-lease#v0.1.5`.
2. Ensure the global npm bin directory is on the agent process's PATH, not just an interactive terminal's PATH. Restart that process after changing PATH.
3. Add the [personal standing rule](agent-instructions.md#personal-rule) to your agent client's personal instruction source. The packaged [personal skill template](personal-skill.md) provides reusable task guidance alongside it. Do not replace existing instructions.
4. Run `device-lease adoption-check --scope personal` to inspect installation, registry, instruction locations and declared launchers. File presence does not prove the agent loaded the rules. Run `device-lease doctor --platform android` or `--platform ios` for SDK/capacity checks. Provide virtual-device capacity if needed.
5. Use the CLI from each application's worktree. Wrap an existing launcher only after confirming it honours the leased identity. For a launcher that picks the first emulator, use a [personal adapter](integration.md#personal-migration-of-a-first-device-installer).

Application repositories need no manifest, lockfile, script or instruction
changes for this path. You do not need to clone the tool repository. Store
personal adapters outside those repositories, for example in
`~/.local/share/mobile-device-lease/`.

For Codex, merge the personal rule into `~/.codex/AGENTS.md` (or the actual
Codex home). A non-empty `AGENTS.override.md` there takes precedence; project
instructions can also override global guidance. Codex discovers these files
at run/session start. For an already-open chat, do not assume the edited file
was loaded: restart the CLI session or start a fresh task, and ask it to confirm
the active mobile lease rule. To continue the current chat immediately, provide
the rule once and explicitly ask it to follow it; the saved file covers future
runs. Other agent clients have their own personal-rule locations and refresh
behaviour. [Official Codex instruction discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

## Project/team: a shared workflow

1. Add the pinned release as a development dependency with `pnpm add -D github:nick-cobra/agent-mobile-device-lease#v0.1.5` (or npm's `--save-dev`). Commit the manifest and lockfile. For an immutable pin, use the release's full Git commit SHA instead of its tag.
2. Add the [project standing rule](agent-instructions.md#project-rule) to the application's instructions.
3. Integrate the shared preview/install/test/capture launcher. Keep one captured device and acquisition token throughout the task.
4. Configure every project and worktree sharing devices to use the same registry and pool prefix. Inspect with `pnpm exec device-lease adoption-check --scope project`; optionally declare custom instruction and launcher paths in the [inspection configuration](commands.md#inspect-adoption). Run `pnpm exec device-lease doctor --platform android` or `--platform ios` for prerequisites/capacity.
5. Test the application's existing launcher against an owned virtual device and record the result before sharing the workflow with the team.

Each participant needs access to the installed dependency. A project's pinned
version makes updates reviewable; the lockfile is part of the adoption.
[Integration examples](integration.md) explain launcher and legacy-manager
migration. Keep the lease engines in the installed dependency; application
repositories own their integration code and configuration.

## Shared devices require one registry

The default is `~/.local/state/shared-mobile/device-leases`, or
`$XDG_STATE_HOME/shared-mobile/device-leases` when XDG state is configured.
Personal and project installs can coordinate through that same root. If you
change it, consistently set `MOBILE_DEVICE_LEASE_DIR` in every agent and launcher
environment. Do not assume an export in one tool call persists into the next.
The doctor prints the resolved registry and owner for comparison.

One registry per project is unsafe for overlapping pools. Existing managers
also need compatible metadata and mutation locking; sharing a directory alone
cannot make incompatible managers coordinate. Use the [migration checklist](integration.md#migrate-an-existing-lease-registry).

## Decide when the session finishes

Both adoption paths use the same [manual-session rule](../README.md#manual-testing-and-session-lifetime).
Installation, UI checks and screenshots may finish while the user is still
testing. Keep the lease across replies and while waiting for feedback; release
only when the user finishes testing, requests release or switches devices,
after outstanding device commands finish. Preserve the acquisition token.

Use persistent `acquire` + `exec` for that workflow. `device-session` is for
finite unattended work: it releases when its child exits, so a returning
installer is the wrong session boundary for later human testing.

The next release adds explicit bounded [keep-alive renewal](commands.md#keep-a-manual-session-renewed); verify its process and track its deadline before claiming automatic renewal.

Acquisition alone starts no idle renewal process. `exec` heartbeats only during
its child. Check `device-lease list --json`, renew before expiry throughout idle
periods, and report the actual deadline if no verified renewer is running. Do
not promise an indefinite reservation. Project installs prefix these commands
with `pnpm exec`. Copy the complete [personal or project standing rule](agent-instructions.md)
so session lifetime and renewal guidance reach participating agents.

## What the wrapper protects

This is cooperative ownership, not OS access control. Direct wrapped SDK calls
reject conflicting device selectors before starting. A shell command or an
installer can still choose another device internally. Inspect and adapt those
launchers; installing or wrapping them alone does not make their targeting safe.

Keep the session alive through installations, tests, screenshots and manual
testing. Finish background device work before release. If capacity is held, wait or
provide more devices rather than using an unwrapped command or force release.
