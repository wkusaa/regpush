import { createReadStream } from "node:fs";

export type RegistryClientOptions = {
  baseUrl: string;
  maxChunkBytes?: number;
  password: string;
  repository: string;
  timeoutMs: number;
  username: string;
};

export type UploadResult = "existing" | "uploaded";

const DEFAULT_MAX_CHUNK_BYTES = 100 * 1024 * 1024;

export class RegistryRequestError extends Error {
  readonly status: number;

  constructor(method: string, pathname: string, status: number) {
    super(`Registry ${method} ${pathname} returned HTTP ${status}`);
    this.name = "RegistryRequestError";
    this.status = status;
  }
}

function parseRange(value: string | null): number {
  const match = /^(?:bytes=)?0-([0-9]+)$/iu.exec(value?.trim() ?? "");
  if (!match)
    throw new Error("Registry returned a missing or malformed Range header");
  return Number.parseInt(match[1]!, 10);
}

async function discardBody(response: Response): Promise<void> {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

export class RegistryClient {
  readonly #authorization: string;
  readonly #baseUrl: URL;
  readonly #maxChunkBytes: number;
  readonly #repository: string;
  readonly #timeoutMs: number;

  constructor(options: RegistryClientOptions) {
    this.#baseUrl = new URL(options.baseUrl);
    if (
      !["http:", "https:"].includes(this.#baseUrl.protocol) ||
      this.#baseUrl.username ||
      this.#baseUrl.password
    ) {
      throw new Error(
        "Registry base URL must be HTTP(S) and must not contain credentials",
      );
    }
    this.#authorization = `Basic ${Buffer.from(`${options.username}:${options.password}`, "utf8").toString("base64")}`;
    this.#repository = options.repository;
    this.#timeoutMs = options.timeoutMs;
    this.#maxChunkBytes = options.maxChunkBytes ?? DEFAULT_MAX_CHUNK_BYTES;
  }

  async #request(
    url: URL,
    init: RequestInit & { duplex?: "half" },
  ): Promise<Response> {
    if (url.origin !== this.#baseUrl.origin) {
      throw new Error(
        "Registry redirected an upload to a different origin; credentials were not forwarded",
      );
    }
    return fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
  }

  #url(pathname: string): URL {
    return new URL(pathname, this.#baseUrl);
  }

  #authorizedHeaders(additional: HeadersInit = {}): Headers {
    const headers = new Headers(additional);
    headers.set("authorization", this.#authorization);
    return headers;
  }

  #uploadLocation(response: Response, fallbackPath: string): URL {
    const location = response.headers.get("location") ?? fallbackPath;
    const resolved = new URL(location, this.#baseUrl);
    if (resolved.origin !== this.#baseUrl.origin) {
      throw new Error(
        "Registry returned a cross-origin upload location; credentials were not forwarded",
      );
    }
    return resolved;
  }

  async uploadBlob(
    digest: string,
    filePath: string,
    size: number,
  ): Promise<UploadResult> {
    if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
      throw new Error("Blob digest is malformed");
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new Error("Blob size must be a positive safe integer");

    const blobPath = `/v2/${this.#repository}/blobs/${digest}`;
    const existsResponse = await this.#request(this.#url(blobPath), {
      headers: this.#authorizedHeaders(),
      method: "HEAD",
    });
    if (existsResponse.ok) {
      await discardBody(existsResponse);
      return "existing";
    }
    if (existsResponse.status !== 404) {
      const status = existsResponse.status;
      await discardBody(existsResponse);
      throw new RegistryRequestError("HEAD", blobPath, status);
    }
    await discardBody(existsResponse);

    const startPath = `/v2/${this.#repository}/blobs/uploads/`;
    const startResponse = await this.#request(this.#url(startPath), {
      headers: this.#authorizedHeaders(),
      method: "POST",
    });
    if (!startResponse.ok) {
      const status = startResponse.status;
      await discardBody(startResponse);
      throw new RegistryRequestError("POST", startPath, status);
    }

    const uploadId = startResponse.headers.get("docker-upload-uuid");
    if (!uploadId) {
      await discardBody(startResponse);
      throw new Error("Registry did not return Docker-Upload-UUID");
    }
    const advertisedChunkSize =
      startResponse.headers.get("oci-chunk-max-length") ??
      String(DEFAULT_MAX_CHUNK_BYTES);
    if (!/^[1-9][0-9]*$/u.test(advertisedChunkSize)) {
      await discardBody(startResponse);
      throw new Error(
        "Registry returned a malformed oci-chunk-max-length header",
      );
    }
    const chunkSize = Math.min(
      Number(advertisedChunkSize),
      this.#maxChunkBytes,
    );
    if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
      await discardBody(startResponse);
      throw new Error("Registry chunk size is outside supported bounds");
    }
    let location = this.#uploadLocation(
      startResponse,
      `${startPath}${encodeURIComponent(uploadId)}`,
    );
    await discardBody(startResponse);

    let written = 0;
    while (written < size) {
      const chunkLength = Math.min(chunkSize, size - written);
      const end = written + chunkLength - 1;
      const stream = createReadStream(filePath, { end, start: written });
      const patchPath = location.pathname;
      const patchResponse = await this.#request(location, {
        body: stream as unknown as BodyInit,
        duplex: "half",
        headers: this.#authorizedHeaders({
          "content-length": String(chunkLength),
          "content-range": `${written}-${end}`,
          range: `0-${end}`,
        }),
        method: "PATCH",
      });
      if (!patchResponse.ok) {
        const status = patchResponse.status;
        await discardBody(patchResponse);
        throw new RegistryRequestError("PATCH", patchPath, status);
      }
      const acknowledgedEnd = parseRange(patchResponse.headers.get("range"));
      if (acknowledgedEnd !== end) {
        await discardBody(patchResponse);
        throw new Error(
          `Registry acknowledged byte ${acknowledgedEnd}; expected ${end}`,
        );
      }
      location = this.#uploadLocation(patchResponse, location.pathname);
      await discardBody(patchResponse);
      written = end + 1;
    }

    location.searchParams.set("digest", digest);
    const completionPath = location.pathname;
    const completionResponse = await this.#request(location, {
      headers: this.#authorizedHeaders({ range: `0-${written - 1}` }),
      method: "PUT",
    });
    if (!completionResponse.ok) {
      const status = completionResponse.status;
      await discardBody(completionResponse);
      throw new RegistryRequestError("PUT", completionPath, status);
    }
    await discardBody(completionResponse);
    return "uploaded";
  }

  async uploadManifest(
    reference: string,
    manifest: unknown,
    mediaType: string,
  ): Promise<void> {
    const pathname = `/v2/${this.#repository}/manifests/${reference}`;
    const response = await this.#request(this.#url(pathname), {
      body: JSON.stringify(manifest),
      headers: this.#authorizedHeaders({ "content-type": mediaType }),
      method: "PUT",
    });
    if (!response.ok) {
      const status = response.status;
      await discardBody(response);
      throw new RegistryRequestError("PUT", pathname, status);
    }
    await discardBody(response);
  }
}
