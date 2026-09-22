import { describe, expect, it } from "vitest";

import { MemoryBatchAdapter } from "../src/adapters/memory-batch-adapter";
import { samplePreflightPayload } from "../src/domain/sample";
import type { InputGroupSnapshot, TemplateConfig } from "../src/domain/types";
import {
  BatchStoppingError,
  GroupOperationError,
  ResourceCleanupError,
} from "../src/workflow/failures";
import {
  confirmManualCleanupResolved,
  recoverBatch,
  retryBatch,
  runBatch,
  type BatchAccessGrants,
  type BatchRecoveryPort,
  type BatchRunRecord,
  type BatchRunRequest,
  type BatchRunStore,
} from "../src/workflow/run-batch";
import type { CancellationToken, ExecutionScope } from "../src/workflow/types";

class MemoryRunStore implements BatchRunStore {
  record?: BatchRunRecord;
  saveCount = 0;
  failSaveAt?: number;

  async create(record: BatchRunRecord): Promise<void> {
    if (this.record) throw new Error("record exists");
    this.record = structuredClone(record);
  }

  async load(runId: string): Promise<BatchRunRecord | undefined> {
    return this.record?.runId === runId
      ? structuredClone(this.record)
      : undefined;
  }

  async save(record: BatchRunRecord): Promise<void> {
    this.saveCount += 1;
    if (this.saveCount === this.failSaveAt) throw new Error("记录磁盘不可写");
    this.record = structuredClone(record);
  }

  async listRecoverable(): Promise<{
    records: BatchRunRecord[];
    failures: Array<{ source: string; message: string }>;
  }> {
    return {
      records:
        this.record && this.record.status !== "completed"
          ? [structuredClone(this.record)]
          : [],
      failures: [],
    };
  }
}

class SelectiveAdapter extends MemoryBatchAdapter {
  constructor(
    masterFingerprint: string,
    private readonly failures: Map<string, Error>,
  ) {
    super(masterFingerprint);
  }

  override async preflightOutput(
    runId: string,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    attemptId: string,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    await super.preflightOutput(
      runId,
      template,
      group,
      pluginVersion,
      attemptId,
      taskFingerprint,
      cancellation,
    );
    const failure = this.failures.get(group.name);
    if (failure) throw failure;
  }
}

class RecoverableCleanupAdapter extends MemoryBatchAdapter {
  override async cleanup(scope: ExecutionScope): Promise<void> {
    await super.cleanup(scope);
    throw new ResourceCleanupError("输出暂存清理失败", false);
  }
}

const accessGrants: BatchAccessGrants = {
  master: "master-token",
  input: "input-token",
  output: "output-token",
};

function groups(count = 3): InputGroupSnapshot[] {
  return Array.from({ length: count }, (_, index) => {
    const group = structuredClone(samplePreflightPayload.groups[0]);
    group.name = `素材组-${index + 1}`;
    return group;
  });
}

function request(currentGroups = groups()): BatchRunRequest {
  return {
    runId: "batch-001",
    pluginVersion: "0.1.0",
    template: structuredClone(samplePreflightPayload.template),
    groups: currentGroups,
    accessGrants: { ...accessGrants },
  };
}

function clock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 8, 22, 9, 0, tick++)).toISOString();
}

