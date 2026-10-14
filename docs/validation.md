# Validation for version 0 1 0

Checked on 14 October 2026 with Node 24.19.0 on macOS.

## Standalone tests

All **160 tests passed**, with no failures, skipped tests or cancellations.
The suites cover selection, discovery, expiry, concurrent allocation, abandoned
mutex recovery, generation fencing, owned-device recovery, safe exports and
arguments, automatic session cleanup, build-slot contention and a heartbeat
while a child command is running.

Tests use temporary registries, fake capacity and stub SDK commands. They do
not install application builds onto the live device pool.

## Packaged installation

The package was packed into a tarball and installed offline into a separate
directory with no lifecycle scripts or runtime dependency downloads. The
installed command was then invoked from an existing application's Git worktree.

## Application smoke test

The installed CLI passed on both a real Android emulator and an iOS simulator:

- Owner identity resolved to the calling application's worktree.
- The application's existing launcher store resolved the installed CLI's lease.
- A second owner was refused the occupied exact device.
- The application's existing lease manager also refused a competing claim.
- A wrapped SDK command reported the exact leased serial or simulator UDID.
- Each acquired lease was released with its captured token after the check.

The smoke test used the application's existing registry, proving compatibility
with that manager's metadata and mutation lock. It did not create a second
registry competing for the same devices. No application repository files were
changed.

## Limits of this evidence

This proves installed-package ownership, targeting, registry compatibility and
contention on the tested macOS host. It does not prove every app's custom preview
launcher, backend, signing flow or UI journey. This smoke test did not build or
install a new application build.

Node 22 and Linux are included in the repository CI matrix; local execution here
used Node 24 on macOS. CI results must be checked separately after publication.
Windows, remote hosts and distributed allocation are outside the supported
scope of this release. Version 0.1.0 is an initial release; consumers should pin
the release and perform the integration checks in `docs/integration.md`.

## Version 0 1 1 compatibility configuration

All 167 standalone tests passed locally after the configuration update. Five
focused checks first failed against version 0.1.0 for missing legacy exports,
invalid-prefix acceptance, missing package-family protection and the wrong pool
selection in provisioning and on-demand boot; all five passed after implementation.
Additional final checks cover explicit prefix precedence and the actual recovery
CLI preserving a configured application's ANR. Existing 160 tests remain green.
