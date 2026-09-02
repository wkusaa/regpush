import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type MockRegistryOptions = {
  chunkSize?: number;
  existingDigests?: Set<string>;
  failManifest?: boolean;
  interruptPatch?: boolean;
  rangeOverride?: string;
  username?: string;
  password?: string;
};

export type MockRegistryState = {
  blobs: Map<string, Buffer>;
  manifests: Map<string, unknown>;
  patches: {
    contentRange: string | undefined;
    length: number;
    range: string | undefined;
  }[];
  requests: { method: string; pathname: string }[];
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export async function startMockRegistry(options: MockRegistryOptions = {}) {
  const username = options.username ?? "test-user";
  const password = options.password ?? "test-password";
  const expectedAuthorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const uploads = new Map<string, Buffer>();
  let uploadNumber = 0;
  const state: MockRegistryState = {
    blobs: new Map(),
    manifests: new Map(),
    patches: [],
    requests: [],
  };

  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? "/", "http://mock.invalid");
      state.requests.push({
        method: request.method ?? "",
        pathname: url.pathname,
      });

      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            errors: [{ code: "UNAUTHORIZED", detail: "redacted test detail" }],
          }),
        );
        return;
      }

      const blobMatch = url.pathname.match(
        /^\/v2\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/u,
      );
      if (request.method === "HEAD" && blobMatch) {
        const digest = blobMatch[2]!;
        response.writeHead(
          options.existingDigests?.has(digest) || state.blobs.has(digest)
            ? 200
            : 404,
        );
        response.end();
        return;
      }

      const uploadStartMatch = url.pathname.match(
        /^\/v2\/(.+)\/blobs\/uploads\/$/u,
      );
      if (request.method === "POST" && uploadStartMatch) {
        const id = `upload-${++uploadNumber}`;
        uploads.set(id, Buffer.alloc(0));
        response.writeHead(202, {
          "docker-upload-uuid": id,
          location: `/v2/${uploadStartMatch[1]!}/blobs/uploads/${id}`,
          "oci-chunk-max-length": String(options.chunkSize ?? 4),
        });
        response.end();
        return;
      }

      const uploadMatch = url.pathname.match(
        /^\/v2\/(.+)\/blobs\/uploads\/(upload-[0-9]+)$/u,
      );
      if (request.method === "PATCH" && uploadMatch) {
        if (options.interruptPatch) {
          request.socket.destroy();
          return;
        }
        const id = uploadMatch[2]!;
        const body = await readBody(request);
        const previous = uploads.get(id);
        if (!previous) {
          response.writeHead(404).end();
          return;
        }
        const combined = Buffer.concat([previous, body]);
        uploads.set(id, combined);
        state.patches.push({
          contentRange: request.headers["content-range"],
          length: body.length,
          range: request.headers.range,
        });
        response.writeHead(202, {
          location: url.pathname,
          range: options.rangeOverride ?? `0-${combined.length - 1}`,
        });
        response.end();
        return;
      }

      if (
        request.method === "PUT" &&
        uploadMatch &&
        url.searchParams.has("digest")
      ) {
        const id = uploadMatch[2]!;
        const digest = url.searchParams.get("digest")!;
        const body = uploads.get(id);
        if (
          !body ||
          `sha256:${createHash("sha256").update(body).digest("hex")}` !== digest
        ) {
          response.writeHead(400).end();
          return;
        }
        state.blobs.set(digest, body);
        response.writeHead(201).end();
        return;
      }

      const manifestMatch = url.pathname.match(
        /^\/v2\/(.+)\/manifests\/(.+)$/u,
      );
      if (request.method === "PUT" && manifestMatch) {
        if (options.failManifest) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              errors: [
                { code: "MANIFEST_INVALID", detail: "test-only detail" },
              ],
            }),
          );
          return;
        }
        state.manifests.set(
          `${manifestMatch[1]!}:${manifestMatch[2]!}`,
          JSON.parse((await readBody(request)).toString("utf8")),
        );
        response.writeHead(201).end();
        return;
      }

      response.writeHead(404).end();
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("mock registry did not bind a TCP port");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    password,
    state,
    username,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
