import { writeFile } from "node:fs/promises";

import { startMockRegistry } from "./mock-registry.ts";

const [originPath, statePath] = process.argv.slice(2);
if (!originPath || !statePath)
  throw new Error("Expected origin and state output paths");

const registry = await startMockRegistry({
  chunkSize: 512,
  password: "action-test-password",
  username: "action-test-user",
});
await writeFile(originPath, registry.origin);

const writeState = async () => {
  await writeFile(
    statePath,
    JSON.stringify({
      blobCount: registry.state.blobs.size,
      manifests: [...registry.state.manifests.keys()],
      patchCount: registry.state.patches.length,
    }),
  );
};
const interval = setInterval(() => void writeState(), 50);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    clearInterval(interval);
    void writeState().finally(async () => {
      await registry.close();
      process.exit(0);
    });
  });
}
