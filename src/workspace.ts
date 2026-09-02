import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";

export type ImageWorkspaceOptions = {
  baseDirectory: string;
  cleanup: boolean;
  imageId: string;
};

async function removePartialFiles(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    },
  );
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await removePartialFiles(entryPath);
      else if (entry.name.endsWith(".part"))
        await rm(entryPath, { force: true });
    }),
  );
}

export class ImageWorkspace {
  readonly cacheDirectory: string;
  readonly cleanup: boolean;
  readonly extractedDirectory: string;
  readonly root: string;
  readonly tarPath: string;

  private constructor(root: string, cleanup: boolean) {
    this.root = root;
    this.cleanup = cleanup;
    this.tarPath = path.join(root, "image.tar");
    this.extractedDirectory = path.join(root, "image");
    this.cacheDirectory = path.join(root, "cache");
  }

  static async create(options: ImageWorkspaceOptions): Promise<ImageWorkspace> {
    const normalizedId = options.imageId
      .replace(/^sha256:/u, "")
      .replace(/[^a-zA-Z0-9_.-]/gu, "_")
      .slice(0, 96);
    if (!normalizedId) throw new Error("Docker returned an invalid image ID");
    await mkdir(options.baseDirectory, { recursive: true });
    const root = options.cleanup
      ? await mkdtemp(
          path.join(options.baseDirectory, `regpush-${normalizedId}-`),
        )
      : path.join(options.baseDirectory, `regpush-${normalizedId}`);
    await mkdir(path.join(root, "image"), { recursive: true });
    await mkdir(path.join(root, "cache"), { recursive: true });
    return new ImageWorkspace(root, options.cleanup);
  }

  async dispose(): Promise<void> {
    if (this.cleanup) {
      await rm(this.root, { force: true, recursive: true });
      return;
    }
    await removePartialFiles(this.root);
  }
}
