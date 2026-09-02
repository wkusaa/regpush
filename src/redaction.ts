export function redactSecrets(
  message: string,
  secrets: readonly string[],
): string {
  return secrets
    .filter((secret) => secret.length > 0)
    .sort((left, right) => right.length - left.length)
    .reduce((current, secret) => current.replaceAll(secret, "***"), message);
}
