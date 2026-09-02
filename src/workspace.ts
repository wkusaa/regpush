import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
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
  readonly imageId: string;
  readonly root: string;
  readonly tarPath: string;

  private constructor(root: string, cleanup: boolean, imageId: string) {
    this.root = root;
    this.cleanup = cleanup;
    this.imageId = imageId;
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
    await mkdir(root, { mode: 0o700, recursive: true });
    await chmod(root, 0o700);
    await mkdir(path.join(root, "image"), { mode: 0o700, recursive: true });
    await mkdir(path.join(root, "cache"), { mode: 0o700, recursive: true });
    await Promise.all([
      chmod(path.join(root, "image"), 0o700),
      chmod(path.join(root, "cache"), 0o700),
    ]);
    return new ImageWorkspace(root, options.cleanup, options.imageId);
  }

  async resetForPreparation(): Promise<void> {
    await Promise.all([
      rm(this.tarPath, { force: true }),
      rm(this.extractedDirectory, { force: true, recursive: true }),
      rm(this.cacheDirectory, { force: true, recursive: true }),
    ]);
    await Promise.all([
      mkdir(this.extractedDirectory, { mode: 0o700, recursive: true }),
      mkdir(this.cacheDirectory, { mode: 0o700, recursive: true }),
    ]);
  }

  async removePreparationSources(): Promise<void> {
    await Promise.all([
      rm(this.tarPath, { force: true }),
      rm(this.extractedDirectory, { force: true, recursive: true }),
    ]);
  }

  async dispose(): Promise<void> {
    if (this.cleanup) {
      await rm(this.root, { force: true, recursive: true });
      return;
    }
    await this.removePreparationSources();
    await removePartialFiles(this.root);
  }
}
