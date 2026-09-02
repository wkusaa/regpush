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
