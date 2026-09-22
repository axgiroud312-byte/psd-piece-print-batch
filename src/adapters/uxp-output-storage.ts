import type { OutputStorage } from "./fixed-region-output-port";
import { BatchStoppingError, WorkflowFailure } from "../workflow/failures";

export interface UxpOutputEntry {
  name: string;
  isFile: boolean;
  isFolder: boolean;
  delete(): Promise<number>;
  moveTo(
    folder: UxpOutputFolder,
    options: { overwrite: boolean; newName: string },
  ): Promise<void>;
}

export interface UxpOutputFile extends UxpOutputEntry {
  read(options: { format: unknown }): Promise<ArrayBuffer | string>;
  write(data: ArrayBuffer, options: { format: unknown }): Promise<number>;
}

export interface UxpOutputFolder extends UxpOutputEntry {
  getEntries(): Promise<UxpOutputEntry[]>;
  createFile(
    name: string,
    options: { overwrite: boolean },
  ): Promise<UxpOutputFile>;
  createFolder(name: string): Promise<UxpOutputFolder>;
}

export interface UxpOutputStorageOptions {
  rootLocation: string;
  root: UxpOutputFolder;
  binaryFormat: unknown;
}

function parentLocation(location: string): string {
  const separator = location.lastIndexOf("/");
  return separator < 0 ? "" : location.slice(0, separator);
}

