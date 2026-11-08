import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

export function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

/** `O_NOFOLLOW` does not exist on Windows. */
export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** Opens `path` without following a symlink and refuses anything that is not a regular file. */
export async function openRegular(path: string, flags: number, mode?: number): Promise<FileHandle> {
  const handle = await open(path, flags | NOFOLLOW, mode);
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`Path ${path} is not a regular file`);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some platforms cannot open or fsync a directory.
  }
}
