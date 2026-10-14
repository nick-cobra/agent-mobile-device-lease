import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acquireMobileBuildLock,
  describeMobileBuildLock,
  resolveMobileBuildLockPath,
  resolveMobileBuildLockPort,
} from "./lib/mobile-build-lock.mjs";

async function availablePort() {
  const server = createServer();
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const port = server.address().port;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

describe("mobile preview build lock", () => {
  it("uses shared machine state rather than a worktree path", () => {
    assert.equal(
      resolveMobileBuildLockPath({ XDG_STATE_HOME: "/state" }, "/home/developer"),
      "/state/shared-mobile/mobile-preview-build.lock",
    );
    assert.equal(resolveMobileBuildLockPort({ MOBILE_BUILD_LOCK_PORT: "48123" }), 48_123);
    assert.equal(resolveMobileBuildLockPort({}), 46_781);
    for (const raw of ["0", "65536", "malformed"])
      assert.throws(
        () => resolveMobileBuildLockPort({ MOBILE_BUILD_LOCK_PORT: raw }),
        /must be an integer from 1 to 65535/,
      );
  });

  it("records the actual ephemeral socket and releases its owned metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    let release;
    try {
      release = await acquireMobileBuildLock({ lockPath, port: 0 });
      const metadata = describeMobileBuildLock(lockPath);
      assert.ok(Number.isInteger(metadata.port) && metadata.port >= 1 && metadata.port <= 65535);
      const socket = connect({ host: metadata.host, port: metadata.port });
      try {
        await new Promise((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
      } finally {
        socket.destroy();
      }
      await release();
      assert.equal(describeMobileBuildLock(lockPath), null);
    } finally {
      await release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases its socket while preserving a successor diagnostic token", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    let release;
    try {
      release = await acquireMobileBuildLock({ lockPath, port: 0 });
      const metadata = describeMobileBuildLock(lockPath);
      const successor = { ...metadata, owner: "/foreign", token: "successor-token" };
      await writeFile(lockPath, JSON.stringify(successor));
      await release();
      assert.deepEqual(describeMobileBuildLock(lockPath), successor);
      const socket = connect({ host: metadata.host, port: metadata.port });
      try {
        const held = await new Promise((resolve) => {
          socket.once("connect", () => resolve(true));
          socket.once("error", () => resolve(false));
        });
        assert.equal(held, false);
      } finally {
        socket.destroy();
      }
    } finally {
      await release?.();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records the holder and releases only its own lock", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    const port = await availablePort();
    try {
      const release = await acquireMobileBuildLock({
        lockPath,
        port,
        pid: 123,
        owner: "/worktree/a",
        label: "android",
      });
      assert.deepEqual(describeMobileBuildLock(lockPath), {
        token: describeMobileBuildLock(lockPath).token,
        pid: 123,
        owner: "/worktree/a",
        label: "android",
        host: "127.0.0.1",
        port,
        acquiredAt: describeMobileBuildLock(lockPath).acquiredAt,
      });
      await release();
      assert.equal(describeMobileBuildLock(lockPath), null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("overwrites diagnostic metadata left by a terminated build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    const port = await availablePort();
    try {
      await writeFile(lockPath, JSON.stringify({ pid: 999999, label: "stale" }));

      const release = await acquireMobileBuildLock({
        lockPath,
        port,
        pid: 456,
        owner: "/worktree/b",
        label: "ios",
      });
      assert.equal(describeMobileBuildLock(lockPath).pid, 456);
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("times out rather than running a second preview build", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    const port = await availablePort();
    try {
      const release = await acquireMobileBuildLock({ lockPath, port, pid: 111 });
      await assert.rejects(
        acquireMobileBuildLock({ lockPath, port, pid: 222, waitMs: 0 }),
        /Timed out waiting for the mobile preview build slot .* held by PID 111/,
      );
      await release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically admits exactly one simultaneous contender", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mobile-mobile-build-"));
    const lockPath = path.join(root, "build.lock");
    const port = await availablePort();
    try {
      const outcomes = await Promise.allSettled([
        acquireMobileBuildLock({ lockPath, port, pid: 301, waitMs: 0 }),
        acquireMobileBuildLock({ lockPath, port, pid: 302, waitMs: 0 }),
      ]);

      const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
      assert.equal(winners.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(
        rejected[0].reason.message,
        /Timed out waiting for the mobile preview build slot/,
      );
      await winners[0].value();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