describe("serial batch workflow", () => {
  it("continues after a group failure and records every independent attempt", async () => {
    const current = request();
    const store = new MemoryRunStore();
    const adapter = new SelectiveAdapter(
      current.template.masterFingerprint,
      new Map([["素材组-2", new Error("坏素材")]]),
    );

    const outcome = await runBatch(current, { store, adapter, now: clock() });

    expect(outcome.record.status).toBe("completed-with-errors");
    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(outcome.record.groups.map((group) => group.attemptCount)).toEqual([
      1, 1, 1,
    ]);
    expect(adapter.committed.map((output) => output.location)).toEqual([
      "runs/batch-001/素材组-1",
      "runs/batch-001/素材组-3",
    ]);
    expect(adapter.openSessionCount).toBe(0);
    expect((await store.listRecoverable()).records).toHaveLength(1);
  });

  it("stops the queue on a typed directory-level failure", async () => {
    const current = request();
    const store = new MemoryRunStore();
    const adapter = new SelectiveAdapter(
      current.template.masterFingerprint,
      new Map([
        [
          "素材组-2",
          new BatchStoppingError("output-directory-lost", "输出目录授权失效"),
        ],
      ]),
    );

    const outcome = await runBatch(current, { store, adapter, now: clock() });

    expect(outcome.record.status).toBe("interrupted");
    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "failed",
      "interrupted",
    ]);
    expect(outcome.record.groups[1].failure).toMatchObject({
      code: "output-directory-lost",
      disposition: "batch",
    });
    expect(outcome.record.groups[2].interruptionReason).toBe("batch-stopped");
    expect(adapter.committed).toHaveLength(1);
  });

  it("continues for a file-local read failure while the input grant remains valid", async () => {
    const current = request();
    const store = new MemoryRunStore();
    const adapter = new SelectiveAdapter(
      current.template.masterFingerprint,
      new Map([
        [
          "素材组-2",
          new GroupOperationError("input-file-read-failed", "file locked"),
        ],
      ]),
    );

    const outcome = await runBatch(current, {
      store,
      adapter,
      accessValidator: { validate: async () => ({ valid: true }) },
      now: clock(),
    });
    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(adapter.committed).toHaveLength(2);
  });

  it("stops after a read failure when revalidation proves the input grant was lost", async () => {
    const current = request();
    const store = new MemoryRunStore();
    const adapter = new SelectiveAdapter(
      current.template.masterFingerprint,
      new Map([
        [
          "素材组-2",
          new GroupOperationError(
            "input-file-read-failed",
            "drive disconnected",
          ),
        ],
      ]),
    );
    let checks = 0;

    const outcome = await runBatch(current, {
      store,
      adapter,
      accessValidator: {
        validate: async () => {
          checks += 1;
          return checks >= 4
            ? { valid: false as const, invalid: ["input" as const] }
            : { valid: true as const };
        },
      },
      now: clock(),
    });
    expect(outcome.record.status).toBe("access-required");
    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "failed",
      "interrupted",
    ]);
    expect(outcome.record.groups[1].failure).toMatchObject({
      code: "input-access-expired",
      disposition: "batch",
    });
    expect(outcome.record.groups[2].interruptionReason).toBe("access-required");
    expect(adapter.committed).toHaveLength(1);
  });

  it("honors cancellation only at safe boundaries and never starts a later group", async () => {
    const current = request();
    const store = new MemoryRunStore();
    const adapter = new MemoryBatchAdapter(current.template.masterFingerprint);
    const cancellation = { isCancellationRequested: false };

    const outcome = await runBatch(current, {
      store,
      adapter,
      cancellation,
      now: clock(),
      onGroupEvent: (_groupName, event) => {
        if (event.stage === "replace-artwork" && event.state === "completed") {
          cancellation.isCancellationRequested = true;
        }
      },
    });

    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
    expect(
      outcome.record.groups.every(
        (group) => group.interruptionReason === "cancelled",
      ),
    ).toBe(true);
    expect(adapter.committed).toHaveLength(0);
    expect(adapter.openSessionCount).toBe(0);
  });

  it("keeps an atomic commit successful when cancellation arrives immediately afterward", async () => {
    const current = request(groups(2));
    const store = new MemoryRunStore();
    const adapter = new MemoryBatchAdapter(current.template.masterFingerprint);
    const cancellation = { isCancellationRequested: false };

    const outcome = await runBatch(current, {
      store,
      adapter,
      cancellation,
      now: clock(),
      onGroupEvent: (_groupName, event) => {
        if (event.stage === "commit-result" && event.state === "completed") {
          cancellation.isCancellationRequested = true;
        }
      },
    });

    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "interrupted",
    ]);
    expect(adapter.committed).toHaveLength(1);
  });

  it("retries only failed or interrupted groups after rechecking stable content identity", async () => {
    const original = request();
    const store = new MemoryRunStore();
    const firstAdapter = new SelectiveAdapter(
      original.template.masterFingerprint,
      new Map([["素材组-2", new Error("暂时失败")]]),
    );
    await runBatch(original, { store, adapter: firstAdapter, now: clock() });

    const rescanned = structuredClone(original);
    rescanned.template.masterSourceRef = "new-master-grant";
    rescanned.groups.forEach((group, groupIndex) => {
      group.files.forEach((file, fileIndex) => {
        file.sourceRef = `rescan:${groupIndex}:${fileIndex}`;
      });
    });
    rescanned.accessGrants = {
      master: "new-master",
      input: "new-input",
      output: "new-output",
    };
    const retryAdapter = new MemoryBatchAdapter(
      rescanned.template.masterFingerprint,
    );
    const outcome = await retryBatch(rescanned, {
      store,
      adapter: retryAdapter,
      now: clock(),
    });

    expect(outcome.record.status).toBe("completed");
    expect(outcome.record.groups.map((group) => group.attemptCount)).toEqual([
      1, 2, 1,
    ]);
    expect(retryAdapter.committed.map((output) => output.location)).toEqual([
      "runs/batch-001/素材组-2",
    ]);

    const changed = structuredClone(original);
    changed.groups[1].files[0].fingerprint = "changed-content";
    store.record = structuredClone(
      (
        await runBatch(
          { ...changed, runId: "separate-run" },
          {
            store: new MemoryRunStore(),
            adapter: new SelectiveAdapter(
              changed.template.masterFingerprint,
              new Map([["素材组-2", new Error("失败")]]),
            ),
            now: clock(),
          },
        )
      ).record,
    );
    store.record.runId = original.runId;
    const changedAgain = structuredClone(changed);
    changedAgain.groups[1].files[0].fingerprint = "different-again";
    await expect(
      retryBatch(changedAgain, {
        store,
        adapter: new MemoryBatchAdapter(
          changedAgain.template.masterFingerprint,
        ),
        now: clock(),
      }),
    ).rejects.toMatchObject({ code: "retry-fingerprint-changed" });
  });

  it("pauses for expired grants, then accepts replacement grants only after fingerprint checks", async () => {
    const current = request(groups(2));
    const store = new MemoryRunStore();
    const blockedAdapter = new MemoryBatchAdapter(
      current.template.masterFingerprint,
    );
    const blocked = await runBatch(current, {
      store,
      adapter: blockedAdapter,
      accessValidator: {
        validate: async () => ({ valid: false, invalid: ["input"] }),
      },
      now: clock(),
    });
    expect(blocked.record.status).toBe("access-required");
    expect(
      blocked.record.groups.every(
        (group) => group.interruptionReason === "access-required",
      ),
    ).toBe(true);
    expect(blockedAdapter.calls).toHaveLength(0);

    const resumed = structuredClone(current);
    resumed.accessGrants.input = "replacement-input-token";
    resumed.groups.forEach((group, index) => {
      group.files.forEach((file) => {
        file.sourceRef = `replacement:${index}:${file.name}`;
      });
    });
    const retryAdapter = new MemoryBatchAdapter(
      current.template.masterFingerprint,
    );
    const outcome = await retryBatch(resumed, {
      store,
      adapter: retryAdapter,
      accessValidator: { validate: async () => ({ valid: true }) },
      now: clock(),
    });
    expect(outcome.record.status).toBe("completed");
    expect(retryAdapter.committed).toHaveLength(2);
  });

  it("stops before document work when durable state cannot be saved", async () => {
    const current = request(groups(2));
    const store = new MemoryRunStore();
    store.failSaveAt = 1;
    const adapter = new MemoryBatchAdapter(current.template.masterFingerprint);

    const outcome = await runBatch(current, { store, adapter, now: clock() });

    expect(outcome.persistenceError).toBe("记录磁盘不可写");
    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "interrupted",
      "interrupted",
    ]);
    expect(adapter.calls).toHaveLength(0);
  });

  it("requires recovery before retrying raw running or queued crash states", async () => {
    const current = request(groups(2));
    const store = new MemoryRunStore();
    const completed = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    const crashed = structuredClone(completed.record);
    crashed.status = "running";
    crashed.groups[0].state = "running";
    crashed.groups[1].state = "queued";
    await store.save(crashed);

    await expect(
      retryBatch(current, {
        store,
        adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
        now: clock(),
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });
    expect((await store.load(current.runId))?.status).toBe("running");
  });

  it("keeps a host cleanup warning under manual review instead of hiding it as completed", async () => {
    const current = request(groups(1));
    const store = new MemoryRunStore();
    const outcome = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint, {
        failAt: "cleanup",
      }),
      now: clock(),
    });
    expect(outcome.record.status).toBe("interrupted");
    expect(outcome.record.groups[0]).toMatchObject({
      state: "completed",
      cleanupWarning: "模拟失败：cleanup",
    });
    expect((await store.listRecoverable()).records).toHaveLength(1);
    await expect(
      retryBatch(current, {
        store,
        adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
        now: clock(),
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({
          status: "conflict",
          message: "不应对账已登记完成的组",
        }),
        cleanupOwnedTemporary: async () => "cleaned",
      },
      now: clock(),
    });
    expect(recovered.status).toBe("interrupted");
    expect(recovered.groups[0]).toMatchObject({
      state: "review-required",
      cleanupRequiresReview: true,
    });

    const confirmed = await confirmManualCleanupResolved(
      current.runId,
      current.groups[0].name,
      {
        store,
        now: clock(),
      },
    );
    expect(confirmed.status).toBe("completed");
    expect(confirmed.groups[0].cleanupWarning).toBeUndefined();
  });

  it("automatically resolves an output-only cleanup warning after owned disk state is gone", async () => {
    const current = request(groups(1));
    const store = new MemoryRunStore();
    const outcome = await runBatch(current, {
      store,
      adapter: new RecoverableCleanupAdapter(
        current.template.masterFingerprint,
      ),
      now: clock(),
    });
    expect(outcome.record.status).toBe("interrupted");
    expect(outcome.record.groups[0].cleanupRequiresReview).toBe(false);

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({
          status: "conflict",
          message: "不应对账已登记完成的组",
        }),
        cleanupOwnedTemporary: async () => "missing",
      },
      now: clock(),
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.groups[0].cleanupWarning).toBeUndefined();
  });
});

