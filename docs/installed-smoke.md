# Check an installed release on virtual devices

`device-lease-smoke` is an explicit operator check of the installed package's
lease protocol and direct SDK targeting. It needs no tool checkout, application
source, build, credentials or screenshots. Ordinary `npm test` and CI remain
device-free, using disposable registries and stub SDKs.

## Prepare deliberately

1. Install Node 22+ and the exact candidate package globally or in a disposable
   project. Use an immutable Git SHA or the packed release tarball. Record its
   SHA-256 separately from the smoke report.
2. Install Android platform tools for Android. For iOS, use a Mac with Xcode,
   command-line tools and an installed simulator runtime. Run `device-lease
   doctor --platform android` or `ios` locally to diagnose host permissions and
   missing SDK commands. Doctor output can include personal paths; do not publish
   it without inspection.
3. Arrange an idle, dedicated **already booted** virtual test device through
   your normal lease-aware operator workflow. Finish and release only your own
   preparation lease before running the harness. Choose an Android `emulator-N`
   serial or an iOS iPhone simulator UUID; physical hardware is refused. The
   harness neither boots nor provisions devices.
4. Export the **same** `MOBILE_DEVICE_LEASE_DIR` used by all participating tools
   sharing those devices. Preserve any pool configuration. Do not create another
   registry for an overlapping pool. The selected device must have no lease
   record, even an expired one. Unrelated records must have valid expiry with
   enough remaining time for the whole smoke budget plus 30 seconds; otherwise
   the harness refuses before acquisition because normal allocation can reclaim
   expired records platform-wide. Resolve stale state through normal operator
   procedures; never force-release another task to make this test pass.

## Invoke the installed bin

For a global installation, substitute your dedicated device's exact identity:

```sh
device-lease-smoke --live --platform android --device '<dedicated-emulator-serial>' --json
device-lease-smoke --live --platform ios --device '<dedicated-simulator-uuid>' --json
```

For a project installation, use `pnpm exec device-lease-smoke` or
`npm exec -- device-lease-smoke` with those same arguments. The working directory
can be any disposable caller directory. The harness uses two distinct temporary
callers and its own installed lease entry point, rather than an unrelated CLI
on PATH. It clears inherited caller/token and Git overrides, while preserving
the selected registry and normal SDK configuration.

`--live` is mandatory for real SDK evidence. It refuses fake-capacity and
lease test-delay environment seams. `--stubbed` is a separate developer mode for
fixtures: it always reports `validationMode: "stubbed"` and
`liveSdkValidated: false`, regardless of command success. A live run trusts your
SDK commands on PATH; it cannot authenticate vendor binaries or detect arbitrary
replacement executables. Record how the SDK was installed in local evidence.

`--timeout-seconds` sets a 1–300 second overall execution budget (default 120).
SIGINT/SIGTERM stops owned command groups, with bounded escalation, before
captured-token cleanup. Cleanup has an additional five-second command budget per
captured generation, plus process-stop escalation. These are scheduling budgets,
not hard real-time guarantees; [execution limits](commands.md#execute-against-an-existing-lease)
still apply to hidden daemonised processes, uncatchable kills and host process
inspection restrictions.

## What is checked

- Installed version, disposable caller ownership and configured registry.
- A second caller cannot acquire the exact held device or change its metadata.
- Captured-token renewal advances expiry and records an actual renewal.
- A directly wrapped `adb get-serialno` or `simctl getenv SIMULATOR_UDID` returns
  the captured identity. Inventory queries and SDK version reads are read-only.
- With SDK work stopped, an inert local child ignores TERM. The harness releases
  its own first generation, acquires a successor for its second caller, and
  verifies the old wrapper rejects the lost result and stops that child.
- A stale first-generation release preserves the successor byte for byte;
  successor cleanup uses only the token returned by that acquisition.
- Unrelated lease metadata and observed unrelated device states match the
  initial snapshots. Concurrent outside changes make the result inconclusive;
  the harness does not reset them or claim it caused them.

Exit 0 requires all checks and cleanup to pass. JSON identifies host/Node/SDK
versions, executed checks, failures and unreached skips. Only a complete live
run sets `liveSdkValidated: true`. Reports omit device identifiers, owner and
registry paths, tokens, raw SDK output and application information. Missing SDK,
permission, timeout and other failure categories identify the failed phase;
use doctor locally for detailed SDK diagnostics.

Observation counts identify how many unrelated records/states were present;
an empty unrelated-lease snapshot does not prove populated-registry behaviour.
The device-free regressions separately exercise populated unrelated records.

On partial failure, only known captured generations are released. If acquisition
was interrupted before returning its token, cleanup is **unverified** and the
short lease is left to expire; the harness never rereads a token to adopt it.
Inspect the configured registry through the normal manager before retrying.
No force-release, shared registry deletion, device shutdown, app install,
SDK download or release publication is performed.

## Release evidence

Before publishing a version, maintainers must:

1. Finish the issue PRs and independent reviews, then pass the full test suite
   and hosted Node 22/24 macOS/Linux matrix on the release candidate.
2. Pack that exact source with `npm pack`, record its source SHA and tarball
   SHA-256, and install it offline with `--ignore-scripts` in both a personal
   prefix and a disposable project. Check both installed bins; unit coverage of
   these paths is explicitly stubbed.
3. Run the installed candidate with `--live` on a dedicated Android emulator
   and iOS simulator. Record which installation/platform combinations actually
   ran, the redacted reports and any unavailable/skipped checks. Do not promote
   stubbed or historical evidence to a fresh live pass. If a required platform
   is unavailable, resolve that limitation before declaring this release's live
   validation complete.
4. Confirm cleanup, review the publication files for private data, and publish
   the same immutable source with installable tarball and SHA-256 checksums.
   This tool does not publish to npm automatically.

This evidence covers leases and direct SDK targeting. Application launchers,
signing, backend integration, builds and UI journeys need the application's own
[integration verification](integration.md#prove-application-integration).
