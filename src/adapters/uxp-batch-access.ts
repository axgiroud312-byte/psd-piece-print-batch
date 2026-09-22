import type {
  BatchAccessGrants,
  BatchAccessValidator,
} from "../workflow/run-batch";

export interface UxpPersistentEntry {
  isFile: boolean;
  isFolder: boolean;
}

export interface UxpPersistentFileSystem {
  createPersistentToken(entry: UxpPersistentEntry): Promise<string>;
  getEntryForPersistentToken(token: string): Promise<UxpPersistentEntry>;
  getFileForOpening(): Promise<
    UxpPersistentEntry | UxpPersistentEntry[] | null
  >;
  getFolder(): Promise<UxpPersistentEntry | null>;
}

export class UxpBatchAccess implements BatchAccessValidator {
  constructor(private readonly fileSystem: UxpPersistentFileSystem) {}

  async validate(
    grants: BatchAccessGrants,
  ): Promise<
    { valid: true } | { valid: false; invalid: Array<keyof BatchAccessGrants> }
  > {
    const invalid: Array<keyof BatchAccessGrants> = [];
    for (const key of ["master", "input", "output"] as const) {
      try {
        const entry = await this.fileSystem.getEntryForPersistentToken(
          grants[key],
        );
        if (
          (key === "master" && !entry.isFile) ||
          (key !== "master" && !entry.isFolder)
        )
          invalid.push(key);
      } catch {
        invalid.push(key);
      }
    }
    return invalid.length === 0 ? { valid: true } : { valid: false, invalid };
  }

  async reselect(
    grants: BatchAccessGrants,
    keys: Array<keyof BatchAccessGrants>,
  ): Promise<BatchAccessGrants | undefined> {
    const next = { ...grants };
    for (const key of keys) {
      const selected =
        key === "master"
          ? await this.fileSystem.getFileForOpening()
          : await this.fileSystem.getFolder();
      const entry = Array.isArray(selected) ? selected[0] : selected;
      if (!entry) return undefined;
      if (
        (key === "master" && !entry.isFile) ||
        (key !== "master" && !entry.isFolder)
      ) {
        throw new Error(
          key === "master" ? "母版必须选择文件" : `${key} 必须选择文件夹`,
        );
      }
      next[key] = await this.fileSystem.createPersistentToken(entry);
    }
    return next;
  }
}
