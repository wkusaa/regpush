import { tmpdir } from "node:os";
import path from "node:path";

import { prepareImageArtifacts, type BlobArtifact } from "./artifacts.ts";
import { DockerClient } from "./docker.ts";
import { parseImageReference } from "./reference.ts";
import {
  RegistryClient,
  RegistryRequestError,
  type UploadResult,
} from "./registry.ts";
import { ImageWorkspace } from "./workspace.ts";

export type RegpushLogger = {
  error(message: string): void;
  info(message: string): void;
  warning(message: string): void;
};

export type RunRegpushOptions = {
  cleanup: boolean;
  dockerPath?: string | undefined;
  image: string;
  insecureHttp: boolean;
  logger?: RegpushLogger | undefined;
  maxRetries?: number | undefined;
  maxTemporaryBytes?: number | undefined;
  password: string;
  processTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  temporaryBaseDirectory?: string | undefined;
  username: string;
};

export type RegpushResult = {
  existingLayers: number;
  image: string;
  totalLayers: number;
  uploadedLayers: number;
};

const DEFAULT_MAX_TEMPORARY_BYTES = 20 * 1024 * 1024 * 1024;
const DEFAULT_PROCESS_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const UPLOAD_CONCURRENCY = 3;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = units[0]!;
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index]!;
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function artifactLabel(index: number, layerCount: number): string {
  return index < layerCount
    ? `Layer ${index + 1}/${layerCount}`
    : "Configuration";
}

function validateCredentials(username: string, password: string): void {
  if (username.length === 0 || password.length === 0)
    throw new Error("Registry username and password are required");
  if (username.includes(":"))
    throw new Error("Registry username must not contain a colon");
  if (
    username.includes("\0") ||
    username.includes("\r") ||
    username.includes("\n") ||
    password.includes("\0") ||
    password.includes("\r") ||
    password.includes("\n")
  ) {
    throw new Error(
      "Registry credentials must not contain NUL, CR, or LF characters",
    );
  }
}

function validateBoundedInteger(
  name: string,
  value: number,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
}

function retryable(error: unknown): boolean {
  if (error instanceof RegistryRequestError) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TypeError ||
    ["AbortError", "TimeoutError", "SocketError"].includes(error.name)
  );
}

async function uploadWithRetry(
  client: RegistryClient,
  artifact: BlobArtifact,
  label: string,
  maxRetries: number,
  logger: RegpushLogger,
): Promise<UploadResult> {
  logger.info(`${label}: checking registry`);
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await client.uploadBlob(
        artifact.digest,
        artifact.filePath,
        artifact.size,
        ({ chunkSize, totalBytes, uploadedBytes }) => {
          if (uploadedBytes === 0) {
            const chunks = Math.ceil(totalBytes / chunkSize);
            logger.info(
              `${label}: uploading ${formatBytes(totalBytes)} in ${chunks} ${chunks === 1 ? "chunk" : "chunks"}`,
            );
            return;
          }
          const percent = Math.floor((uploadedBytes / totalBytes) * 100);
          logger.info(
            `${label}: ${percent}% (${formatBytes(uploadedBytes)} / ${formatBytes(totalBytes)})`,
          );
        },
      );
      logger.info(
        `${label}: ${result === "existing" ? "already exists" : "uploaded"}`,
      );
      return result;
    } catch (error) {
      if (attempt === maxRetries || !retryable(error)) throw error;
      logger.warning(
        `Upload ${artifact.digest} failed; retrying attempt ${attempt + 1} of ${maxRetries}`,
      );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 2_000)),
      );
    }
  }
  throw new Error(`Upload ${artifact.digest} did not complete`);
}

async function uploadArtifacts(
  client: RegistryClient,
  artifacts: readonly BlobArtifact[],
  layerCount: number,
  maxRetries: number,
  logger: RegpushLogger,
): Promise<PromiseSettledResult<UploadResult>[]> {
  const results = new Array<PromiseSettledResult<UploadResult>>(
    artifacts.length,
  );
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(UPLOAD_CONCURRENCY, artifacts.length) },
      async () => {
        while (cursor < artifacts.length) {
          const index = cursor++;
          try {
            results[index] = {
              status: "fulfilled",
              value: await uploadWithRetry(
                client,
                artifacts[index]!,
                artifactLabel(index, layerCount),
                maxRetries,
                logger,
              ),
            };
          } catch (reason) {
            results[index] = { status: "rejected", reason };
          }
        }
      },
    ),
  );
  return results;
}

const defaultLogger: RegpushLogger = {
  error: (message) => console.error(message),
  info: (message) => console.log(message),
  warning: (message) => console.warn(message),
};

