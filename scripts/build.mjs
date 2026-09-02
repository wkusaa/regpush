import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });

for (const [entryPoint, outfile] of [
  ["src/main.ts", "dist/index.js"],
  ["src/cli.ts", "dist/cli.js"],
]) {
  await build({
    bundle: true,
    entryPoints: [entryPoint],
    format: "esm",
    legalComments: "eof",
    minify: true,
    outfile,
    platform: "node",
    sourcemap: false,
    target: "node24",
  });
}

await chmod("dist/cli.js", 0o755);
