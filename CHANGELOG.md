# Changelog

## 0 1 1

- Configure an existing Android AVD pool consistently across provisioning and allocation.
- Supply optional legacy device exports and operand placeholders without changing neutral defaults.
- Protect Android application package families during owned-device recovery.
- Preserve child acquisition token exports during wrapped execution.

## 0 1 0

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
