import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BlobArtifact, ImageArtifacts } from "./artifacts.ts";
import type { ImageWorkspace } from "./workspace.ts";

const CACHE_SCHEMA_VERSION = 1;
const MAX_CACHE_METADATA_BYTES = 1024 * 1024;
const CACHE_METADATA_NAME = "artifacts-v1.json";

type CachedBlobArtifact = {
  digest: string;
  file: string;
  size: number;
};

type ArtifactCacheMetadata = {
  config: CachedBlobArtifact;
  imageId: string;
  layers: CachedBlobArtifact[];
  schemaVersion: number;
};

async function sha256File(filePath: string): Promise<`sha256:${string}`> {
  const hasher = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hasher.update(chunk);
  return `sha256:${hasher.digest("hex")}`;
}

function isCachedBlobArtifact(value: unknown): value is CachedBlobArtifact {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<CachedBlobArtifact>;
  return (
    typeof candidate.digest === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(candidate.digest) &&
    typeof candidate.file === "string" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size! > 0
  );
}

async function validateCachedBlob(
  cacheDirectory: string,
  cached: CachedBlobArtifact,
  expectedFile: string,
): Promise<BlobArtifact | undefined> {
  if (cached.file !== expectedFile) return undefined;
  const filePath = path.join(cacheDirectory, expectedFile);
  const fileStatus = await lstat(filePath).catch(() => undefined);
  if (
    !fileStatus?.isFile() ||
    fileStatus.isSymbolicLink() ||
    fileStatus.size !== cached.size
  ) {
    return undefined;
  }
  const digest = await sha256File(filePath).catch(() => undefined);
  if (digest !== cached.digest) return undefined;
  return { digest, filePath, size: cached.size };
}

export async function readArtifactCache(
  workspace: ImageWorkspace,
  maxTemporaryBytes: number,
  maxLayers: number,
): Promise<ImageArtifacts | undefined> {
  if (workspace.cleanup) return undefined;
  const metadataPath = path.join(workspace.cacheDirectory, CACHE_METADATA_NAME);
  const metadataStatus = await lstat(metadataPath).catch(() => undefined);
  if (
    !metadataStatus?.isFile() ||
    metadataStatus.isSymbolicLink() ||
    metadataStatus.size > MAX_CACHE_METADATA_BYTES
  ) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const metadata = parsed as Partial<ArtifactCacheMetadata>;
  if (
    metadata.schemaVersion !== CACHE_SCHEMA_VERSION ||
    metadata.imageId !== workspace.imageId ||
    !isCachedBlobArtifact(metadata.config) ||
    !Array.isArray(metadata.layers) ||
    metadata.layers.length > maxLayers ||
    metadata.layers.some((layer) => !isCachedBlobArtifact(layer))
  ) {
    return undefined;
  }

  const cachedLayers = metadata.layers as CachedBlobArtifact[];
  const totalBytes = [metadata.config, ...cachedLayers].reduce(
    (total, artifact) => total + artifact.size,
    0,
  );
  if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTemporaryBytes) {
    return undefined;
  }

  const config = await validateCachedBlob(
    workspace.cacheDirectory,
    metadata.config,
    "config.json",
  );
  if (!config) return undefined;
  const layers: BlobArtifact[] = [];
  for (const [index, layer] of cachedLayers.entries()) {
    const validated = await validateCachedBlob(
      workspace.cacheDirectory,
      layer,
      `layer-${index}.tar.gz`,
    );
    if (!validated) return undefined;
    layers.push(validated);
  }
  return { config, layers };
}

export async function writeArtifactCache(
  workspace: ImageWorkspace,
  artifacts: ImageArtifacts,
  currentTemporaryBytes: number,
  maxTemporaryBytes: number,
): Promise<void> {
  if (workspace.cleanup) return;
  const metadataPath = path.join(workspace.cacheDirectory, CACHE_METADATA_NAME);
  const partialPath = `${metadataPath}.part`;
  const metadata: ArtifactCacheMetadata = {
    config: {
      digest: artifacts.config.digest,
      file: path.basename(artifacts.config.filePath),
      size: artifacts.config.size,
    },
    imageId: workspace.imageId,
    layers: artifacts.layers.map((layer) => ({
      digest: layer.digest,
      file: path.basename(layer.filePath),
      size: layer.size,
    })),
    schemaVersion: CACHE_SCHEMA_VERSION,
  };
  const serialized = JSON.stringify(metadata);
  if (
    currentTemporaryBytes + Buffer.byteLength(serialized) >
    maxTemporaryBytes
  ) {
    throw new Error(
      "Artifact cache metadata exceeds the temporary storage limit",
    );
  }
  await rm(partialPath, { force: true });
  try {
    await writeFile(partialPath, serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(partialPath, metadataPath);
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}
