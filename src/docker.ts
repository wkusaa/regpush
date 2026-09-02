import { runCommand } from "./process.ts";

const SENSITIVE_ENVIRONMENT_NAMES = [
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "INPUT_PASSWORD",
  "INPUT_USERNAME",
  "PASSWORD_REGISTRY",
  "REGPUSH_PASSWORD",
  "REGPUSH_USERNAME",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "USERNAME_REGISTRY",
] as const;

function dockerEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of SENSITIVE_ENVIRONMENT_NAMES) delete environment[name];
  return environment;
}

export type DockerClientOptions = {
  dockerPath?: string | undefined;
  timeoutMs: number;
};

export class DockerClient {
  readonly #dockerPath: string;
  readonly #timeoutMs: number;

  constructor(options: DockerClientOptions) {
    this.#dockerPath = options.dockerPath ?? "docker";
    this.#timeoutMs = options.timeoutMs;
  }

  async requireLocalImage(image: string): Promise<string> {
    const result = await runCommand(
      this.#dockerPath,
      ["image", "inspect", "--format={{.Id}}", image],
      {
        env: dockerEnvironment(),
        timeoutMs: this.#timeoutMs,
      },
    ).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          "Docker is required but the docker executable was not found",
        );
      }
      throw error;
    });
    const imageId = result.stdout.trim();
    if (result.exitCode !== 0 || imageId === "") {
      throw new Error(
        `Docker image ${image} was not found locally; build it with docker buildx build --load`,
      );
    }
    if (!/^sha256:[a-f0-9]{64}$/u.test(imageId)) {
      throw new Error("Docker returned a malformed local image ID");
    }
    return imageId;
  }

  async saveImage(image: string, outputPath: string): Promise<void> {
    const result = await runCommand(
      this.#dockerPath,
      ["image", "save", "--output", outputPath, image],
      {
        env: dockerEnvironment(),
        timeoutMs: this.#timeoutMs,
      },
    );
    if (result.exitCode !== 0)
      throw new Error(`Docker failed to save image ${image}`);
  }
}
