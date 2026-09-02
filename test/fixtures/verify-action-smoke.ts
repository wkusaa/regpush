import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const statePath = process.argv[2];
if (!statePath) throw new Error("Expected state path");

for (let attempt = 0; attempt < 50; attempt += 1) {
  const state = JSON.parse(
    await readFile(statePath, "utf8").catch(() => "{}"),
  ) as {
    blobCount?: number;
    manifests?: string[];
    patchCount?: number;
  };
  if (state.manifests?.includes("smoke/nested/app:sha-test")) {
    assert.ok((state.blobCount ?? 0) >= 2);
    assert.ok((state.patchCount ?? 0) >= 2);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

assert.fail(
  "Action smoke registry did not receive the expected manifest and blobs",
);
