import type { InputGroupSnapshot, TemplateConfig } from "../domain/types";
import { fingerprintValue, createTaskFingerprint } from "./fingerprint";
import { BatchStoppingError, type FailureDetails } from "./failures";
import { runSingleGroup } from "./run-group";
import type {
  CancellationToken,
  CommittedOutput,
  GroupExecutionAdapter,
  GroupRunResult,
  RunStage,
  StageEvent,
} from "./types";

export type BatchGroupState = "queued" | "running" | "completed" | "failed" | "interrupted" | "review-required";
export type BatchStatus = "running" | "completed" | "completed-with-errors" | "interrupted" | "access-required";
export type InterruptionReason = "cancelled" | "crash" | "not-started" | "access-required" | "batch-stopped";

export interface BatchAccessGrants {
  master: string;
  input: string;
  output: string;
}

export interface BatchGroupRecord {
  groupName: string;
  taskFingerprint: string;
  state: BatchGroupState;
  attemptCount: number;
  attemptId?: string;
  lastStage?: RunStage;
  startedAt?: string;
  finishedAt?: string;
  output?: CommittedOutput;
  failure?: FailureDetails;
  error?: string;
  cleanupWarning?: string;
  cleanupRequiresReview?: boolean;
  interruptionReason?: InterruptionReason;
  requiresReconciliation?: boolean;
}

export interface BatchRunRecord {
  schemaVersion: 1;
  runId: string;
  pluginVersion: string;
  templateId: string;
  templateVersion: string;
  masterFingerprint: string;
  status: BatchStatus;
  createdAt: string;
  updatedAt: string;
  accessGrants: BatchAccessGrants;
  groups: BatchGroupRecord[];
}

export interface BatchRunStore {
  create(record: BatchRunRecord): Promise<void>;
  load(runId: string): Promise<BatchRunRecord | undefined>;
  save(record: BatchRunRecord): Promise<void>;
  listRecoverable(): Promise<{
    records: BatchRunRecord[];
    failures: Array<{ source: string; message: string }>;
  }>;
}

export interface BatchAccessValidator {
  validate(grants: BatchAccessGrants): Promise<{ valid: true } | { valid: false; invalid: Array<keyof BatchAccessGrants> }>;
}

export type CommitReconciliation =
  | { status: "completed"; output: CommittedOutput }
  | { status: "missing" }
  | { status: "conflict"; message: string };

export interface BatchRecoveryPort {
  reconcileCommittedOutput(input: {
    runId: string;
    groupName: string;
    taskFingerprint: string;
  }): Promise<CommitReconciliation>;
  cleanupOwnedTemporary(input: {
    runId: string;
    groupName: string;
    taskFingerprint: string;
    attemptId: string;
  }): Promise<"cleaned" | "missing" | "preserved">;
}

export interface BatchRunRequest {
  runId: string;
  pluginVersion: string;
  template: TemplateConfig;
  groups: InputGroupSnapshot[];
  accessGrants: BatchAccessGrants;
}

export interface BatchRunOptions {
  store: BatchRunStore;
  adapter: GroupExecutionAdapter;
  cancellation?: CancellationToken;
  accessValidator?: BatchAccessValidator;
  now?: () => string;
  onGroupEvent?: (groupName: string, event: StageEvent) => void;
}

export interface BatchRunOutcome {
  record: BatchRunRecord;
  persistenceError?: string;
}

export interface BatchRecoveryOptions {
  store: BatchRunStore;
  recoveryPort: BatchRecoveryPort;
  accessValidator?: BatchAccessValidator;
  accessGrants?: BatchAccessGrants;
  now?: () => string;
}

export interface BatchReviewResolutionOptions {
  store: BatchRunStore;
  now?: () => string;
}

function cloneRecord(record: BatchRunRecord): BatchRunRecord {
  return structuredClone(record);
}

function assertUniqueGroups(groups: InputGroupSnapshot[]): void {
  const names = new Set<string>();
  for (const group of groups) {
    const normalized = group.name.toLowerCase();
    if (names.has(normalized)) throw new BatchStoppingError("duplicate-group-name", `素材组名称重复：${group.name}`);
    names.add(normalized);
  }
}