export async function runRegpush(
  options: RunRegpushOptions,
): Promise<RegpushResult> {
  validateCredentials(options.username, options.password);
  const image = parseImageReference(options.image);
  const logger = options.logger ?? defaultLogger;
  const maxRetries = options.maxRetries ?? 3;
  const maxTemporaryBytes =
    options.maxTemporaryBytes ?? DEFAULT_MAX_TEMPORARY_BYTES;
  const processTimeoutMs =
    options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  validateBoundedInteger("Maximum retries", maxRetries, 1, 5);
  validateBoundedInteger(
    "Temporary storage limit",
    maxTemporaryBytes,
    1024 * 1024,
    1024 * 1024 * 1024 * 1024,
  );
  validateBoundedInteger(
    "Process timeout",
    processTimeoutMs,
    1_000,
    30 * 60 * 1_000,
  );
  validateBoundedInteger(
    "Request timeout",
    requestTimeoutMs,
    1_000,
    5 * 60 * 1_000,
  );

  const protocol = options.insecureHttp ? "http" : "https";
  if (options.insecureHttp)
    logger.warning(
      "Insecure HTTP is enabled; registry credentials will travel without TLS",
    );
  logger.info(`Image: ${image.image}`);
  logger.info("Checking local Docker image...");

  const docker = new DockerClient({
    dockerPath: options.dockerPath,
    timeoutMs: processTimeoutMs,
  });
  const imageId = await docker.requireLocalImage(image.image);
  const temporaryBase =
    options.temporaryBaseDirectory ??
    (options.cleanup
      ? (process.env.RUNNER_TEMP ?? tmpdir())
      : (process.env.REGPUSH_CACHE_DIR ??
        path.join(tmpdir(), "regpush-cache")));
  const workspace = await ImageWorkspace.create({
    baseDirectory: temporaryBase,
    cleanup: options.cleanup,
    imageId,
  });
  let result: RegpushResult | undefined;
  let failure: unknown;

  try {
    logger.info("Preparing image artifacts...");
    const artifacts = await prepareImageArtifacts({
      docker,
      image: image.image,
      maxTemporaryBytes,
      onProgress: (progress) => {
        if (progress.phase === "cache-hit") {
          logger.info(
            `Cache hit: reusing ${progress.totalLayers} ${progress.totalLayers === 1 ? "layer" : "layers"} (${formatBytes(progress.totalBytes)}); Docker export and compression skipped`,
          );
          return;
        }
        if (progress.phase === "compressing") {
          logger.info(
            `Compressing ${progress.totalLayers} ${progress.totalLayers === 1 ? "layer" : "layers"} (up to 3 concurrent)...`,
          );
          return;
        }
        logger.info(
          `Preparation: compressed layer ${progress.layer}/${progress.totalLayers} (${formatBytes(progress.size)})`,
        );
      },
      workspace,
    });
    const compressedBytes = artifacts.layers.reduce(
      (total, artifact) => total + artifact.size,
      0,
    );
    logger.info(
      `Prepared ${artifacts.layers.length} ${artifacts.layers.length === 1 ? "layer" : "layers"} (${formatBytes(compressedBytes)} compressed)`,
    );
    const client = new RegistryClient({
      baseUrl: `${protocol}://${image.registry}`,
      password: options.password,
      repository: image.repository,
      timeoutMs: requestTimeoutMs,
      username: options.username,
    });

    const allArtifacts = [...artifacts.layers, artifacts.config];
    logger.info(
      `Uploading ${artifacts.layers.length} ${artifacts.layers.length === 1 ? "layer" : "layers"} and configuration (up to ${UPLOAD_CONCURRENCY} concurrent)...`,
    );
    const uploadResults = await uploadArtifacts(
      client,
      allArtifacts,
      artifacts.layers.length,
      maxRetries,
      logger,
    );
    const rejected = uploadResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (rejected) throw rejected.reason;

    const layerResults = uploadResults.slice(
      0,
      artifacts.layers.length,
    ) as PromiseFulfilledResult<UploadResult>[];
    const manifestMediaType = "application/vnd.oci.image.manifest.v1+json";
    const manifest = {
      config: {
        digest: artifacts.config.digest,
        mediaType: "application/vnd.oci.image.config.v1+json",
        size: artifacts.config.size,
      },
      layers: artifacts.layers.map((layer) => ({
        digest: layer.digest,
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: layer.size,
      })),
      mediaType: manifestMediaType,
      schemaVersion: 2,
    };
    logger.info("Uploading manifest...");
    await client.uploadManifest(image.reference, manifest, manifestMediaType);
    logger.info("Manifest uploaded");

    const uploadedLayers = layerResults.filter(
      (result) => result.value === "uploaded",
    ).length;
    result = {
      existingLayers: artifacts.layers.length - uploadedLayers,
      image: image.image,
      totalLayers: artifacts.layers.length,
      uploadedLayers,
    };
  } catch (error) {
    failure = error;
  }

  try {
    logger.info(
      options.cleanup
        ? "Cleaning temporary artifacts..."
        : "Cleanup disabled; retaining completed temporary artifacts...",
    );
    await workspace.dispose();
    logger.info(
      options.cleanup
        ? "Temporary artifacts removed"
        : "Completed temporary artifacts retained",
    );
  } catch (cleanupError) {
    if (failure === undefined) failure = cleanupError;
    else
      logger.error("Upload failed and temporary artifact cleanup also failed");
  }

  if (failure !== undefined) throw failure;
  if (result === undefined)
    throw new Error("regpush finished without a result");
  logger.info(
    `Uploaded layers: ${result.uploadedLayers}/${result.totalLayers}`,
  );
  logger.info(`Success: ${image.image}`);
  return result;
}
