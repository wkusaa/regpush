import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseCliArguments } from "../../src/cli-arguments.ts";

describe("CLI arguments", () => {
  it("accepts an image and explicit transport and cleanup flags", () => {
    assert.deepEqual(
      parseCliArguments([
        "--insecure-http",
        "--no-cleanup",
        "registry.example/team/app:tag",
      ]),
      {
        cleanup: false,
        help: false,
        image: "registry.example/team/app:tag",
        insecureHttp: true,
      },
    );
  });

  for (const passwordArgument of ["--password=visible", "--password", "-p"]) {
    it(`rejects visible password argument ${passwordArgument}`, () => {
      assert.throws(
        () =>
          parseCliArguments([
            passwordArgument,
            "registry.example/team/app:tag",
          ]),
        /Unknown option/u,
      );
    });
  }
});