describe("batch crash recovery", () => {
  it("reconciles a committed running group and interrupts work that never started", async () => {
    const current = request(groups(2));
    const store = new MemoryRunStore();
    const completed = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    const crashed = structuredClone(completed.record);
    const committedOutput = crashed.groups[0].output!;
    crashed.status = "running";
    crashed.groups[0].state = "running";
    crashed.groups[0].output = undefined;
    crashed.groups[1].state = "queued";
    await store.save(crashed);
    const cleaned: string[] = [];
    const recoveryPort: BatchRecoveryPort = {
      reconcileCommittedOutput: async ({ groupName }) =>
        groupName === "素材组-1"
          ? { status: "completed", output: committedOutput }
          : { status: "missing" },
      cleanupOwnedTemporary: async ({ groupName }) => {
        cleaned.push(groupName);
        return "cleaned";
      },
    };

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort,
      now: clock(),
    });

    expect(recovered.status).toBe("interrupted");
    expect(recovered.groups[0]).toMatchObject({
      state: "completed",
      output: committedOutput,
    });
    expect(recovered.groups[1]).toMatchObject({
      state: "interrupted",
      interruptionReason: "not-started",
    });
    expect(cleaned).toEqual(["素材组-1", "素材组-2"]);
  });

  it("requires commit reconciliation after access is reselected and blocks premature retry", async () => {
    const current = request(groups(1));
    const store = new MemoryRunStore();
    const completed = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    const crashed = structuredClone(completed.record);
    const committedOutput = crashed.groups[0].output!;
    crashed.status = "running";
    crashed.groups[0].state = "running";
    crashed.groups[0].output = undefined;
    await store.save(crashed);
    const recoveryPort: BatchRecoveryPort = {
      reconcileCommittedOutput: async () => ({
        status: "completed",
        output: committedOutput,
      }),
      cleanupOwnedTemporary: async () => "cleaned",
    };

    const accessRequired = await recoverBatch(current.runId, {
      store,
      recoveryPort,
      accessValidator: {
        validate: async () => ({ valid: false, invalid: ["output"] }),
      },
      now: clock(),
    });
    expect(accessRequired.groups[0]).toMatchObject({
      state: "interrupted",
      interruptionReason: "access-required",
      requiresReconciliation: true,
    });
    const stillRequired = await recoverBatch(current.runId, {
      store,
      recoveryPort,
      accessValidator: {
        validate: async () => ({ valid: false, invalid: ["output"] }),
      },
      now: clock(),
    });
    expect(stillRequired.groups[0].requiresReconciliation).toBe(true);
    await expect(
      retryBatch(current, {
        store,
        adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
        now: clock(),
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort,
      accessGrants: { ...accessGrants, output: "replacement-output" },
      accessValidator: { validate: async () => ({ valid: true }) },
      now: clock(),
    });
    expect(recovered.status).toBe("completed");
    expect(recovered.groups[0].state).toBe("completed");
    expect(recovered.accessGrants.output).toBe("replacement-output");
  });

  it("does not guess when an existing final directory conflicts with the task", async () => {
    const current = request(groups(1));
    const store = new MemoryRunStore();
    const completed = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    const crashed = structuredClone(completed.record);
    const committedOutput = crashed.groups[0].output!;
    crashed.status = "running";
    crashed.groups[0].state = "running";
    await store.save(crashed);

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({
          status: "conflict",
          message: "质量报告指纹不匹配",
        }),
        cleanupOwnedTemporary: async () => "missing",
      },
      now: clock(),
    });

    expect(recovered.status).toBe("interrupted");
    expect(recovered.groups[0]).toMatchObject({
      state: "review-required",
      error: "质量报告指纹不匹配",
    });

    const resolved = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({
          status: "completed",
          output: committedOutput,
        }),
        cleanupOwnedTemporary: async () => "missing",
      },
      now: clock(),
    });
    expect(resolved.status).toBe("completed");
    expect(resolved.groups[0].state).toBe("completed");
  });

  it("keeps unproven temporary state under manual review and refuses to overwrite its attempt identity", async () => {
    const current = request(groups(1));
    const store = new MemoryRunStore();
    const completed = await runBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    const crashed = structuredClone(completed.record);
    crashed.status = "interrupted";
    crashed.groups[0].state = "interrupted";
    crashed.groups[0].interruptionReason = "crash";
    const attemptId = crashed.groups[0].attemptId;
    await store.save(crashed);

    const recovered = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({ status: "missing" }),
        cleanupOwnedTemporary: async () => "preserved",
      },
      now: clock(),
    });
    expect(recovered.groups[0]).toMatchObject({
      state: "review-required",
      attemptId,
      cleanupWarning: "临时状态的归属无法证明，已保留并等待人工检查",
    });
    await expect(
      retryBatch(current, {
        store,
        adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
        now: clock(),
      }),
    ).rejects.toMatchObject({ code: "recovery-required" });
    expect((await store.load(current.runId))?.groups[0].attemptId).toBe(
      attemptId,
    );

    const cleared = await recoverBatch(current.runId, {
      store,
      recoveryPort: {
        reconcileCommittedOutput: async () => ({ status: "missing" }),
        cleanupOwnedTemporary: async () => "missing",
      },
      now: clock(),
    });
    expect(cleared.groups[0]).toMatchObject({
      state: "interrupted",
      cleanupWarning: undefined,
    });
    const retried = await retryBatch(current, {
      store,
      adapter: new MemoryBatchAdapter(current.template.masterFingerprint),
      now: clock(),
    });
    expect(retried.record.status).toBe("completed");
  });
});
