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
  maxRetries: number,
  logger: RegpushLogger,
): Promise<UploadResult> {
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await client.uploadBlob(
        artifact.digest,
        artifact.filePath,
        artifact.size,
      );
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
    const artifacts = await prepareImageArtifacts({
      docker,
      image: image.image,
      maxTemporaryBytes,
      workspace,
    });
    const client = new RegistryClient({
      baseUrl: `${protocol}://${image.registry}`,
      password: options.password,
      repository: image.repository,
      timeoutMs: requestTimeoutMs,
      username: options.username,
    });

    const allArtifacts = [...artifacts.layers, artifacts.config];
    const uploadResults = await uploadArtifacts(
      client,
      allArtifacts,
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
    await client.uploadManifest(image.reference, manifest, manifestMediaType);

    const uploadedLayers = layerResults.filter(
      (result) => result.value === "uploaded",
    ).length;
    result = {
      existingLayers: artifacts.layers.length - uploadedLayers,
      image: image.image,
      totalLayers: artifacts.layers.length,
      uploadedLayers,
    };
    logger.info(
      `Uploaded layers: ${uploadedLayers}/${artifacts.layers.length}`,
    );
    logger.info(`Success: ${image.image}`);
  } catch (error) {
    failure = error;
  }

  try {
    await workspace.dispose();
  } catch (cleanupError) {
    if (failure === undefined) failure = cleanupError;
    else
      logger.error("Upload failed and temporary artifact cleanup also failed");
  }

  if (failure !== undefined) throw failure;
  if (result === undefined)
    throw new Error("regpush finished without a result");
  return result;
}
