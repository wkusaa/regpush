import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

import { startMockRegistry } from "../fixtures/mock-registry.ts";

async function run(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(executable, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code: code ?? 1,
        output: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
}

it("pushes a buildx --load image through the packaged CLI and cleans artifacts", async (context) => {
  const dockerProbe = await run("docker", [
    "version",
    "--format",
    "{{.Server.Version}}",
  ]);
  if (dockerProbe.code !== 0) {
    if (process.env.REGPUSH_REQUIRE_DOCKER === "1")
      assert.fail("Docker is required for the integration test");
    context.skip("Docker daemon is unavailable");
    return;
  }

  const base = await mkdtemp(
    path.join(tmpdir(), "regpush-docker-integration-"),
  );
  const contextDirectory = path.join(base, "context");
  const workspaceBase = path.join(base, "workspaces");
  await mkdir(contextDirectory, { recursive: true });
  await mkdir(workspaceBase, { recursive: true });
  await writeFile(
    path.join(contextDirectory, "Dockerfile"),
    "FROM scratch\nCOPY hello.txt /hello.txt\n",
  );
  await writeFile(
    path.join(contextDirectory, "hello.txt"),
    "hello from regpush integration\n",
  );

  const registry = await startMockRegistry({ chunkSize: 512 });
  const registryHost = new URL(registry.origin).host;
  const image = `${registryHost}/integration/nested/app:test`;
  const testUsername = registry.username;
  const testPassword = registry.password;

  try {
    const build = await run("docker", [
      "buildx",
      "build",
      "--load",
      "--tag",
      image,
      contextDirectory,
    ]);
    assert.equal(build.code, 0, "docker buildx build --load failed");

    const execution = await run(
      process.execPath,
      [path.resolve("dist/cli.js"), "--insecure-http", image],
      {
        ...process.env,
        REGPUSH_PASSWORD: testPassword,
        REGPUSH_REQUEST_TIMEOUT_MS: "5000",
        REGPUSH_USERNAME: testUsername,
        RUNNER_TEMP: workspaceBase,
      },
    );
    assert.equal(
      execution.code,
      0,
      execution.output
        .replaceAll(testUsername, "***")
        .replaceAll(testPassword, "***"),
    );
    assert.doesNotMatch(
      execution.output,
      new RegExp(`${testUsername}|${testPassword}`, "u"),
    );
    assert.match(
      execution.output,
      new RegExp(
        `Image: ${image.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`,
        "u",
      ),
    );
    assert.match(execution.output, /Uploaded layers: [0-9]+\/[0-9]+/u);
    assert.match(execution.output, /Success:/u);

    const manifest = registry.state.manifests.get(
      "integration/nested/app:test",
    ) as
      { config: { digest: string }; layers: { digest: string }[] } | undefined;
    assert.ok(manifest);
    assert.ok(manifest.layers.length > 0);
    assert.ok(registry.state.blobs.has(manifest.config.digest));
    assert.ok(
      manifest.layers.every((layer) => registry.state.blobs.has(layer.digest)),
    );
    assert.deepEqual(await readdir(workspaceBase), []);
  } finally {
    await run("docker", ["image", "rm", image]);
    await registry.close();
    await rm(base, { force: true, recursive: true });
  }
});
