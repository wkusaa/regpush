// Shared by the CLI, GitHub Action, and direct registry client.
export const DEFAULT_MAX_CHUNK_BYTES = 10 * 1024 * 1024;
export const DEFAULT_UPLOAD_CONCURRENCY = 1;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1_000;

export function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function optionalInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[0-9]+$/u.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed))
    throw new Error(`${name} must be a safe integer`);
  return parsed;
}
