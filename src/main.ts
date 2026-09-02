import { optionalInteger, parseBoolean } from "./config.ts";
import { redactSecrets } from "./redaction.ts";
import { runRegpush, type RegpushLogger } from "./regpush.ts";

function workflowEscape(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function workflowCommand(command: string, value: string): void {
  process.stdout.write(`::${command}::${workflowEscape(value)}\n`);
}

async function main(): Promise<void> {
  const image = process.env.INPUT_IMAGE ?? "";
  const username = process.env.INPUT_USERNAME ?? "";
  const password = process.env.INPUT_PASSWORD ?? "";

  if (username) workflowCommand("add-mask", username);
  if (password) workflowCommand("add-mask", password);
  const authorization =
    username || password
      ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
      : "";
  const secrets = [username, password, authorization];
  const logger: RegpushLogger = {
    error: (message) =>
      workflowCommand("error", redactSecrets(message, secrets)),
    info: (message) => console.log(redactSecrets(message, secrets)),
    warning: (message) =>
      workflowCommand("warning", redactSecrets(message, secrets)),
  };

  try {
    await runRegpush({
      cleanup: parseBoolean(process.env["INPUT_CLEANUP"] ?? "true", "cleanup"),
      image,
      insecureHttp: parseBoolean(
        process.env["INPUT_INSECURE-HTTP"] ?? "false",
        "insecure-http",
      ),
      logger,
      maxRetries: optionalInteger(
        process.env.REGPUSH_MAX_RETRIES,
        "REGPUSH_MAX_RETRIES",
      ),
      maxTemporaryBytes: optionalInteger(
        process.env.REGPUSH_MAX_TEMP_BYTES,
        "REGPUSH_MAX_TEMP_BYTES",
      ),
      password,
      processTimeoutMs: optionalInteger(
        process.env.REGPUSH_PROCESS_TIMEOUT_MS,
        "REGPUSH_PROCESS_TIMEOUT_MS",
      ),
      requestTimeoutMs: optionalInteger(
        process.env.REGPUSH_REQUEST_TIMEOUT_MS,
        "REGPUSH_REQUEST_TIMEOUT_MS",
      ),
      username,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "regpush failed with a non-Error value";
    logger.error(message);
    process.exitCode = 1;
  }
}

await main();
