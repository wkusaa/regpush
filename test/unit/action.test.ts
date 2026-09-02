import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { parse } from "yaml";

describe("GitHub Action metadata", () => {
  it("exposes the stable v1 input contract through a bundled Node 24 action", async () => {
    const metadata = parse(
      await readFile(new URL("../../action.yml", import.meta.url), "utf8"),
    );
    assert.deepEqual(Object.keys(metadata.inputs), [
      "image",
      "username",
      "password",
      "insecure-http",
      "cleanup",
    ]);
    assert.equal(metadata.inputs.image.required, true);
    assert.equal(metadata.inputs.username.required, true);
    assert.equal(metadata.inputs.password.required, true);
    assert.equal(metadata.inputs["insecure-http"].default, "false");
    assert.equal(metadata.inputs.cleanup.default, "false");
    assert.deepEqual(metadata.runs, { main: "dist/index.js", using: "node24" });
  });
});