function createRecord(request: BatchRunRequest, now: () => string): BatchRunRecord {
  assertUniqueGroups(request.groups);
  const at = now();
  return {
    schemaVersion: 1,
    runId: request.runId,
    pluginVersion: request.pluginVersion,
    templateId: request.template.templateId,
    templateVersion: request.template.version,
    masterFingerprint: request.template.masterFingerprint,
    status: "running",
    createdAt: at,
    updatedAt: at,
    accessGrants: { ...request.accessGrants },
    groups: request.groups.map((group) => ({
      groupName: group.name,
      taskFingerprint: createTaskFingerprint(request.template, group, request.pluginVersion),
      state: "queued",
      attemptCount: 0,
    })),
  };
}

function markRemainingInterrupted(record: BatchRunRecord, reason: InterruptionReason): void {
  for (const group of record.groups) {
    if (group.state === "queued") {
      group.state = "interrupted";
      group.interruptionReason = reason;
    }
  }
}

function finishStatus(record: BatchRunRecord): BatchStatus {
  if (record.groups.some((group) => group.state === "running" || group.state === "queued")) return "interrupted";
  if (record.groups.some((group) => group.cleanupWarning)) return "interrupted";
  if (record.groups.some((group) => group.state === "review-required")) return "interrupted";
  if (record.groups.some((group) => group.state === "interrupted")) return "interrupted";
  if (record.groups.some((group) => group.state === "failed")) return "completed-with-errors";
  return "completed";
}

async function saveRecord(
  store: BatchRunStore,
  record: BatchRunRecord,
  now: () => string,
): Promise<string | undefined> {
  record.updatedAt = now();
  try {
    await store.save(cloneRecord(record));
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "运行记录保存失败";
  }
}

async function validateAccess(
  validator: BatchAccessValidator | undefined,
  grants: BatchAccessGrants,
): Promise<boolean> {
  if (!validator) return true;
  return (await validator.validate(grants)).valid;
}

async function executeSelected(
  request: BatchRunRequest,
  record: BatchRunRecord,
  selected: Set<string>,
  options: BatchRunOptions,
): Promise<BatchRunOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const cancellation = options.cancellation ?? { isCancellationRequested: false };
  if (!(await validateAccess(options.accessValidator, request.accessGrants))) {
    for (const group of record.groups) {
      if (selected.has(group.groupName) && group.state !== "completed") {
        group.state = "interrupted";
        group.interruptionReason = "access-required";
      }
    }
    record.status = "access-required";
    const persistenceError = await saveRecord(options.store, record, now);
    return { record, persistenceError };
  }

  const groups = new Map(request.groups.map((group) => [group.name, group]));
  for (const current of record.groups) {
    if (!selected.has(current.groupName)) continue;
    if (!(await validateAccess(options.accessValidator, request.accessGrants))) {
      current.state = "interrupted";
      current.interruptionReason = "access-required";
      markRemainingInterrupted(record, "access-required");
      record.status = "access-required";
      const persistenceError = await saveRecord(options.store, record, now);
      return { record, persistenceError };
    }
    if (cancellation.isCancellationRequested) {
      current.state = "interrupted";
      current.interruptionReason = "cancelled";
      markRemainingInterrupted(record, "cancelled");
      break;
    }
    const group = groups.get(current.groupName);
    if (!group) throw new BatchStoppingError("missing-retry-group", `恢复时找不到素材组：${current.groupName}`);
    current.attemptCount += 1;
    current.attemptId = fingerprintValue({
      runId: record.runId,
      groupName: current.groupName,
      attempt: current.attemptCount,
      at: now(),
    });
    current.state = "running";
    current.startedAt = now();
    current.finishedAt = undefined;
    current.failure = undefined;
    current.error = undefined;
    current.cleanupWarning = undefined;
    current.cleanupRequiresReview = undefined;
    current.interruptionReason = undefined;
    current.requiresReconciliation = undefined;
    let persistenceError = await saveRecord(options.store, record, now);
    if (persistenceError) {
      current.state = "interrupted";
      current.interruptionReason = "batch-stopped";
      markRemainingInterrupted(record, "batch-stopped");
      record.status = "interrupted";
      return { record, persistenceError };
    }

    const result = await runSingleGroup(
      {
        runId: request.runId,
        pluginVersion: request.pluginVersion,
        template: request.template,
        group,
        attemptId: current.attemptId,
      },
      options.adapter,
      {
        cancellation,
        now,
        onEvent: (event) => {
          current.lastStage = event.stage;
          options.onGroupEvent?.(current.groupName, event);
        },
      },
    );
    applyGroupResult(current, result);
    let accessLost = false;
    if (
      result.failure?.code === "input-file-read-failed" &&
      !(await validateAccess(options.accessValidator, request.accessGrants))
    ) {
      current.failure = {
        code: "input-access-expired",
        disposition: "batch",
        message: "素材目录授权在批处理期间失效，请重新选择后恢复",
      };
      current.error = current.failure.message;
      markRemainingInterrupted(record, "access-required");
      record.status = "access-required";
      accessLost = true;
    }
    persistenceError = await saveRecord(options.store, record, now);
    if (persistenceError) {
      markRemainingInterrupted(record, "batch-stopped");
      record.status = "interrupted";
      return { record, persistenceError };
    }
    if (accessLost) return { record };
    if (result.status === "cancelled") {
      markRemainingInterrupted(record, "cancelled");
      break;
    }
    if (result.cleanupWarning || result.failure?.disposition === "batch") {
      markRemainingInterrupted(record, "batch-stopped");
      break;
    }
  }
  record.status = finishStatus(record);
  const persistenceError = await saveRecord(options.store, record, now);
  return { record, persistenceError };
}

