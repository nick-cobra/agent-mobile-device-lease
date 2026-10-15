# Validation

## Initial 0.1.0 validation

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

## Version 0.1.1 compatibility configuration

All 168 standalone tests passed locally after the configuration update. Five
focused checks first failed against version 0.1.0 for missing legacy exports,
invalid-prefix acceptance, missing package-family protection and the wrong pool
selection in provisioning and on-demand boot; all five passed after implementation.
Additional final checks cover explicit prefix precedence and the actual recovery
CLI preserving a configured application's ANR. Existing 160 tests remain green.

A further focused RED showed that a legacy operand prefix rewrote a partial word; the token-boundary fix passed its focused GREEN and the final 168-test corpus.

## Version 0.1.2 adoption and SDK checks

All **196 tests passed** locally on Node 22.23.2, macOS, with no failures,
skips or cancellations. The original 168 tests remain green. The new corpus
covers direct Android selector overrides, conflicting/global iOS targets,
matching targets and ordinary install/shell flags, explicit-owner propagation,
missing `avdmanager`, read-only Android/iOS diagnostics, and the personal adapter.

Fifteen focused tests first failed against 0.1.1: overridden SDK selectors were
executed, the missing executable was misreported, and doctor was unavailable.
A separate RED reproduced a lost explicit owner in a nested personal session;
that regression passes after the captured owner is exported. The final corpus
also verifies refusal of multiple simulator targets and instrumentation failures,
zero-test results and stale acquisition generations.

An offline packaged-installation test installs the same tarball globally in a
personal prefix and locally in a disposable project. The personal application's
manifest stays absent. Both installations resolve their calling worktrees,
contend for the same registry, reject a conflicting wrapped selector, and release
only the captured generation. The package includes the adoption guide and
copyable personal adapter.

These new SDK/adapter checks use stubs and disposable registries, not application
builds or live devices. They do not establish every application's instrumentation
runner or screenshot state. The original real-device evidence above remains
identified as the initial validation. Hosted Node 22/24 macOS/Linux CI provides
separate platform evidence after publication.

## Version 0.1.3 ownership-loss supervision

All **214 tests passed** locally on Node 22.23.2, macOS, with no failures,
skips or cancellations. The original 196 tests remain green, including live
heartbeat renewal and offline personal/project packaged installations. The
packaged CLI also executes a command through the new supervision helper and
preserves its captured owner, device and token.

Five process-level tests first failed against 0.1.2: owner transfer, same-owner
successor token, expiry, a root/descendant ignoring SIGTERM, and loss before a
short command returned success. Three additional baseline failures cover
nested SIGINT/SIGTERM cleanup and loss while heartbeat renewal waits for the
registry mutex. These regressions pass after implementation. Tests verify
cessation of the recorded root and descendant PIDs within a five-second test
budget, retention of successor metadata, and survival of an unrelated process.
Missing/malformed metadata, restricted process inspection, ordinary output and
nonzero child status are also checked.

A separate RED confirmed that combined xcrun lookup/run options could bypass
direct simulator selector validation. The final tests cover both option orders,
long/short spellings, conflicting targets, and permitted owned-target/lookup use.

These are real local subprocess tests with fake device capacity and disposable
registries; they do not operate live emulators or simulators. One-second polling
and 750 ms escalation are scheduling targets, not hard real-time guarantees.
Already-dispatched SDK work, hidden daemonised processes and an uncatchable
wrapper SIGKILL remain outside cancellation guarantees. Hosted Node 22/24
macOS/Linux CI is checked separately before release.

## Version 0.1.4 customer feedback

All **234 tests passed** locally on Node 22.23.2, macOS, with no failures,
skips or cancellations. The previous 214 tests remain green. Ten new CLI-level
regressions first failed for missing SDK failure details/classification, absent
structured status and missing renewal timestamps. Adapter discovery also failed
against the previous implementation before the helper was added.

The new checks cover explicit permission restrictions versus ambiguous SDK
errors, missing executables, bounded stderr/stdout, valid shut-down leases,
expiry, legacy renewal timestamps, absent devices and failed/invalid state
queries. Registry bytes remain unchanged by status/doctor observations; a
contender cannot claim the valid shut-down lease. Android offline and
unauthorised states remain visible.

Adapter checks exercise captured identity/registry/TTL despite later environment
changes, stale successor tokens between operations, active ownership loss,
SIGINT/SIGTERM cleanup of SDK processes ignoring signals, bounded captured output,
binary fidelity and conflicting selectors/destinations. Offline tarball tests
copy both Android and iOS examples outside the installed package and execute them
from personal and project installations. The personal application gains no
manifest; each manual workflow retains its lease after capture. Failed XCTest
prevents later launch/capture. The project module import is also exercised.

These checks use real local subprocesses, disposable registries, fake capacity
and stub SDK/build commands. They do not prove a real application's XCTest
configuration, live SDK permissions or human/agent compliance with manual testing
instructions. Manual-session guidance does not add an idle background renewer,
change TTL or prevent an explicit valid release. Hosted Node 22/24 macOS/Linux
checks are verified separately before release.
