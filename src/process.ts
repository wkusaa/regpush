import { spawn } from "node:child_process";

export type CommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

export type RunCommandOptions = {
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
  timeoutMs: number;
};

export async function runCommand(
  executable: string,
  args: readonly string[],
  options: RunCommandOptions,
): Promise<CommandResult> {
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(executable, args, {
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const append = (
      destination: Buffer[],
      chunk: Buffer,
      currentBytes: number,
    ): number => {
      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      if (remaining > 0) destination.push(chunk.subarray(0, remaining));
      return currentBytes + chunk.length;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes = append(stdout, chunk, stdoutBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes = append(stderr, chunk, stderrBytes);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
    }, options.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new Error(
            `${executable} exceeded the ${options.timeoutMs}ms process timeout`,
          ),
        );
        return;
      }
      resolve({
        exitCode: exitCode ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}
