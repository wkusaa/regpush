import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createGzip, constants as zlibConstants } from "node:zlib";
import * as tar from "tar";

import type { DockerClient } from "./docker.ts";
import type { ImageWorkspace } from "./workspace.ts";

type DockerSaveManifest = {
  Config: string;
  Layers: string[];
  RepoTags?: string[];
};

export type BlobArtifact = {
  digest: `sha256:${string}`;
  filePath: string;
  size: number;
};

export type ImageArtifacts = {
  config: BlobArtifact;
  layers: BlobArtifact[];
};

export type PrepareImageArtifactsOptions = {
  docker: DockerClient;
  image: string;
  maxTemporaryBytes: number;
  workspace: ImageWorkspace;
};

const MAX_TAR_ENTRIES = 100_000;
const COMPRESSION_CONCURRENCY = 3;

function safeExtractedPath(root: string, relativePath: string): string {
  if (relativePath.length === 0 || path.isAbsolute(relativePath))
    throw new Error("Docker save contains an unsafe path");
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, relativePath);
  if (
    resolved !== resolvedRoot &&
    !resolved.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw new Error("Docker save contains an unsafe path");
  }
  return resolved;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  const failures: unknown[] = [];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++;
        try {
          results[index] = await work(values[index]!, index);
        } catch (error) {
          failures.push(error);
        }
      }
    }),
  );
  if (failures.length > 0) throw failures[0];
  return results;
}

async function inspectArchive(
  filePath: string,
  maxBytes: number,
): Promise<number> {
  let entryCount = 0;
  let expandedBytes = 0;
  await tar.t({
    file: filePath,
    onReadEntry(entry) {
      entryCount += 1;
      expandedBytes += entry.size;
      if (entryCount > MAX_TAR_ENTRIES)
        throw new Error(
          `Docker save exceeds the ${MAX_TAR_ENTRIES} entry limit`,
        );
      if (expandedBytes > maxBytes)
        throw new Error("Docker save exceeds the temporary storage limit");
    },
    strict: true,
  });
  return expandedBytes;
}

async function compressLayer(
  sourcePath: string,
  outputPath: string,
  reserveBytes: (count: number) => void,
): Promise<BlobArtifact> {
  const partialPath = `${outputPath}.part`;
  await rm(partialPath, { force: true });
  const hasher = createHash("sha256");
  let size = 0;
  const accounting = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        reserveBytes(chunk.length);
        size += chunk.length;
        hasher.update(chunk);
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    },
  });

  try {
    await pipeline(
      createReadStream(sourcePath),
      createGzip({ finishFlush: zlibConstants.Z_FINISH, level: 9 }),
      accounting,
      createWriteStream(partialPath, { flags: "wx", mode: 0o600 }),
    );
    await rename(partialPath, outputPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }

  return {
    digest: `sha256:${hasher.digest("hex")}`,
    filePath: outputPath,
    size,
  };
}

export async function prepareImageArtifacts(
  options: PrepareImageArtifactsOptions,
): Promise<ImageArtifacts> {
  if (
    !Number.isSafeInteger(options.maxTemporaryBytes) ||
    options.maxTemporaryBytes <= 0
  ) {
    throw new Error("Temporary storage limit must be a positive safe integer");
  }

  await options.docker.saveImage(options.image, options.workspace.tarPath);
  const tarSize = (await stat(options.workspace.tarPath)).size;
  if (tarSize > options.maxTemporaryBytes)
    throw new Error("Docker save exceeds the temporary storage limit");
  const expandedBytes = await inspectArchive(
    options.workspace.tarPath,
    options.maxTemporaryBytes - tarSize,
  );
  await tar.x({
    cwd: options.workspace.extractedDirectory,
    file: options.workspace.tarPath,
    strict: true,
  });

  const manifestPath = safeExtractedPath(
    options.workspace.extractedDirectory,
    "manifest.json",
  );
  const manifests = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  if (!Array.isArray(manifests) || manifests.length !== 1) {
    throw new Error("Docker save must contain exactly one image manifest");
  }
  const manifest = manifests[0] as Partial<DockerSaveManifest>;
  if (typeof manifest.Config !== "string" || !Array.isArray(manifest.Layers)) {
    throw new Error("Docker save manifest is malformed");
  }
  if (manifest.Layers.some((layer) => typeof layer !== "string")) {
    throw new Error("Docker save manifest contains a malformed layer path");
  }

  const configPath = safeExtractedPath(
    options.workspace.extractedDirectory,
    manifest.Config,
  );
  const configBytes = await readFile(configPath);
  const config: BlobArtifact = {
    digest: `sha256:${createHash("sha256").update(configBytes).digest("hex")}`,
    filePath: configPath,
    size: configBytes.length,
  };

  let usedBytes = tarSize + expandedBytes;
  const reserveBytes = (count: number) => {
    usedBytes += count;
    if (usedBytes > options.maxTemporaryBytes)
      throw new Error("Compressed layers exceed the temporary storage limit");
  };
  const layers = await mapConcurrent(
    manifest.Layers,
    COMPRESSION_CONCURRENCY,
    async (layer, index) => {
      const layerPath = safeExtractedPath(
        options.workspace.extractedDirectory,
        layer,
      );
      const outputPath = path.join(
        options.workspace.cacheDirectory,
        `layer-${index}.tar.gz`,
      );
      return compressLayer(layerPath, outputPath, reserveBytes);
    },
  );

  return { config, layers };
}
