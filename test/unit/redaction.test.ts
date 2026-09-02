import assert from "node:assert/strict";
import { it } from "node:test";

import { redactSecrets } from "../../src/redaction.ts";

it("redacts credentials and a complete Basic authorization value", () => {
  const username = "test-redaction-user";
  const password = "test-redaction-password";
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const redacted = redactSecrets(
    `user=${username} password=${password} header=${authorization}`,
    [username, password, authorization],
  );
  assert.equal(redacted, "user=*** password=*** header=***");
});
