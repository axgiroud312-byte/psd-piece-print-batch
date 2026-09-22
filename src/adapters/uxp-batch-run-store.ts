import { fingerprintValue } from "../workflow/fingerprint";
import type { BatchRunRecord, BatchRunStore } from "../workflow/run-batch";
import type {
  UxpOutputEntry,
  UxpOutputFile,
  UxpOutputFolder,
} from "./uxp-output-storage";

export interface UxpBatchRunStoreOptions {
  folder: UxpOutputFolder;
  binaryFormat: unknown;
}

function isRecord(value: unknown): value is BatchRunRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<BatchRunRecord>;
  const statuses = new Set([
    "running",
    "completed",
    "completed-with-errors",
    "interrupted",
    "access-required",
  ]);
  const states = new Set([
    "queued",
    "running",
    "completed",
    "failed",
    "interrupted",
    "review-required",
  ]);
  return (
    record.schemaVersion === 1 &&
    typeof record.runId === "string" &&
    typeof record.pluginVersion === "string" &&
    typeof record.templateId === "string" &&
    typeof record.templateVersion === "string" &&
    typeof record.masterFingerprint === "string" &&
    typeof record.status === "string" &&
    statuses.has(record.status) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string" &&
    Boolean(record.accessGrants) &&
    typeof record.accessGrants?.master === "string" &&
    typeof record.accessGrants?.input === "string" &&
    typeof record.accessGrants?.output === "string" &&
    Array.isArray(record.groups) &&
    record.groups.every(
      (group) =>
        typeof group.groupName === "string" &&
        typeof group.taskFingerprint === "string" &&
        typeof group.state === "string" &&
        states.has(group.state) &&
        Number.isSafeInteger(group.attemptCount) &&
        group.attemptCount >= 0,
    )
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export class UxpBatchRunStore implements BatchRunStore {
  constructor(private readonly options: UxpBatchRunStoreOptions) {}

  private fileName(runId: string): string {
    return `${fingerprintValue(runId)}.json`;
  }

  private async entry(name: string): Promise<UxpOutputEntry | undefined> {
    const normalized = name.toLowerCase();
    return (await this.options.folder.getEntries()).find(
      (entry) => entry.name.toLowerCase() === normalized,
    );
  }

  private async read(file: UxpOutputFile): Promise<BatchRunRecord> {
    const data = await file.read({ format: this.options.binaryFormat });
    if (typeof data === "string")
      throw new Error(`运行记录无法按二进制读取：${file.name}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(data));
    } catch {
      throw new Error(`运行记录 JSON 损坏：${file.name}`);
    }
    if (!isRecord(parsed)) throw new Error(`运行记录结构无效：${file.name}`);
    return parsed;
  }

  private async write(
    file: UxpOutputFile,
    record: BatchRunRecord,
  ): Promise<void> {
    const bytes = new TextEncoder().encode(JSON.stringify(record, null, 2));
    const written = await file.write(arrayBuffer(bytes), {
      format: this.options.binaryFormat,
    });
    if (written !== bytes.byteLength)
      throw new Error(`运行记录写入不完整：${file.name}`);
  }

  async create(record: BatchRunRecord): Promise<void> {
    const name = this.fileName(record.runId);
    if (await this.entry(name))
      throw new Error(`运行编号已存在：${record.runId}`);
    const temporary = await this.options.folder.createFile(`${name}.tmp`, {
      overwrite: true,
    });
    await this.write(temporary, record);
    await temporary.moveTo(this.options.folder, {
      overwrite: false,
      newName: name,
    });
  }

  async load(runId: string): Promise<BatchRunRecord | undefined> {
    const entry = await this.entry(this.fileName(runId));
    if (!entry) return undefined;
    if (!entry.isFile) throw new Error(`运行记录路径被目录占用：${runId}`);
    const record = await this.read(entry as UxpOutputFile);
    if (record.runId !== runId) throw new Error(`运行记录编号不匹配：${runId}`);
    return record;
  }

  async save(record: BatchRunRecord): Promise<void> {
    const name = this.fileName(record.runId);
    const existing = await this.entry(name);
    if (!existing?.isFile) throw new Error(`运行记录不存在：${record.runId}`);
    const temporaryName = `${name}.tmp`;
    const temporary = await this.options.folder.createFile(temporaryName, {
      overwrite: true,
    });
    await this.write(temporary, record);
    await temporary.moveTo(this.options.folder, {
      overwrite: true,
      newName: name,
    });
  }

  async listRecoverable(): Promise<{
    records: BatchRunRecord[];
    failures: Array<{ source: string; message: string }>;
  }> {
    const records: BatchRunRecord[] = [];
    const failures: Array<{ source: string; message: string }> = [];
    for (const entry of await this.options.folder.getEntries()) {
      if (!entry.isFile || !entry.name.toLowerCase().endsWith(".json"))
        continue;
      try {
        const record = await this.read(entry as UxpOutputFile);
        if (record.status !== "completed") records.push(record);
      } catch (error) {
        failures.push({
          source: entry.name,
          message: error instanceof Error ? error.message : "运行记录无法读取",
        });
      }
    }
    records.sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    );
    return { records, failures };
  }
}
