import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RegistryClient } from "../../src/registry.ts";
import { startMockRegistry } from "../fixtures/mock-registry.ts";

describe("chunked registry upload", () => {
  it("honors chunk boundaries and completes the blob by digest", async () => {
    const registry = await startMockRegistry({ chunkSize: 4 });
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "regpush-test-"),
    );
    const blob = Buffer.from("abcdefghij");
    const blobPath = path.join(temporaryDirectory, "blob.gz");
    await writeFile(blobPath, blob);
    const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        password: registry.password,
        repository: "team/nested/app",
        timeoutMs: 5_000,
        username: registry.username,
      });
      const result = await client.uploadBlob(digest, blobPath, blob.length);

      assert.equal(result, "uploaded");
      assert.deepEqual(registry.state.patches, [
        { contentRange: "0-3", length: 4, range: "0-3" },
        { contentRange: "4-7", length: 4, range: "0-7" },
        { contentRange: "8-9", length: 2, range: "0-9" },
      ]);
      assert.deepEqual(registry.state.blobs.get(digest), blob);
    } finally {
      await registry.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("rejects authentication without exposing a response body", async () => {
    const registry = await startMockRegistry();
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "regpush-test-"),
    );
    const blob = Buffer.from("authentication-test");
    const blobPath = path.join(temporaryDirectory, "blob.gz");
    await writeFile(blobPath, blob);
    const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        password: "wrong-test-password",
        repository: "team/app",
        timeoutMs: 5_000,
        username: registry.username,
      });
      await assert.rejects(
        client.uploadBlob(digest, blobPath, blob.length),
        (error: Error) => {
          assert.match(error.message, /HTTP 401/u);
          assert.doesNotMatch(
            error.message,
            /redacted test detail|wrong-test-password/u,
          );
          return true;
        },
      );
    } finally {
      await registry.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("rejects a server range that does not acknowledge the sent bytes", async () => {
    const registry = await startMockRegistry({ rangeOverride: "0-1" });
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "regpush-test-"),
    );
    const blob = Buffer.from("range-test");
    const blobPath = path.join(temporaryDirectory, "blob.gz");
    await writeFile(blobPath, blob);
    const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;

    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        password: registry.password,
        repository: "team/app",
        timeoutMs: 5_000,
        username: registry.username,
      });
      await assert.rejects(
        client.uploadBlob(digest, blobPath, blob.length),
        /acknowledged byte 1; expected 3/u,
      );
      assert.equal(registry.state.blobs.size, 0);
    } finally {
      await registry.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("short-circuits a blob that already exists", async () => {
    const blob = Buffer.from("already-there");
    const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
    const registry = await startMockRegistry({
      existingDigests: new Set([digest]),
    });
    const temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "regpush-test-"),
    );
    const blobPath = path.join(temporaryDirectory, "blob.gz");
    await writeFile(blobPath, blob);

    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        password: registry.password,
        repository: "nested/team/app",
        timeoutMs: 5_000,
        username: registry.username,
      });
      assert.equal(
        await client.uploadBlob(digest, blobPath, blob.length),
        "existing",
      );
      assert.equal(registry.state.patches.length, 0);
      assert.equal(
        registry.state.requests.filter((request) => request.method === "POST")
          .length,
        0,
      );
    } finally {
      await registry.close();
      await rm(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it("fails when the registry rejects the manifest without exposing its body", async () => {
    const registry = await startMockRegistry({ failManifest: true });
    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        password: registry.password,
        repository: "team/app",
        timeoutMs: 5_000,
        username: registry.username,
      });
      await assert.rejects(
        client.uploadManifest(
          "sha-test",
          { schemaVersion: 2 },
          "application/vnd.oci.image.manifest.v1+json",
        ),
        (error: Error) => {
          assert.match(error.message, /HTTP 400/u);
          assert.doesNotMatch(error.message, /test-only detail/u);
          return true;
        },
      );
      assert.equal(registry.state.manifests.size, 0);
    } finally {
      await registry.close();
    }
  });
});