function baseName(location: string): string {
  const separator = location.lastIndexOf("/");
  return separator < 0 ? location : location.slice(separator + 1);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class UxpOutputStorage implements OutputStorage {
  private probeSequence = 0;
  private readonly rootLocation: string;

  constructor(private readonly options: UxpOutputStorageOptions) {
    this.rootLocation = options.rootLocation
      .replace(/\\/g, "/")
      .replace(/\/+$/, "");
  }

  private async operation<T>(
    code: string,
    message: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    try {
      return await callback();
    } catch (error) {
      if (error instanceof WorkflowFailure) throw error;
      const detail = error instanceof Error ? `：${error.message}` : "";
      throw new BatchStoppingError(code, `${message}${detail}`);
    }
  }

  private parts(location: string): string[] {
    const normalized = location.replace(/\\/g, "/").replace(/\/+$/, "");
    if (normalized === this.rootLocation) return [];
    if (!normalized.startsWith(`${this.rootLocation}/`))
      throw new Error(`输出路径超出已授权目录：${location}`);
    return normalized.slice(this.rootLocation.length + 1).split("/");
  }

  private async child(
    folder: UxpOutputFolder,
    name: string,
  ): Promise<UxpOutputEntry | undefined> {
    const normalized = name.toLowerCase();
    return (
      await this.operation(
        "output-directory-read-failed",
        "无法读取输出目录",
        () => folder.getEntries(),
      )
    ).find((entry) => entry.name.toLowerCase() === normalized);
  }

  private async entry(location: string): Promise<UxpOutputEntry | undefined> {
    let current: UxpOutputEntry = this.options.root;
    for (const part of this.parts(location)) {
      if (!current.isFolder) return undefined;
      const next = await this.child(current as UxpOutputFolder, part);
      if (!next) return undefined;
      current = next;
    }
    return current;
  }

  private async folder(location: string): Promise<UxpOutputFolder> {
    const entry = await this.entry(location);
    if (!entry?.isFolder)
      throw new BatchStoppingError(
        "output-directory-missing",
        `输出目录不存在：${location}`,
      );
    return entry as UxpOutputFolder;
  }

  async fileEntry(location: string, create = false): Promise<UxpOutputFile> {
    const existing = await this.entry(location);
    if (existing) {
      if (!existing.isFile)
        throw new Error(`输出文件路径被目录占用：${location}`);
      return existing as UxpOutputFile;
    }
    if (!create) throw new Error(`输出文件不存在：${location}`);
    const parent = await this.folder(parentLocation(location));
    return this.operation(
      "output-file-create-failed",
      `无法创建输出文件 ${location}`,
      () => parent.createFile(baseName(location), { overwrite: false }),
    );
  }

  async exists(location: string): Promise<boolean> {
    return Boolean(await this.entry(location));
  }

  async assertWritable(location: string): Promise<void> {
    const parts = this.parts(location);
    const created: UxpOutputFolder[] = [];
    let writable = this.options.root;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const next = await this.child(writable, part);
      if (next) {
        if (index === parts.length - 1)
          throw new Error(`待创建的输出目录已存在：${location}`);
        if (!next.isFolder) {
          throw new BatchStoppingError(
            "output-parent-path-invalid",
            `输出父路径被文件占用：${location}`,
          );
        }
        writable = next as UxpOutputFolder;
      } else {
        writable = await this.operation(
          "output-directory-create-failed",
          `无法创建输出目录 ${location}`,
          () => writable.createFolder(part),
        );
        created.push(writable);
      }
    }
    let probeName: string;
    do {
      this.probeSequence += 1;
      probeName = `.psd-batch-write-test-${this.probeSequence}`;
    } while (await this.child(writable, probeName));
    let probe: UxpOutputFile | undefined;
    try {
      probe = await this.operation(
        "output-write-probe-failed",
        "输出目录写入探测失败",
        () => writable.createFile(probeName, { overwrite: false }),
      );
      const written = await this.operation(
        "output-write-probe-failed",
        "输出目录写入探测失败",
        () =>
          probe!.write(arrayBuffer(Uint8Array.of(0)), {
            format: this.options.binaryFormat,
          }),
      );
      if (written !== 1)
        throw new BatchStoppingError(
          "output-write-probe-failed",
          "输出目录写入探测不完整",
        );
    } finally {
      try {
        if (probe)
          await this.operation(
            "output-write-probe-cleanup-failed",
            "无法清理输出写入探测文件",
            () => probe!.delete(),
          );
      } finally {
        for (const folder of created.reverse()) {
          await this.operation(
            "output-write-probe-cleanup-failed",
            "无法清理输出写入探测目录",
            () => folder.delete(),
          );
        }
      }
    }
  }

  async ensureDirectory(location: string): Promise<void> {
    let current = this.options.root;
    for (const part of this.parts(location)) {
      const existing = await this.child(current, part);
      if (existing) {
        if (!existing.isFolder) {
          throw new BatchStoppingError(
            "output-parent-path-invalid",
            `输出目录路径被文件占用：${location}`,
          );
        }
        current = existing as UxpOutputFolder;
      } else {
        current = await this.operation(
          "output-directory-create-failed",
          `无法创建输出目录 ${location}`,
          () => current.createFolder(part),
        );
      }
    }
  }

  async createExclusiveDirectory(location: string): Promise<void> {
    const parent = await this.folder(parentLocation(location));
    const name = baseName(location);
    if (await this.child(parent, name))
      throw new Error(`输出目录已存在：${location}`);
    await this.operation(
      "output-directory-create-failed",
      `无法创建输出目录 ${location}`,
      () => parent.createFolder(name),
    );
  }

  async writeFile(location: string, bytes: Uint8Array): Promise<void> {
    const parent = await this.folder(parentLocation(location));
    const name = baseName(location);
    const existing = await this.child(parent, name);
    if (existing && !existing.isFile)
      throw new Error(`输出文件路径被目录占用：${location}`);
    const file = await this.operation(
      "output-file-create-failed",
      `无法创建输出文件 ${location}`,
      () => parent.createFile(name, { overwrite: true }),
    );
    const written = await this.operation(
      "output-file-write-failed",
      `无法写入输出文件 ${location}`,
      () =>
        file.write(arrayBuffer(bytes), { format: this.options.binaryFormat }),
    );
    if (written !== bytes.byteLength) {
      throw new BatchStoppingError(
        "output-file-write-failed",
        `输出文件写入不完整：${location}`,
      );
    }
  }

  async readFile(location: string): Promise<Uint8Array> {
    const file = await this.fileEntry(location);
    const result = await this.operation(
      "output-file-read-failed",
      `无法读取输出文件 ${location}`,
      () => file.read({ format: this.options.binaryFormat }),
    );
    if (!(result instanceof ArrayBuffer))
      throw new Error(`输出文件无法按二进制读取：${location}`);
    return new Uint8Array(result);
  }

  async removeFile(location: string): Promise<void> {
    const entry = await this.entry(location);
    if (!entry) return;
    if (!entry.isFile) throw new Error(`拒绝按文件清理目录：${location}`);
    await this.operation(
      "output-file-delete-failed",
      `无法删除输出文件 ${location}`,
      () => entry.delete(),
    );
  }

  async listFiles(location: string): Promise<string[]> {
    const folder = await this.folder(location);
    return (
      await this.operation(
        "output-directory-read-failed",
        `无法读取输出目录 ${location}`,
        () => folder.getEntries(),
      )
    ).map((entry) => entry.name);
  }

  async promoteDirectoryExclusive(
    temporaryLocation: string,
    finalLocation: string,
  ): Promise<void> {
    if (parentLocation(temporaryLocation) !== parentLocation(finalLocation)) {
      throw new Error("原子提交要求暂存目录与最终目录位于同一父目录");
    }
    const parent = await this.folder(parentLocation(finalLocation));
    if (await this.child(parent, baseName(finalLocation)))
      throw new Error(`输出目录已存在：${finalLocation}`);
    const temporary = await this.entry(temporaryLocation);
    if (!temporary?.isFolder)
      throw new Error(`暂存目录不存在：${temporaryLocation}`);
    await this.operation(
      "output-directory-promote-failed",
      "无法原子提交输出目录",
      () =>
        temporary.moveTo(parent, {
          overwrite: false,
          newName: baseName(finalLocation),
        }),
    );
  }

  private async deleteTree(entry: UxpOutputEntry): Promise<void> {
    if (entry.isFolder) {
      const children = await this.operation(
        "output-directory-read-failed",
        "无法读取待清理输出目录",
        () => (entry as UxpOutputFolder).getEntries(),
      );
      for (const child of children) await this.deleteTree(child);
    }
    await this.operation(
      "output-cleanup-failed",
      `无法清理输出项 ${entry.name}`,
      () => entry.delete(),
    );
  }

  async removeDirectory(location: string): Promise<void> {
    const entry = await this.entry(location);
    if (!entry) return;
    if (!entry.isFolder) throw new Error(`拒绝按目录清理文件：${location}`);
    await this.deleteTree(entry);
  }
}
