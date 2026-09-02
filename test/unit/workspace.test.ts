import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { ImageWorkspace } from "../../src/workspace.ts";

async function doesNotExist(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return false;
  } catch {
    return true;
  }
}

describe("image workspace", () => {
  it("isolates image artifacts and removes them by default", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "regpush-workspace-test-"));
    try {
      const first = await ImageWorkspace.create({
        baseDirectory: base,
        cleanup: true,
        imageId: "sha256:aaa",
      });
      const second = await ImageWorkspace.create({
        baseDirectory: base,
        cleanup: true,
        imageId: "sha256:bbb",
      });
      assert.notEqual(first.root, second.root);
      assert.match(first.root, /aaa/u);
      await first.dispose();
      await second.dispose();
      assert.equal(await doesNotExist(first.root), true);
      assert.equal(await doesNotExist(second.root), true);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });

  it("retains completed cache files only when cleanup is disabled", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "regpush-workspace-test-"));
    try {
      const workspace = await ImageWorkspace.create({
        baseDirectory: base,
        cleanup: false,
        imageId: "sha256:ccc",
      });
      await workspace.dispose();
      assert.equal(await doesNotExist(workspace.root), false);
    } finally {
      await rm(base, { force: true, recursive: true });
    }
  });
});
