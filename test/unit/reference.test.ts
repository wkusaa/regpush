import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseImageReference } from "../../src/reference.ts";

describe("image reference parsing", () => {
  it("keeps a nested repository and explicit tag", () => {
    assert.deepEqual(
      parseImageReference("registry.example:5000/team/platform/app:sha-abc123"),
      {
        image: "registry.example:5000/team/platform/app:sha-abc123",
        registry: "registry.example:5000",
        repository: "team/platform/app",
        reference: "sha-abc123",
      },
    );
  });

  it("defaults an untagged image to latest", () => {
    assert.equal(
      parseImageReference("registry.example/team/app").reference,
      "latest",
    );
  });

  for (const invalid of [
    "https://registry.example/team/app:tag",
    "user:password@registry.example/team/app:tag",
    "registry.example/team/../app:tag",
    "registry.example/Team/app:tag",
    "registry.example/team/app:bad tag",
    "registry/team/app:tag",
    "-registry.example/team/app:tag",
    "registry.example",
    "",
  ]) {
    it(`rejects ${JSON.stringify(invalid)}`, () => {
      assert.throws(
        () => parseImageReference(invalid),
        /invalid image reference/i,
      );
    });
  }
});
