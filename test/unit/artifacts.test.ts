import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import * as tar from "tar";

import { prepareImageArtifacts } from "../../src/artifacts.ts";
import { DockerClient } from "../../src/docker.ts";
import { ImageWorkspace } from "../../src/workspace.ts";

const gunzipAsync = promisify(gunzip);

describe("Docker image artifacts", () => {
  it("extracts, hashes raw config bytes, and compresses a layer", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "regpush-artifact-test-"));
    const fixture = path.join(base, "fixture");
    const bin = path.join(base, "bin");
    const fixtureTar = path.join(base, "fixture.tar");
    const imageId = `sha256:${"a".repeat(64)}`;
    const configBytes = Buffer.from('{"comment":"café"}\n', "utf8");
    const layerBytes = Buffer.from("layer-tar-content");

    await writeFile(path.join(base, "placeholder"), "");
    await Promise.all([
      import("node:fs/promises").then(({ mkdir }) =>
        mkdir(fixture, { recursive: true }),
      ),
      import("node:fs/promises").then(({ mkdir }) =>
        mkdir(bin, { recursive: true }),
      ),
    ]);
    await writeFile(path.join(fixture, "config.json"), configBytes);
    await writeFile(path.join(fixture, "layer.tar"), layerBytes);
    await writeFile(
      path.join(fixture, "manifest.json"),
      JSON.stringify([
        {
          Config: "config.json",
          Layers: ["layer.tar"],
          RepoTags: ["registry.example/team/app:tag"],
        },
      ]),
    );
    await tar.c({ cwd: fixture, file: fixtureTar }, [
      "config.json",
      "layer.tar",
      "manifest.json",
    ]);

    const dockerPath = path.join(bin, "docker");
    await writeFile(
      dockerPath,
      `#!/bin/sh\nif [ "$2" = "inspect" ]; then printf '%s\\n' '${imageId}'; exit 0; fi\nif [ "$2" = "save" ]; then cp "$REGPUSH_TEST_FIXTURE" "$4"; exit 0; fi\nexit 1\n`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);

    const previousFixture = process.env.REGPUSH_TEST_FIXTURE;
    process.env.REGPUSH_TEST_FIXTURE = fixtureTar;
    let workspace: ImageWorkspace | undefined;
    try {
      const docker = new DockerClient({ dockerPath, timeoutMs: 2_000 });
      const resolvedId = await docker.requireLocalImage(
        "registry.example/team/app:tag",
      );
      workspace = await ImageWorkspace.create({
        baseDirectory: base,
        cleanup: true,
        imageId: resolvedId,
      });
      const progress: unknown[] = [];
      const artifacts = await prepareImageArtifacts({
        docker,
        image: "registry.example/team/app:tag",
        maxTemporaryBytes: 10 * 1024 * 1024,
        onProgress: (event) => progress.push(event),
        workspace,
      });

      assert.equal(
        artifacts.config.digest,
        `sha256:${createHash("sha256").update(configBytes).digest("hex")}`,
      );
      assert.equal(artifacts.config.size, configBytes.length);
      assert.equal(artifacts.layers.length, 1);
      assert.deepEqual(
        await gunzipAsync(await readFile(artifacts.layers[0]!.filePath)),
        layerBytes,
      );
      assert.deepEqual(progress, [
        { phase: "compressing", totalLayers: 1 },
        {
          layer: 1,
          phase: "layer-compressed",
          size: artifacts.layers[0]!.size,
          totalLayers: 1,
        },
      ]);
    } finally {
      if (previousFixture === undefined)
        delete process.env.REGPUSH_TEST_FIXTURE;
      else process.env.REGPUSH_TEST_FIXTURE = previousFixture;
      await workspace?.dispose();
      await rm(base, { force: true, recursive: true });
    }
  });
});
