import { describe, expect, it } from "vitest";

import {
  UxpOutputStorage,
  type UxpOutputEntry,
  type UxpOutputFile,
  type UxpOutputFolder,
} from "../src/adapters/uxp-output-storage";

class FakeFolder implements UxpOutputFolder {
  readonly isFile = false;
  readonly isFolder = true;
  readonly entries = new Map<string, FakeFolder | FakeFile>();

  constructor(
    public name: string,
    private parent?: FakeFolder,
  ) {}

  async getEntries(): Promise<UxpOutputEntry[]> {
    return [...this.entries.values()];
  }

  async createFile(name: string, options: { overwrite: boolean }): Promise<UxpOutputFile> {
    const existing = this.entries.get(name.toLowerCase());
    if (existing && (!options.overwrite || !existing.isFile)) throw new Error(`EntryExists: ${name}`);
    if (existing) return existing as FakeFile;
    const file = new FakeFile(name, this);
    this.entries.set(name.toLowerCase(), file);
    return file;
  }

  async createFolder(name: string): Promise<UxpOutputFolder> {
    if (this.entries.has(name.toLowerCase())) throw new Error(`EntryExists: ${name}`);
    const folder = new FakeFolder(name, this);
    this.entries.set(name.toLowerCase(), folder);
    return folder;
  }

  async delete(): Promise<number> {
    if (this.entries.size > 0) throw new Error("folder not empty");
    this.parent?.entries.delete(this.name.toLowerCase());
    return 0;
  }

  async moveTo(folder: UxpOutputFolder, options: { overwrite: boolean; newName: string }): Promise<void> {
    const target = folder as FakeFolder;
    const key = options.newName.toLowerCase();
    if (target.entries.has(key) && !options.overwrite) throw new Error("EntryExists");
    this.parent?.entries.delete(this.name.toLowerCase());
    this.name = options.newName;
    this.parent = target;
    target.entries.set(key, this);
  }
}

class FakeFile implements UxpOutputFile {
  readonly isFile = true;
  readonly isFolder = false;
  private bytes = new ArrayBuffer(0);

  constructor(
    public name: string,
    private parent: FakeFolder,
  ) {}

  async read(): Promise<ArrayBuffer> {
    return this.bytes.slice(0);
  }

  async write(data: ArrayBuffer): Promise<number> {
    this.bytes = data.slice(0);
    return this.bytes.byteLength;
  }

  async delete(): Promise<number> {
    this.parent.entries.delete(this.name.toLowerCase());
    return 0;
  }

  async moveTo(folder: UxpOutputFolder, options: { overwrite: boolean; newName: string }): Promise<void> {
    const target = folder as FakeFolder;
    const key = options.newName.toLowerCase();
    if (target.entries.has(key) && !options.overwrite) throw new Error("EntryExists");
    this.parent.entries.delete(this.name.toLowerCase());
    this.name = options.newName;
    this.parent = target;
    target.entries.set(key, this);
  }
}

function storage() {
  const root = new FakeFolder("输出");
  return { root, storage: new UxpOutputStorage({ rootLocation: "C:/输出", root, binaryFormat: Symbol("binary") }) };
}

describe("UXP output storage", () => {
  it("writes, rereads, and promotes a sibling staging directory without replacement", async () => {
    const { root, storage: output } = storage();
    await output.assertWritable("C:/输出/run-001");
    expect(root.entries.size).toBe(0);
    await output.ensureDirectory("C:/输出/run-001");
    await output.createExclusiveDirectory("C:/输出/run-001/.staging-1");
    await output.writeFile("C:/输出/run-001/.staging-1/前片.png", Uint8Array.of(1, 2, 3));

    expect(await output.listFiles("C:/输出/run-001/.staging-1")).toEqual(["前片.png"]);
    expect(await output.readFile("C:/输出/run-001/.staging-1/前片.png")).toEqual(Uint8Array.of(1, 2, 3));
    await output.promoteDirectoryExclusive("C:/输出/run-001/.staging-1", "C:/输出/run-001/款式001");

    expect(await output.exists("C:/输出/run-001/.staging-1")).toBe(false);
    expect(await output.exists("C:/输出/run-001/款式001")).toBe(true);
    expect(await output.readFile("C:/输出/run-001/款式001/前片.png")).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("does not overwrite a case-insensitive existing result and recursively cleans only staging", async () => {
    const { storage: output } = storage();
    await output.ensureDirectory("C:/输出/run-001");
    await output.createExclusiveDirectory("C:/输出/run-001/.staging-1");
    await output.writeFile("C:/输出/run-001/.staging-1/result.json", Uint8Array.of(1));
    await output.createExclusiveDirectory("C:/输出/run-001/款式001");

    await expect(
      output.promoteDirectoryExclusive("C:/输出/run-001/.staging-1", "C:/输出/run-001/款式001"),
    ).rejects.toThrow("已存在");
    expect(await output.exists("C:/输出/run-001/.staging-1/result.json")).toBe(true);
    await output.removeDirectory("C:/输出/run-001/.staging-1");
    expect(await output.exists("C:/输出/run-001/.staging-1")).toBe(false);
    expect(await output.exists("C:/输出/run-001/款式001")).toBe(true);
  });
});
