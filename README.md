# regpush

`regpush` pushes an already-built local Docker image to a registry that implements the chunked upload extension used by `cloudflare/serverless-registry`. It saves the image, gzip-compresses its layers, uploads each blob in server-advertised chunks, and publishes an OCI image manifest.

The GitHub Action is tested on `ubuntu-latest` x64. The local CLI requires Node.js 24, Docker, and a Linux or macOS host. Docker must be running, and the requested image must exist in the local image store.

## GitHub Action

Build with `--load` so the following action step can find the image:

```yaml
- name: Build image
  uses: docker/build-push-action@v6
  with:
    context: .
    load: true
    tags: ${{ env.XILA_IMAGE }}

- name: Push image to XCR
  uses: wkusaa/regpush@v1
  with:
    image: ${{ env.XILA_IMAGE }}
    username: ${{ secrets.XCR_USERNAME }}
    password: ${{ secrets.XCR_PASSWORD }}
```

The repository needs two GitHub Actions secrets: `XCR_USERNAME` and `XCR_PASSWORD`. A complete immutable-tag example is:

```yaml
env:
  XILA_IMAGE: xcr.x-tech.my/xila-app:sha-${{ github.sha }}

steps:
  - uses: actions/checkout@v6

  - name: Build image into the local Docker store
    run: docker buildx build --load --tag "$XILA_IMAGE" .

  - name: Push image to XCR
    uses: wkusaa/regpush@v1
    with:
      image: ${{ env.XILA_IMAGE }}
      username: ${{ secrets.XCR_USERNAME }}
      password: ${{ secrets.XCR_PASSWORD }}
```

Prefer immutable tags such as `sha-<commit>` over `latest`. The optional `insecure-http` input defaults to `false`; enable it only for a trusted local test registry. Artifact caching is enabled by default. Set the optional `cleanup` input to `true` for a one-shot push that removes the cache afterward.

## Local CLI

Use the bundled CLI without Bun or a compilation step:

```bash
export REGPUSH_USERNAME='registry-user'
export REGPUSH_PASSWORD='registry-password'
node dist/cli.js xcr.x-tech.my/xila-app:sha-<commit>
```

For a loopback registry, add `--insecure-http`. The CLI retains and reuses validated artifacts for the same local Docker image ID by default. Repeated pushes then skip Docker export, extraction, and gzip compression. Add `--no-cache` for a one-shot push that removes all artifacts afterward. `--cache` and `--no-cleanup` remain accepted compatibility aliases for the default behavior. `REGPUSH_CACHE_DIR` selects the cache directory. The CLI never accepts a password argument.

## Errors and cleanup

`regpush` exits nonzero when Docker cannot find the image, authentication fails, a chunk response has an invalid range, retries are exhausted, a blob is incomplete, or the registry rejects the manifest. Network operations, Docker commands, retries, concurrency, archive entries, and temporary bytes have fixed bounds. Advanced bounds can be configured through the documented `REGPUSH_*` environment variables.

Progress logs cover image preparation, layer compression, registry checks, every acknowledged upload chunk, manifest publication, and cleanup. The output uses durable log lines instead of an animated terminal-only progress bar, so GitHub Actions retains the complete history.

Advanced environment limits are `REGPUSH_MAX_RETRIES` from 1 to 5, `REGPUSH_MAX_TEMP_BYTES` up to 1 TiB, `REGPUSH_PROCESS_TIMEOUT_MS` up to 30 minutes, and `REGPUSH_REQUEST_TIMEOUT_MS` up to 5 minutes. Defaults are 3 retries, 20 GiB of temporary storage, a 10-minute Docker timeout, and a 60-second network timeout.

By default, regpush caches completed compressed layers and configuration by local Docker image ID. Before reuse, it verifies the metadata, file type, size, and SHA-256 digest of every cached artifact. A missing, incomplete, corrupt, or mismatched cache is discarded and rebuilt. Raw Docker exports, extracted layers, and incomplete `.part` files are always removed. Use `--no-cache` locally or `cleanup: true` in the action to remove the completed cache on success or failure.

## Security model

The action masks the username and password before Docker or network subprocess work starts. Credentials stay in action inputs or environment variables and are sent with HTTP Basic authentication. HTTPS is the default. Upload locations must remain on the original registry origin, which prevents credential forwarding to another host. Logs contain HTTP status codes, not Authorization headers or complete authentication-related response bodies.

Do not enable plain HTTP on an untrusted network. GitHub Actions workflows triggered by pull requests use only fixed mock credentials and never receive deployment secrets.

## Releases

Immutable semantic tags such as `v1.0.0` identify releases. The moving `v1` tag advances only after the matching immutable release passes CI and smoke verification. Consumers that need a fixed supply-chain reference can pin the full release commit SHA.

## Cloudflare Worker and R2 limits

This tool works around registry uploads that exceed a Worker's inbound request limit by sending smaller sequential chunks. Cloudflare currently documents Worker request-body limits of 100 MB on Free and Pro, 200 MB on Business, and 500 MB by default on Enterprise. A registry can advertise a smaller chunk size through `oci-chunk-max-length`. See [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

R2 still limits a single upload to 5 GiB and a multipart object to just under 5 TiB, with no more than 10,000 parts. This client implements the registry's chunk protocol, not R2's S3 multipart API, so the registry service remains responsible for mapping chunks to valid R2 operations and cleaning abandoned server-side uploads. See [Cloudflare R2 limits](https://developers.cloudflare.com/r2/platform/limits/) and [R2 multipart upload details](https://developers.cloudflare.com/r2/objects/upload-objects/).

## License and attribution

Licensed under Apache-2.0. The implementation derives from the `push` tool in [`cloudflare/serverless-registry`](https://github.com/cloudflare/serverless-registry); see [NOTICE](NOTICE).
