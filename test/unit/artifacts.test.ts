import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
  it("extracts, hashes, compresses, and reuses validated image artifacts", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "regpush-artifact-test-"));
    const fixture = path.join(base, "fixture");
    const bin = path.join(base, "bin");
    const fixtureTar = path.join(base, "fixture.tar");
    const saveMarker = path.join(base, "docker-save-ran");
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
      `#!/bin/sh\nif [ "$2" = "inspect" ]; then printf '%s\\n' '${imageId}'; exit 0; fi\nif [ "$2" = "save" ]; then\n  if [ -e "$REGPUSH_TEST_SAVE_MARKER" ]; then exit 97; fi\n  : > "$REGPUSH_TEST_SAVE_MARKER"\n  cp "$REGPUSH_TEST_FIXTURE" "$4"\n  exit 0\nfi\nexit 1\n`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);

    const previousFixture = process.env.REGPUSH_TEST_FIXTURE;
    const previousSaveMarker = process.env.REGPUSH_TEST_SAVE_MARKER;
    process.env.REGPUSH_TEST_FIXTURE = fixtureTar;
    process.env.REGPUSH_TEST_SAVE_MARKER = saveMarker;
    let workspace: ImageWorkspace | undefined;
    try {
      const docker = new DockerClient({ dockerPath, timeoutMs: 2_000 });
      const resolvedId = await docker.requireLocalImage(
        "registry.example/team/app:tag",
      );
      workspace = await ImageWorkspace.create({
        baseDirectory: base,
        cleanup: false,
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
      await assert.rejects(access(workspace.tarPath));
      await assert.rejects(access(workspace.extractedDirectory));
      assert.equal((await stat(workspace.root)).mode & 0o777, 0o700);
      assert.equal((await stat(artifacts.config.filePath)).mode & 0o777, 0o600);

      const cacheProgress: unknown[] = [];
      const cachedArtifacts = await prepareImageArtifacts({
        docker,
        image: "registry.example/team/app:tag",
        maxTemporaryBytes: 10 * 1024 * 1024,
        onProgress: (event) => cacheProgress.push(event),
        workspace,
      });
      assert.deepEqual(cachedArtifacts, artifacts);
      assert.deepEqual(cacheProgress, [
        {
          phase: "cache-hit",
          totalBytes: artifacts.config.size + artifacts.layers[0]!.size,
          totalLayers: 1,
        },
      ]);

      const corruptedLayer = await readFile(
        cachedArtifacts.layers[0]!.filePath,
      );
      corruptedLayer[0] = corruptedLayer[0]! ^ 0xff;
      await writeFile(cachedArtifacts.layers[0]!.filePath, corruptedLayer);
      await rm(saveMarker, { force: true });
      const rebuildProgress: unknown[] = [];
      const rebuiltArtifacts = await prepareImageArtifacts({
        docker,
        image: "registry.example/team/app:tag",
        maxTemporaryBytes: 10 * 1024 * 1024,
        onProgress: (event) => rebuildProgress.push(event),
        workspace,
      });
      assert.equal(
        rebuiltArtifacts.layers[0]!.digest,
        artifacts.layers[0]!.digest,
      );
      assert.equal(
        rebuildProgress.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "phase" in event &&
            event.phase === "cache-hit",
        ),
        false,
      );
      assert.equal(
        rebuildProgress.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "phase" in event &&
            event.phase === "compressing",
        ),
        true,
      );
    } finally {
      if (previousFixture === undefined)
        delete process.env.REGPUSH_TEST_FIXTURE;
      else process.env.REGPUSH_TEST_FIXTURE = previousFixture;
      if (previousSaveMarker === undefined)
        delete process.env.REGPUSH_TEST_SAVE_MARKER;
      else process.env.REGPUSH_TEST_SAVE_MARKER = previousSaveMarker;
      await workspace?.dispose();
      await rm(base, { force: true, recursive: true });
    }
  });
});
