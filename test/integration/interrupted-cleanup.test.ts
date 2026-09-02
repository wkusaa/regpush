import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as tar from "tar";

import { runRegpush } from "../../src/regpush.ts";
import { startMockRegistry } from "../fixtures/mock-registry.ts";

describe("interrupted upload cleanup", () => {
  it("returns failure after bounded retries and removes temporary image artifacts", async () => {
    const base = await mkdtemp(
      path.join(tmpdir(), "regpush-interrupted-test-"),
    );
    const fixture = path.join(base, "fixture");
    const fixtureTar = path.join(base, "fixture.tar");
    const workspaceBase = path.join(base, "workspaces");
    const dockerPath = path.join(base, "docker");
    await mkdir(fixture, { recursive: true });
    await mkdir(workspaceBase, { recursive: true });
    await writeFile(path.join(fixture, "config.json"), "{}\n");
    await writeFile(path.join(fixture, "layer.tar"), "interrupted-layer");
    await writeFile(
      path.join(fixture, "manifest.json"),
      JSON.stringify([{ Config: "config.json", Layers: ["layer.tar"] }]),
    );
    await tar.c({ cwd: fixture, file: fixtureTar }, [
      "config.json",
      "layer.tar",
      "manifest.json",
    ]);
    const imageId = `sha256:${"b".repeat(64)}`;
    await writeFile(
      dockerPath,
      `#!/bin/sh\nif [ "$2" = "inspect" ]; then printf '%s\\n' '${imageId}'; exit 0; fi\nif [ "$2" = "save" ]; then cp "$REGPUSH_TEST_FIXTURE" "$4"; exit 0; fi\nexit 1\n`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);

    const registry = await startMockRegistry({ interruptPatch: true });
    const previousFixture = process.env.REGPUSH_TEST_FIXTURE;
    process.env.REGPUSH_TEST_FIXTURE = fixtureTar;
    try {
      const registryHost = new URL(registry.origin).host;
      await assert.rejects(
        runRegpush({
          cleanup: true,
          dockerPath,
          image: `${registryHost}/team/nested/app:test`,
          insecureHttp: true,
          logger: { error() {}, info() {}, warning() {} },
          maxRetries: 2,
          maxTemporaryBytes: 10 * 1024 * 1024,
          password: registry.password,
          processTimeoutMs: 2_000,
          requestTimeoutMs: 2_000,
          temporaryBaseDirectory: workspaceBase,
          username: registry.username,
        }),
      );
      assert.deepEqual(await readdir(workspaceBase), []);
      assert.equal(
        registry.state.requests.filter(
          (request) =>
            request.method === "POST" && request.pathname.endsWith("/uploads/"),
        ).length,
        4,
      );
    } finally {
      if (previousFixture === undefined)
        delete process.env.REGPUSH_TEST_FIXTURE;
      else process.env.REGPUSH_TEST_FIXTURE = previousFixture;
      await registry.close();
      await rm(base, { force: true, recursive: true });
    }
  });
});
