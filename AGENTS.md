# Agent Mobile Device Lease contributor instructions

This repository owns a local, cooperative lease protocol for agent worktrees
sharing Android emulators and iOS simulators. It is a CLI package with no runtime
dependencies. Applications provide their own builds and preview flows.

Keep names, documentation, examples and fixtures project-neutral. Do not commit
private application source, source-repository URLs, user-specific paths, secrets,
real device identifiers, account configuration or device captures.

Read `README.md`, `docs/commands.md` and `docs/integration.md` before changing
public behaviour. Runtime modules are under `scripts/lib/`; CLI entries and
Node test suites are under `scripts/`.

Preserve these invariants:

- Registry mutations are serialised across processes.
- A caller's checkout owns a lease; a package installation directory does not.
- A successor acquisition token cannot be released by an older run.
- Holder-stamped expiry cannot be shortened by a contender's settings.
- Every device operation is pinned to the captured device identity.
- Physical hardware is excluded from automatic allocation by default.
- Recovery targets only owned virtual devices and preserves configured app failures.
- Device ownership and host build capacity remain separate mechanisms.

Run `npm test` before proposing a change. Use temporary lease roots, fake capacity
and stub SDK commands for tests. Do not drive the live device pool as a unit-test
fixture. Add process-level regression tests for concurrency changes.

Test the packaged installation when changing bins, owner resolution, imports or
distribution metadata. Document platform limits honestly. Do not add runtime
dependencies, hosted services or automatic npm publication without discussion.
