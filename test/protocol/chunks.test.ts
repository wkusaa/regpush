import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { RegistryClient } from "../../src/registry.ts";
import { startMockRegistry } from "../fixtures/mock-registry.ts";

describe("chunked registry upload", () => {
  it("defaults to 10 MiB chunks when the registry permits larger requests", async () => {
    const registry = await startMockRegistry({
      chunkSize: 100 * 1024 * 1024,
      minChunkSize: 5 * 1024 * 1024,
    });
    const directory = await mkdtemp(
      path.join(tmpdir(), "regpush-default-chunks-"),
    );
    const blob = Buffer.alloc(10 * 1024 * 1024 + 1, 42);
    const filePath = path.join(directory, "blob");
    await writeFile(filePath, blob);
    const digest = `sha256:${createHash("sha256").update(blob).digest("hex")}`;
    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        repository: "team/app",
        username: registry.username,
        password: registry.password,
        timeoutMs: 5000,
      });
      assert.equal(
        await client.uploadBlob(digest, filePath, blob.length),
        "uploaded",
      );
      assert.deepEqual(
        registry.state.patches.map((patch) => patch.length),
        [10 * 1024 * 1024, 1],
      );
      assert.deepEqual(registry.state.blobs.get(digest), blob);
    } finally {
      await registry.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports nested transport codes without exposing transport messages", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("secret transport detail"), {
          code: "EPIPE",
        }),
      });
    };
    try {
      const client = new RegistryClient({
        baseUrl: "https://registry.invalid",
        repository: "team/app",
        username: "test-user",
        password: "test-password",
        timeoutMs: 5000,
      });
      await assert.rejects(
        client.uploadManifest("latest", {}, "application/json"),
        (error: Error) => {
          assert.ok(error instanceof TypeError);
          assert.match(error.message, /PUT.*EPIPE/u);
          assert.doesNotMatch(error.message, /secret transport detail/u);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("honors chunk boundaries and completes the blob by digest", async () => {
    const registry = await startMockRegistry({ chunkSize: 8 });
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
        maxChunkBytes: 4,
        timeoutMs: 5_000,
        username: registry.username,
      });
      const progress: {
        chunkSize: number;
        totalBytes: number;
        uploadedBytes: number;
      }[] = [];
      const result = await client.uploadBlob(
        digest,
        blobPath,
        blob.length,
        (event) => progress.push(event),
      );

      assert.equal(result, "uploaded");
      assert.deepEqual(progress, [
        { chunkSize: 4, totalBytes: 10, uploadedBytes: 0 },
        { chunkSize: 4, totalBytes: 10, uploadedBytes: 4 },
        { chunkSize: 4, totalBytes: 10, uploadedBytes: 8 },
        { chunkSize: 4, totalBytes: 10, uploadedBytes: 10 },
      ]);
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

  it("rejects a chunk cap below the advertised minimum before sending data", async () => {
    const registry = await startMockRegistry({ chunkSize: 8, minChunkSize: 5 });
    try {
      const client = new RegistryClient({
        baseUrl: registry.origin,
        repository: "team/app",
        username: registry.username,
        password: registry.password,
        timeoutMs: 5000,
        maxChunkBytes: 4,
      });
      await assert.rejects(
        client.uploadBlob(`sha256:${"a".repeat(64)}`, "unused", 10),
        /below the registry minimum/u,
      );
      assert.equal(
        registry.state.requests.some((request) => request.method === "PATCH"),
        false,
      );
    } finally {
      await registry.close();
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
