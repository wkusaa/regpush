export type ImageReference = {
  image: string;
  registry: string;
  repository: string;
  reference: string;
};

const REPOSITORY_SEGMENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

function invalid(reason: string): never {
  throw new Error(`Invalid image reference: ${reason}`);
}

export function parseImageReference(input: string): ImageReference {
  const containsUnsafeCharacter = [...input].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return /\s/u.test(character) || codePoint <= 31 || codePoint === 127;
  });
  if (input.length === 0 || input.length > 2048 || containsUnsafeCharacter) {
    invalid("empty, too long, or contains whitespace/control characters");
  }
  if (input.includes("://") || input.includes("?") || input.includes("#")) {
    invalid("schemes, query strings, and fragments are not allowed");
  }

  const slash = input.indexOf("/");
  if (slash <= 0 || slash === input.length - 1) {
    invalid("expected <registry>/<repository>[:tag]");
  }

  const registry = input.slice(0, slash);
  if (registry.includes("@") || registry !== registry.toLowerCase()) {
    invalid("registry must not contain credentials or uppercase characters");
  }

  let registryUrl: URL;
  try {
    registryUrl = new URL(`https://${registry}`);
  } catch {
    invalid("registry host or port is malformed");
  }
  if (
    registryUrl.username !== "" ||
    registryUrl.password !== "" ||
    registryUrl.pathname !== "/" ||
    registryUrl.search !== "" ||
    registryUrl.hash !== ""
  ) {
    invalid("registry host or port is malformed");
  }
  if (!/^[a-z0-9.:[\]-]+$/u.test(registry)) {
    invalid("registry host must use ASCII DNS, IP, or localhost syntax");
  }
  const hostname = registryUrl.hostname;
  const isIpv6 = hostname.startsWith("[") && hostname.endsWith("]");
  if (!isIpv6) {
    const labels = hostname.split(".");
    if (
      labels.some(
        (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
      )
    ) {
      invalid("registry hostname is malformed");
    }
  }
  if (
    hostname !== "localhost" &&
    !hostname.includes(".") &&
    registryUrl.port === "" &&
    !isIpv6
  ) {
    invalid("registry host must contain a dot or port, or be localhost");
  }

  const nameAndReference = input.slice(slash + 1);
  let repository = nameAndReference;
  let reference = "latest";

  const at = nameAndReference.lastIndexOf("@");
  if (at >= 0) {
    repository = nameAndReference.slice(0, at);
    reference = nameAndReference.slice(at + 1);
    if (!DIGEST.test(reference))
      invalid("digest must be a complete sha256 digest");
  } else {
    const lastSlash = nameAndReference.lastIndexOf("/");
    const colon = nameAndReference.lastIndexOf(":");
    if (colon > lastSlash) {
      repository = nameAndReference.slice(0, colon);
      reference = nameAndReference.slice(colon + 1);
      if (!TAG.test(reference)) invalid("tag is malformed");
    }
  }

  const segments = repository.split("/");
  if (segments.some((segment) => !REPOSITORY_SEGMENT.test(segment))) {
    invalid("repository path is malformed");
  }

  return { image: input, registry, repository, reference };
}
