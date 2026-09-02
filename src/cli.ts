#!/usr/bin/env node
import { parseCliArguments } from "./cli-arguments.ts";
import { optionalInteger } from "./config.ts";
import { runRegpush } from "./regpush.ts";

function usage(): string {
  return [
    "Usage: regpush [--insecure-http] [--no-cleanup] <registry>/<repository>[:tag]",
    "",
    "Set REGPUSH_USERNAME and REGPUSH_PASSWORD in the environment.",
    "Passwords are never accepted as command-line arguments.",
  ].join("\n");
}

async function main(): Promise<void> {
  try {
    const args = parseCliArguments(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      return;
    }
    if (!args.image) throw new Error(usage());
    const username =
      process.env.REGPUSH_USERNAME ?? process.env.USERNAME_REGISTRY ?? "";
    const password =
      process.env.REGPUSH_PASSWORD ?? process.env.PASSWORD_REGISTRY ?? "";
    await runRegpush({
      cleanup: args.cleanup,
      image: args.image,
      insecureHttp: args.insecureHttp,
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
    console.error(
      error instanceof Error
        ? error.message
        : "regpush failed with a non-Error value",
    );
    process.exitCode = 1;
  }
}

await main();
