# Changelog

## Unreleased

- Add explicit, bounded `keep-alive` renewal for an existing captured manual-session lease, with text/JSON lifecycle status and cancellation-aware mutex waits. Stopping renewal leaves the lease held until its stored expiry or captured-token release.

## 0.1.5

- Package a project-neutral personal skill template alongside the copyable standing rules, with manual-session ownership and truthful idle renewal.
- Add read-only personal/project adoption checks for the running version, installation, registry, instruction locations and declared launcher files.
- Support optional inspection configuration for custom agent clients and personal adapters; keep agent loading and launcher targeting explicitly unverified.

## 0.1.4

- Keep manual testing and feedback across replies inside the documented session lifetime, with captured-token release only after the user finishes or switches devices.
- Clarify persistent acquire + exec versus finite unattended device-session cleanup, and explain idle expiry and verified renewal in both copyable agent rules.
- Include bounded SDK error output and distinguish missing commands, explicit permission restrictions, ordinary SDK failures, timeouts and output limits in doctor.
- Add a reusable captured-identity adapter helper with asynchronous supervised SDK operations and copied Android/iOS install, test and capture examples.
- Show remaining TTL, actual last renewal, expiry, owner and observed device state together in text/JSON status without changing ownership or reclaiming shut-down devices.
- Preserve global personal adoption without application repository changes; test copied examples from both personal and project package installations.

## 0.1.3

- Stop owned command and observable descendant process groups on lease loss, with one-second checks and bounded TERM/KILL escalation.
- Fence every execution heartbeat and final result to the captured acquisition token, including implicit-token calls.
- Supervise nested wrapper groups on loss and interruption; preserve normal output, exit codes and successor metadata.
- Close the direct `xcrun --find --run` selector-check bypass.
- Document host process-inspection and daemonisation limits.

## 0.1.2

- Offer personal and project/team adoption paths, standing rules and instruction-refresh guidance.
- Include a personal adapter for installation, instrumentation testing and screenshots.
- Reject conflicting selectors in directly wrapped Android and iOS SDK commands.
- Preserve explicit owner overrides in nested adapter commands.
- Report missing Android SDK executables accurately and add a read-only doctor for prerequisites, registry and capacity.

## 0.1.1

- Configure an existing Android AVD pool consistently across provisioning and allocation.
- Supply optional legacy device exports and operand placeholders without changing neutral defaults.
- Protect Android application package families during owned-device recovery.
- Preserve child acquisition token exports during wrapped execution.

## 0.1.0

Initial project-neutral extraction for local agent worktrees.

- Persistent Android emulator and iOS simulator leases with acquisition tokens.
- Safe concurrent claims, renewal, release and expired-record reclamation.
- Device execution wrapper and automatic session cleanup.
- Caller-based owner resolution for installed CLI use.
- Optional host build-slot wrapper and Android AVD pool provisioner.
- Configurable Android application crash protection during owned-device recovery.
- Standalone Node test suites, integration guidance and reusable agent instructions.

The initial release targets macOS. Remote hosts, distributed allocation and
Windows are outside this release's supported scope.
