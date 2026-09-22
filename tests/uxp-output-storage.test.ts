import { describe, expect, it } from "vitest";

import {
  UxpOutputStorage,
  type UxpOutputEntry,
  type UxpOutputFile,
  type UxpOutputFolder,
} from "../src/adapters/uxp-output-storage";
import { UxpBatchRunStore } from "../src/adapters/uxp-batch-run-store";
import type { BatchRunRecord } from "../src/workflow/run-batch";

class FakeFolder implements UxpOutputFolder {
  readonly isFile = false;
  readonly isFolder = true;
  readonly entries = new Map<string, FakeFolder | FakeFile>();
  shortWrites = false;

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
    return this.parent.shortWrites ? Math.max(0, this.bytes.byteLength - 1) : this.bytes.byteLength;
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

  it("classifies native directory access failures as batch-stopping", async () => {
    const { root, storage: output } = storage();
    root.getEntries = async () => { throw new Error("grant expired"); };

    await expect(output.exists("C:/输出/run-001")).rejects.toMatchObject({
      code: "output-directory-read-failed",
      disposition: "batch",
    });
  });

  it("rejects a short output write as a batch-stopping disk failure", async () => {
    const { root, storage: output } = storage();
    await output.ensureDirectory("C:/输出/run-001");
    const runFolder = root.entries.get("run-001") as FakeFolder;
    runFolder.shortWrites = true;

    await expect(output.writeFile("C:/输出/run-001/result.json", Uint8Array.of(1, 2, 3))).rejects.toMatchObject({
      code: "output-file-write-failed",
      disposition: "batch",
    });
  });

  it("classifies a shared output ancestor occupied by a file as batch-stopping", async () => {
    const { root, storage: output } = storage();
    await root.createFile("run-001", { overwrite: false });

    await expect(output.assertWritable("C:/输出/run-001/.staging-1")).rejects.toMatchObject({
      code: "output-parent-path-invalid",
      disposition: "batch",
    });
  });
});

function runRecord(status: BatchRunRecord["status"] = "running"): BatchRunRecord {
  return {
    schemaVersion: 1,
    runId: "run-001",
    pluginVersion: "0.1.0",
    templateId: "template-001",
    templateVersion: "1",
    masterFingerprint: "master-fingerprint",
    status,
    createdAt: "2026-09-22T09:00:00.000Z",
    updatedAt: "2026-09-22T09:00:00.000Z",
    accessGrants: { master: "master", input: "input", output: "output" },
    groups: [{
      groupName: "素材组-1",
      taskFingerprint: "task-fingerprint",
      state: "running",
      attemptCount: 1,
      attemptId: "attempt-001",
    }],
  };
}

describe("UXP batch run store", () => {
  it("atomically creates, replaces, and discovers versioned recovery records", async () => {
    const folder = new FakeFolder("运行记录");
    const store = new UxpBatchRunStore({ folder, binaryFormat: Symbol("binary") });
    const record = runRecord();

    await store.create(record);
    expect([...folder.entries.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
    await expect(store.create(record)).rejects.toThrow("运行编号已存在");
    await expect(store.load(record.runId)).resolves.toEqual(record);
    await expect(store.listRecoverable()).resolves.toEqual({ records: [record], failures: [] });

    record.status = "completed";
    record.groups[0].state = "completed";
    record.updatedAt = "2026-09-22T09:01:00.000Z";
    await store.save(record);
    await expect(store.load(record.runId)).resolves.toEqual(record);
    await expect(store.listRecoverable()).resolves.toEqual({ records: [], failures: [] });
    expect([...folder.entries.keys()].some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed on a corrupted persisted record", async () => {
    const folder = new FakeFolder("运行记录");
    const store = new UxpBatchRunStore({ folder, binaryFormat: Symbol("binary") });
    const record = runRecord();
    await store.create(record);
    const file = [...folder.entries.values()].find((entry) => entry.isFile) as FakeFile;
    await file.write(new TextEncoder().encode("not-json").buffer as ArrayBuffer);
    const valid = runRecord();
    valid.runId = "run-002";
    await store.create(valid);

    await expect(store.load(record.runId)).rejects.toThrow("JSON 损坏");
    await expect(store.listRecoverable()).resolves.toEqual({
      records: [valid],
      failures: [{ source: file.name, message: `运行记录 JSON 损坏：${file.name}` }],
    });
  });

  it("does not promote a short temporary write over the durable record", async () => {
    const folder = new FakeFolder("运行记录");
    const store = new UxpBatchRunStore({ folder, binaryFormat: Symbol("binary") });
    const record = runRecord();
    await store.create(record);
    folder.shortWrites = true;
    const changed = structuredClone(record);
    changed.status = "interrupted";

    await expect(store.save(changed)).rejects.toThrow("写入不完整");
    folder.shortWrites = false;
    await expect(store.load(record.runId)).resolves.toEqual(record);
  });
});