function applyGroupResult(record: BatchGroupRecord, result: GroupRunResult): void {
  record.lastStage = result.lastStage;
  record.finishedAt = result.finishedAt;
  record.output = result.output;
  record.failure = result.failure;
  record.error = result.error;
  record.cleanupWarning = result.cleanupWarning;
  record.cleanupRequiresReview = result.cleanupRequiresReview;
  if (result.status === "completed") {
    record.state = "completed";
  } else if (result.status === "cancelled") {
    record.state = "interrupted";
    record.interruptionReason = "cancelled";
  } else {
    record.state = "failed";
  }
}

export async function runBatch(request: BatchRunRequest, options: BatchRunOptions): Promise<BatchRunOutcome> {
  const now = options.now ?? (() => new Date().toISOString());
  const record = createRecord(request, now);
  try {
    await options.store.create(cloneRecord(record));
  } catch (error) {
    throw new BatchStoppingError(
      "run-store-create-failed",
      error instanceof Error ? error.message : "无法创建批次运行记录",
    );
  }
  return executeSelected(request, record, new Set(record.groups.map((group) => group.groupName)), options);
}

export async function retryBatch(request: BatchRunRequest, options: BatchRunOptions): Promise<BatchRunOutcome> {
  assertUniqueGroups(request.groups);
  const loaded = await options.store.load(request.runId);
  if (!loaded) throw new BatchStoppingError("run-record-missing", `找不到运行记录：${request.runId}`);
  if (loaded.schemaVersion !== 1) throw new BatchStoppingError("run-schema-unsupported", "运行记录结构版本不受支持");
  const groups = new Map(request.groups.map((group) => [group.name, group]));
  const selected = new Set<string>();
  for (const record of loaded.groups) {
    if (record.cleanupWarning || record.cleanupRequiresReview) {
      throw new BatchStoppingError("recovery-required", `素材组 ${record.groupName} 必须先完成临时资源恢复`);
    }
    if (record.state === "running" || record.state === "queued" || record.state === "review-required") {
      throw new BatchStoppingError("recovery-required", `素材组 ${record.groupName} 必须先完成中断恢复`);
    }
    if (record.state !== "failed" && record.state !== "interrupted") continue;
    if (record.requiresReconciliation) {
      throw new BatchStoppingError("recovery-required", `素材组 ${record.groupName} 必须先完成提交状态对账`);
    }
    const group = groups.get(record.groupName);
    if (!group) throw new BatchStoppingError("missing-retry-group", `重试缺少素材组：${record.groupName}`);
    const currentFingerprint = createTaskFingerprint(request.template, group, request.pluginVersion);
    if (currentFingerprint !== record.taskFingerprint) {
      throw new BatchStoppingError("retry-fingerprint-changed", `素材组 ${record.groupName} 的模板、素材或配置已变化`);
    }
    record.state = "queued";
    selected.add(record.groupName);
  }
  loaded.accessGrants = { ...request.accessGrants };
  loaded.status = "running";
  return executeSelected(request, loaded, selected, options);
}

