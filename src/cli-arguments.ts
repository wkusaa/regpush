export type CliArguments = {
  cleanup: boolean;
  help: boolean;
  image?: string | undefined;
  insecureHttp: boolean;
};

export function parseCliArguments(args: readonly string[]): CliArguments {
  let cleanup = false;
  let help = false;
  let image: string | undefined;
  let insecureHttp = false;
  for (const argument of args) {
    if (argument === "--insecure-http") insecureHttp = true;
    else if (argument === "--cache" || argument === "--no-cleanup")
      cleanup = false;
    else if (argument === "--no-cache") cleanup = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else if (argument.startsWith("-"))
      throw new Error(`Unknown option: ${argument}`);
    else if (image === undefined) image = argument;
    else throw new Error("regpush accepts exactly one image reference");
  }
  return { cleanup, help, image, insecureHttp };
}
