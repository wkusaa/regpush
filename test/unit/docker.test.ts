import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { DockerClient } from "../../src/docker.ts";

describe("local Docker image requirement", () => {
  it("fails when docker cannot inspect the requested image", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "regpush-docker-test-"),
    );
    const dockerPath = path.join(directory, "docker");
    await writeFile(dockerPath, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await chmod(dockerPath, 0o700);

    try {
      const docker = new DockerClient({ dockerPath, timeoutMs: 2_000 });
      await assert.rejects(
        docker.requireLocalImage("registry.example/team/app:missing"),
        /Docker image registry\.example\/team\/app:missing was not found locally/u,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("does not pass regpush credentials into Docker subprocesses", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "regpush-docker-test-"),
    );
    const dockerPath = path.join(directory, "docker");
    const imageId = `sha256:${"d".repeat(64)}`;
    await writeFile(
      dockerPath,
      `#!/bin/sh\nif [ -n "$INPUT_PASSWORD$INPUT_USERNAME$REGPUSH_PASSWORD$REGPUSH_USERNAME$PASSWORD_REGISTRY$USERNAME_REGISTRY" ]; then exit 42; fi\nprintf '%s\\n' '${imageId}'\n`,
      { mode: 0o700 },
    );
    await chmod(dockerPath, 0o700);
    const credentialNames = [
      "INPUT_PASSWORD",
      "INPUT_USERNAME",
      "REGPUSH_PASSWORD",
      "REGPUSH_USERNAME",
      "PASSWORD_REGISTRY",
      "USERNAME_REGISTRY",
    ] as const;
    const previous = new Map(
      credentialNames.map((name) => [name, process.env[name]]),
    );
    for (const name of credentialNames)
      process.env[name] = "subprocess-test-secret";

    try {
      const docker = new DockerClient({ dockerPath, timeoutMs: 2_000 });
      assert.equal(
        await docker.requireLocalImage("registry.example/team/app:test"),
        imageId,
      );
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(directory, { force: true, recursive: true });
    }
  });
});