export async function recoverBatch(runId: string, options: BatchRecoveryOptions): Promise<BatchRunRecord> {
  const now = options.now ?? (() => new Date().toISOString());
  const record = await options.store.load(runId);
  if (!record) throw new BatchStoppingError("run-record-missing", `找不到运行记录：${runId}`);
  if (record.schemaVersion !== 1) throw new BatchStoppingError("run-schema-unsupported", "运行记录结构版本不受支持");

  const grants = options.accessGrants ?? record.accessGrants;
  if (!(await validateAccess(options.accessValidator, grants))) {
    for (const group of record.groups) {
      if (group.state !== "completed" && group.state !== "review-required") {
        group.requiresReconciliation = group.requiresReconciliation || group.state === "running";
        group.state = "interrupted";
        group.interruptionReason = "access-required";
      }
    }
    record.status = "access-required";
    record.accessGrants = { ...grants };
    record.updatedAt = now();
    await options.store.save(cloneRecord(record));
    return record;
  }

  for (const group of record.groups) {
    if (
      group.state === "running" ||
      group.requiresReconciliation ||
      (group.state === "review-required" && !group.cleanupRequiresReview)
    ) {
      const reconciled = await options.recoveryPort.reconcileCommittedOutput({
        runId: record.runId,
        groupName: group.groupName,
        taskFingerprint: group.taskFingerprint,
      });
      if (reconciled.status === "completed") {
        group.state = "completed";
        group.output = reconciled.output;
        group.finishedAt = now();
        group.error = undefined;
        group.failure = undefined;
        group.interruptionReason = undefined;
      } else if (reconciled.status === "conflict") {
        group.state = "review-required";
        group.error = reconciled.message;
      } else {
        group.state = "interrupted";
        group.interruptionReason = "crash";
        group.error = undefined;
      }
      group.requiresReconciliation = undefined;
    } else if (group.state === "queued") {
      group.state = "interrupted";
      group.interruptionReason = "not-started";
    }
    if (group.attemptId) {
      const cleanup = await options.recoveryPort.cleanupOwnedTemporary({
        runId: record.runId,
        groupName: group.groupName,
        taskFingerprint: group.taskFingerprint,
        attemptId: group.attemptId,
      });
      if (cleanup === "preserved") {
        const cleanupWarning = "临时状态的归属无法证明，已保留并等待人工检查";
        group.state = "review-required";
        group.error = group.error ? `${group.error}；${cleanupWarning}` : cleanupWarning;
        group.cleanupWarning = cleanupWarning;
        group.cleanupRequiresReview = false;
      } else if (group.cleanupRequiresReview) {
        group.state = "review-required";
        group.error = group.cleanupWarning ?? "Photoshop 临时文档清理需要人工确认";
      } else {
        group.cleanupWarning = undefined;
        group.cleanupRequiresReview = undefined;
      }
    }
  }
  record.accessGrants = { ...grants };
  record.status = finishStatus(record);
  record.updatedAt = now();
  await options.store.save(cloneRecord(record));
  return record;
}

export async function confirmManualCleanupResolved(
  runId: string,
  groupName: string,
  options: BatchReviewResolutionOptions,
): Promise<BatchRunRecord> {
  const now = options.now ?? (() => new Date().toISOString());
  const record = await options.store.load(runId);
  if (!record) throw new BatchStoppingError("run-record-missing", `找不到运行记录：${runId}`);
  const group = record.groups.find((candidate) => candidate.groupName === groupName);
  if (!group) throw new BatchStoppingError("run-group-missing", `找不到素材组：${groupName}`);
  if (group.state !== "review-required" || !group.cleanupRequiresReview) {
    throw new BatchStoppingError("manual-review-not-required", `素材组 ${groupName} 没有待确认的宿主清理问题`);
  }
  group.cleanupWarning = undefined;
  group.cleanupRequiresReview = undefined;
  group.error = undefined;
  if (group.output) {
    group.state = "completed";
    group.interruptionReason = undefined;
  } else {
    group.state = "interrupted";
    group.interruptionReason = "crash";
  }
  record.status = finishStatus(record);
  record.updatedAt = now();
  await options.store.save(cloneRecord(record));
  return record;
}
