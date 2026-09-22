import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountApp, workflowStages, type OperatorServices } from "../src/app";
import { samplePreflightPayload } from "../src/domain/sample";
import type { InputGroupSnapshot, TemplateConfig } from "../src/domain/types";
import { createTaskFingerprint, createTemplateFingerprint } from "../src/workflow/fingerprint";
import type { BatchGroupRecord, BatchRunRecord } from "../src/workflow/run-batch";
import type { GroupRunResult, StageEvent } from "../src/workflow/types";
import type { PersistedOperatorWorkspace } from "../src/ui/operator-services";

const now = "2026-09-22T09:00:00.000Z";

function groupRecord(
  groupName: string,
  state: BatchGroupRecord["state"],
  attemptCount = 1,
): BatchGroupRecord {
  return {
    groupName,
    taskFingerprint: `task-${groupName}`,
    state,
    attemptCount,
    error: state === "failed" ? "模拟素材失败" : state === "review-required" ? "输出状态需要人工确认" : undefined,
    interruptionReason: state === "interrupted" ? "cancelled" : undefined,
    output: state === "completed" ? { location: `runs/ui/${groupName}`, artifacts: [] } : undefined,
  };
}

function batchRecord(groups: BatchGroupRecord[], status: BatchRunRecord["status"] = "completed-with-errors"): BatchRunRecord {
  return {
    schemaVersion: 1,
    runId: "ui-batch-001",
    pluginVersion: "0.1.0",
    templateId: samplePreflightPayload.template.templateId,
    templateVersion: samplePreflightPayload.template.version,
    masterFingerprint: samplePreflightPayload.template.masterFingerprint,
    status,
    createdAt: now,
    updatedAt: now,
    accessGrants: { master: "persistent-master", input: "persistent-input", output: "persistent-output" },
    groups,
  };
}

function persistedBatch(record: BatchRunRecord): NonNullable<PersistedOperatorWorkspace["latestRun"]> {
  const { accessGrants: _accessGrants, ...persisted } = record;
  return persisted;
}

class FakeOperatorServices implements OperatorServices {
  capability = {
    productionEnabled: true,
    label: "生产能力已验证",
    title: "可以执行真实试套与正式批次",
    advice: "仍需通过模板、素材预检和单组试套门禁。",
  };
  workspace?: PersistedOperatorWorkspace;
  loadFailure?: string;
  recovery = { records: [] as BatchRunRecord[], failures: [] as Array<{ source: string; message: string }> };
  selectedTemplateJson: string | null = JSON.stringify(samplePreflightPayload.template, null, 2);
  selectedGroups: InputGroupSnapshot[] | null = structuredClone(samplePreflightPayload.groups);
  startCalls = 0;
  retryCalls = 0;
  recoverCalls: string[] = [];
  accessCalls: string[] = [];
  cleanupCalls: Array<{ runId: string; groupName: string }> = [];
  startImplementation?: OperatorServices["startBatch"];
  trialImplementation?: OperatorServices["runTrial"];
  retryImplementation?: OperatorServices["retryBatch"];
  recoveryImplementation?: OperatorServices["recoverRun"];
  accessImplementation?: OperatorServices["reselectRunAccess"];
  cleanupImplementation?: OperatorServices["confirmManualCleanup"];
  retryResult = batchRecord([groupRecord("款式001-蓝花", "completed")], "completed");

  async loadWorkspace() {
    return { workspace: this.workspace ? structuredClone(this.workspace) : undefined, failure: this.loadFailure };
  }

  async saveWorkspace(workspace: PersistedOperatorWorkspace) {
    this.workspace = structuredClone(workspace);
  }

  async selectTemplateJson() {
    return this.selectedTemplateJson;
  }

  async selectAndVerifyMaster(template: TemplateConfig) {
    return { sourceRef: "verified-persistent-master", fingerprint: template.masterFingerprint };
  }

  async selectInputGroups() {
    return this.selectedGroups ? structuredClone(this.selectedGroups) : null;
  }

  async runTrial(
    input: { template: TemplateConfig; group: InputGroupSnapshot },
    options: { onEvent(event: StageEvent): void },
  ): Promise<GroupRunResult> {
    if (this.trialImplementation) return this.trialImplementation(input, options);
    const event: StageEvent = { stage: "commit-result", state: "completed", message: "提交完成", at: now };
    options.onEvent(event);
    return {
      runId: "trial-001",
      groupName: input.group.name,
      taskFingerprint: createTaskFingerprint(input.template, input.group, "0.1.0"),
      status: "completed",
      lastStage: "commit-result",
      startedAt: now,
      finishedAt: now,
      output: { location: `trial/${input.group.name}`, artifacts: [] },
      events: [event],
    };
  }

  async startBatch(
    input: Parameters<OperatorServices["startBatch"]>[0],
    options: Parameters<OperatorServices["startBatch"]>[1],
  ): Promise<BatchRunRecord> {
    this.startCalls += 1;
    if (this.startImplementation) return this.startImplementation(input, options);
    options.onGroupEvent(input.groups[0].name, {
      stage: "commit-result",
      state: "completed",
      message: "完成",
      at: now,
    });
    return batchRecord(input.groups.map((group) => groupRecord(group.name, "completed")), "completed");
  }

  async retryBatch(
    runId: Parameters<OperatorServices["retryBatch"]>[0],
    input: Parameters<OperatorServices["retryBatch"]>[1],
    options: Parameters<OperatorServices["retryBatch"]>[2],
  ): Promise<BatchRunRecord> {
    this.retryCalls += 1;
    if (this.retryImplementation) return this.retryImplementation(runId, input, options);
    return structuredClone(this.retryResult);
  }

  async listRecoverableRuns() {
    return structuredClone(this.recovery);
  }


  async recoverRun(runId: string) {
    this.recoverCalls.push(runId);
    if (this.recoveryImplementation) return this.recoveryImplementation(runId);
    const record = this.recovery.records.find((candidate) => candidate.runId === runId);
    return structuredClone(record ?? this.retryResult);
  }

  async reselectRunAccess(runId: string) {
    this.accessCalls.push(runId);
    if (this.accessImplementation) return this.accessImplementation(runId);
    const record = this.recovery.records.find((candidate) => candidate.runId === runId);
    return structuredClone(record ?? this.retryResult);
  }

  async confirmManualCleanup(runId: string, groupName: string) {
    this.cleanupCalls.push({ runId, groupName });
    if (this.cleanupImplementation) return this.cleanupImplementation(runId, groupName);
    return structuredClone(this.retryResult);
  }
}

function click(selector: string): void {
  const element = document.querySelector<HTMLButtonElement>(selector);
  if (!element) throw new Error(`Missing button ${selector}`);
  element.click();
}

async function mount(services = new FakeOperatorServices()) {
  const mounted = mountApp(document.querySelector<HTMLElement>("#app")!, services);
  await mounted.ready;
  return { mounted, services };
}

async function preparePreflight(services: FakeOperatorServices): Promise<void> {
  click('[data-stage="template"]');
  click(".template-import");
  await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".template-editor")?.value).toContain(samplePreflightPayload.template.templateId));
  click(".master-select");
  await vi.waitFor(() => expect(document.body.textContent).toContain("母版内容指纹已核对"));
  click(".template-save");
  await vi.waitFor(() => expect(document.body.textContent).toContain(
    `模板 ${samplePreflightPayload.template.templateId} / ${samplePreflightPayload.template.version} 已保存`,
  ));

  click('[data-stage="input"]');
  click(".input-scan");
  await vi.waitFor(() => expect(document.querySelector(".preflight-summary")?.textContent).toContain("1 组可运行"));

  click('[data-stage="preview"]');
}

async function prepareApprovedTrial(services: FakeOperatorServices): Promise<void> {
  await preparePreflight(services);
  click(".trial-run");
  await vi.waitFor(() => expect(document.querySelector(".trial-result__status")?.textContent).toContain("试套事务已完成"));
  click(".trial-approve");
  await vi.waitFor(() => expect(document.body.textContent).toContain("正式批次已解锁"));
  expect(services.workspace?.trial?.approved).toBe(true);
}

describe("five-stage operator panel", () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main>';
    localStorage.clear();
  });

  it("renders five stages from one workflow state and keeps production fail-closed by default", async () => {
    const mounted = mountApp(document.querySelector<HTMLElement>("#app")!);
    await mounted.ready;
    const buttons = document.querySelectorAll<HTMLButtonElement>("[data-stage]");

    expect(buttons).toHaveLength(5);
    expect([...buttons].map((button) => button.dataset.stage)).toEqual(workflowStages.map((stage) => stage.id));
    expect(buttons[0].textContent).toContain("模板（查看）");
    expect(document.body.textContent).toContain("待 M0 验证");
    expect(document.body.textContent).toContain("真实生产仍保持锁定");
    click('[data-stage="run"]');
    expect(document.querySelector<HTMLButtonElement>(".batch-start")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("真实母版、三组代表素材");
  });

  it("saves a template draft across navigation without persisting its session reference", async () => {
    const { services } = await mount();
    click(".template-import");
    await vi.waitFor(() => expect(document.querySelector<HTMLTextAreaElement>(".template-editor")?.value).toContain("masterSourceRef"));
    click(".template-save");
    await vi.waitFor(() => expect(services.workspace?.draft).toBeDefined());

    expect(services.workspace?.draft?.template).not.toHaveProperty("masterSourceRef");
    expect(JSON.stringify(services.workspace)).not.toContain(samplePreflightPayload.template.masterSourceRef);
    expect(JSON.stringify(services.workspace)).not.toContain("persistent-master");
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-stage="input"]')?.disabled).toBe(false));
    click('[data-stage="input"]');
    expect(document.querySelector(".input-scan")).not.toBeNull();
    click('[data-stage="template"]');
    expect(document.querySelector<HTMLTextAreaElement>(".template-editor")?.value).toContain(samplePreflightPayload.template.templateId);
    expect(document.querySelector<HTMLElement>('[data-stage="template"]')?.dataset.workflowStatus).toBe("completed");
  });

  it("keeps formal run locked until preflight, trial completion, and operator approval", async () => {
    const { services } = await mount();
    click('[data-stage="run"]');
    expect(document.querySelector<HTMLButtonElement>(".batch-start")?.disabled).toBe(true);

    await prepareApprovedTrial(services);
    click('[data-stage="run"]');
    expect(document.querySelector<HTMLButtonElement>(".batch-start")?.disabled).toBe(false);
    expect(document.querySelector<HTMLElement>('[data-stage="preview"]')?.dataset.workflowStatus).toBe("completed");
  });

  it("does not allow a trial with unresolved cleanup to unlock production", async () => {
    const services = new FakeOperatorServices();
    services.trialImplementation = async (input) => ({
      runId: "trial-cleanup-failed",
      groupName: input.group.name,
      taskFingerprint: createTaskFingerprint(input.template, input.group, "0.1.0"),
      status: "completed",
      lastStage: "cleanup",
      startedAt: now,
      finishedAt: now,
      output: { location: "trial/cleanup-failed", artifacts: [] },
      cleanupWarning: "临时文档仍然打开",
      cleanupRequiresReview: true,
      events: [],
    });
    await mount(services);
    await preparePreflight(services);

    click(".trial-run");
    await vi.waitFor(() => expect(document.body.textContent).toContain("试套不能放行"));
    expect(document.querySelector<HTMLButtonElement>(".trial-approve")?.disabled).toBe(true);
    expect(services.workspace?.trial).toBeUndefined();
  });

  it("revokes the prior approval while a replacement trial is running", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    let resolveTrial!: (result: GroupRunResult) => void;
    services.trialImplementation = async (input) => new Promise<GroupRunResult>((resolve) => {
      resolveTrial = resolve;
      expect(input.group.name).toBe("款式001-蓝花");
    });

    click('[data-stage="preview"]');
    click(".trial-run");
    await vi.waitFor(() => expect(services.workspace?.trial).toBeUndefined());
    await vi.waitFor(() => expect(resolveTrial).toBeTypeOf("function"));
    expect(document.querySelector<HTMLButtonElement>('[data-stage="run"]')?.disabled).toBe(true);
    expect(document.querySelector(".batch-start")).toBeNull();

    resolveTrial({
      runId: "replacement-trial",
      groupName: "款式001-蓝花",
      taskFingerprint: createTaskFingerprint(samplePreflightPayload.template, samplePreflightPayload.groups[0], "0.1.0"),
      status: "completed",
      lastStage: "cleanup",
      startedAt: now,
      finishedAt: now,
      output: { location: "trial/replacement", artifacts: [] },
      events: [],
    });
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".trial-approve")?.disabled).toBe(false));
    expect(services.workspace?.trial?.approved).toBe(false);
  });

  it("invalidates an approved trial as soon as template rules change", async () => {
    const { services } = await mount();
    await prepareApprovedTrial(services);
    click('[data-stage="template"]');
    const editor = document.querySelector<HTMLTextAreaElement>(".template-editor")!;
    const changed = JSON.parse(editor.value);
    changed.output.preview.profile.ppi = 96;
    editor.value = JSON.stringify(changed);
    editor.dispatchEvent(new Event("change"));

    expect(document.body.textContent).toContain("内容已修改；请保存草稿并重新选择母版");
    click('[data-stage="run"]');
    expect(document.querySelector<HTMLButtonElement>(".batch-start")?.disabled).toBe(true);
    expect(services.workspace?.trial).toBeUndefined();
  });

  it("updates visible workflow state immediately when an input editor becomes stale", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    click('[data-stage="input"]');
    expect(document.querySelector(".preflight-results")).not.toBeNull();
    const editor = document.querySelector<HTMLTextAreaElement>(".groups-editor")!;

    editor.value = `${editor.value} `;
    editor.dispatchEvent(new Event("input"));

    expect(document.querySelector(".preflight-results")).toBeNull();
    expect(document.querySelector<HTMLElement>('[data-stage="preview"]')?.dataset.workflowStatus).toBe("locked");
    expect(document.querySelector<HTMLElement>('[data-stage="input"]')?.dataset.workflowStatus).toBe("current");
  });

  it("shows live group/stage progress and requests stop through the safe cancellation token", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    let resolveBatch!: (record: BatchRunRecord) => void;
    let capturedCancellation: Parameters<OperatorServices["startBatch"]>[1]["cancellation"] | undefined;
    services.startImplementation = async (input, options) => {
      capturedCancellation = options.cancellation;
      options.onGroupEvent(input.groups[0].name, {
        stage: "replace-artwork",
        state: "started",
        message: "替换中",
        at: now,
      });
      return new Promise<BatchRunRecord>((resolve) => { resolveBatch = resolve; });
    };

    click('[data-stage="run"]');
    click(".batch-start");
    await vi.waitFor(() => expect(document.querySelector(".batch-progress")?.textContent).toContain("替换印花素材"));
    expect(document.querySelector(".batch-progress")?.textContent).toContain("款式001-蓝花");
    click(".batch-stop");
    expect(capturedCancellation?.isCancellationRequested).toBe(true);
    expect(document.body.textContent).toContain("将在安全边界结束");

    resolveBatch(batchRecord([
      groupRecord("款式001-蓝花", "interrupted"),
    ], "interrupted"));
    await vi.waitFor(() => expect(document.querySelector('[data-result-state="interrupted"]')?.textContent).toContain("款式001-蓝花"));
  });

  it("separates result states and blocks retry while a group still needs recovery", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    services.startImplementation = async () => batchRecord([
      groupRecord("完成组", "completed"),
      groupRecord("失败组", "failed"),
      groupRecord("中断组", "interrupted"),
      groupRecord("待确认组", "review-required"),
    ]);
    click('[data-stage="run"]');
    click(".batch-start");
    await vi.waitFor(() => expect(document.querySelector('[data-result-state="failed"]')?.textContent).toContain("失败组"));

    expect(document.querySelector('[data-result-state="completed"]')?.textContent).toContain("完成组");
    expect(document.querySelector('[data-result-state="interrupted"]')?.textContent).toContain("中断组");
    expect(document.querySelector('[data-result-state="review-required"]')?.textContent).toContain("待确认组");
    expect(document.querySelector<HTMLButtonElement>(".batch-retry")?.disabled).toBe(true);
    expect(document.querySelector<HTMLButtonElement>(".batch-recover")?.disabled).toBe(false);
  });

  it("provides the explicit manual cleanup confirmation required by recovery", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    const review = groupRecord("人工清理组", "review-required");
    review.cleanupWarning = "Photoshop 临时文档需要人工关闭";
    review.cleanupRequiresReview = true;
    services.startImplementation = async () => batchRecord([review], "interrupted");
    services.cleanupImplementation = async () => batchRecord([
      groupRecord("人工清理组", "interrupted"),
    ], "interrupted");
    click('[data-stage="run"]');
    click(".batch-start");
    await vi.waitFor(() => expect(document.querySelector(".cleanup-confirm")).not.toBeNull());

    click(".cleanup-confirm");
    await vi.waitFor(() => expect(document.body.textContent).toContain("人工清理确认"));
    expect(services.cleanupCalls).toEqual([{ runId: "ui-batch-001", groupName: "人工清理组" }]);
  });

  it("requires recovery before confirming cleanup for a newly completed group", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    const completed = groupRecord("款式001-蓝花", "completed");
    completed.cleanupWarning = "Photoshop 临时文档需要人工关闭";
    completed.cleanupRequiresReview = true;
    services.startImplementation = async () => batchRecord([completed], "interrupted");
    click('[data-stage="run"]');
    click(".batch-start");
    await vi.waitFor(() => expect(document.querySelector(".batch-recover")).not.toBeNull());

    expect(document.querySelector(".cleanup-confirm")).toBeNull();
  });

  it("retries eligible failed groups and passes a cancellable run request", async () => {
    const services = new FakeOperatorServices();
    await mount(services);
    await prepareApprovedTrial(services);
    services.startImplementation = async () => batchRecord([groupRecord("款式001-蓝花", "failed")]);
    let resolveRetry!: (record: BatchRunRecord) => void;
    let retryCancellation: Parameters<OperatorServices["retryBatch"]>[2]["cancellation"] | undefined;
    services.retryImplementation = async (_runId, input, options) => {
      retryCancellation = options.cancellation;
      options.onGroupEvent(input.groups[0].name, {
        stage: "replace-artwork",
        state: "started",
        message: "重试替换中",
        at: now,
      });
      return new Promise<BatchRunRecord>((resolve) => { resolveRetry = resolve; });
    };
    click('[data-stage="run"]');
    click(".batch-start");
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>(".batch-retry")?.disabled).toBe(false));

    click(".batch-retry");
    await vi.waitFor(() => expect(document.querySelector(".batch-progress")?.textContent).toContain("替换印花素材"));
    click(".batch-stop");
    expect(retryCancellation?.isCancellationRequested).toBe(true);
    resolveRetry(services.retryResult);
    await vi.waitFor(() => expect(document.body.textContent).toContain("重试后批次全部完成"));
    expect(services.retryCalls).toBe(1);
  });

  it("restores saved rules and interrupted runs while requiring master reselection", async () => {
    const services = new FakeOperatorServices();
    const { masterSourceRef: _sessionReference, ...definition } = samplePreflightPayload.template;
    services.workspace = {
      schemaVersion: 1,
      draft: {
        schemaVersion: 1,
        template: definition,
        templateFingerprint: createTemplateFingerprint(samplePreflightPayload.template, "0.1.0"),
        savedAt: now,
      },
      latestRun: persistedBatch(batchRecord([groupRecord("中断组", "interrupted")], "access-required")),
    };
    services.recovery.failures.push({ source: "broken.json", message: "JSON 损坏" });
    await mount(services);

    expect(document.body.textContent).toContain("母版文件必须重新选择");
    click('[data-stage="results"]');
    expect(document.body.textContent).toContain("目录访问已失效");
    expect(document.body.textContent).toContain("broken.json");
    click('[data-stage="run"]');
    expect(document.querySelector<HTMLButtonElement>(".batch-start")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("母版访问需要重新选择");
  });

  it("reconciles raw running and queued crash records before showing recovery results", async () => {
    const services = new FakeOperatorServices();
    const raw = batchRecord([
      groupRecord("提交中组", "running"),
      groupRecord("未开始组", "queued", 0),
    ], "running");
    services.recovery.records.push(raw);
    services.recoveryImplementation = async () => batchRecord([
      { ...groupRecord("提交中组", "interrupted"), interruptionReason: "crash" },
      { ...groupRecord("未开始组", "interrupted", 0), interruptionReason: "not-started" },
    ], "interrupted");

    await mount(services);

    expect(services.recoverCalls).toEqual([raw.runId]);
    expect(document.querySelector('[data-result-state="interrupted"]')?.textContent).toContain("提交中组");
    expect(document.querySelector('[data-result-state="interrupted"]')?.textContent).toContain("未开始组");
    expect(JSON.stringify(services.workspace)).not.toContain("persistent-master");
    expect(services.workspace?.latestRun).not.toHaveProperty("accessGrants");
  });

  it("keeps recovered retry locked until its template and input snapshots are restored", async () => {
    const services = new FakeOperatorServices();
    services.recovery.records.push(batchRecord([groupRecord("待重试组", "failed")], "completed-with-errors"));
    await mount(services);

    expect(document.querySelector<HTMLButtonElement>(".batch-retry")?.disabled).toBe(true);
    expect(document.body.textContent).toContain("恢复并保存此批次使用的模板规则");
  });

  it("lets the operator switch between multiple recoverable runs", async () => {
    const services = new FakeOperatorServices();
    const older = batchRecord([groupRecord("旧批次组", "interrupted")], "interrupted");
    older.runId = "run-older";
    const newer = batchRecord([groupRecord("新批次组", "interrupted")], "interrupted");
    newer.runId = "run-newer";
    services.recovery.records.push(older, newer);
    await mount(services);

    const selector = document.querySelector<HTMLSelectElement>(".recoverable-run-select")!;
    expect(selector.options).toHaveLength(2);
    selector.value = "run-newer";
    selector.dispatchEvent(new Event("change"));
    expect(document.body.textContent).toContain("新批次组");
    expect(document.body.textContent).not.toContain("旧批次组");
  });

  it("offers directory reselection before recovering an access-locked run", async () => {
    const services = new FakeOperatorServices();
    services.workspace = {
      schemaVersion: 1,
      latestRun: persistedBatch(batchRecord([groupRecord("中断组", "interrupted")], "access-required")),
    };
    await mount(services);

    click('[data-stage="results"]');
    click(".access-reselect");
    await vi.waitFor(() => expect(document.body.textContent).toContain("目录访问已恢复"));
    expect(services.accessCalls).toEqual(["ui-batch-001"]);
    expect(services.recoverCalls).toEqual(["ui-batch-001"]);
  });

  it("does not claim success when reselected directories still fail validation", async () => {
    const services = new FakeOperatorServices();
    const locked = batchRecord([groupRecord("中断组", "interrupted")], "access-required");
    services.workspace = { schemaVersion: 1, latestRun: persistedBatch(locked) };
    services.accessImplementation = async () => locked;
    services.recoveryImplementation = async () => locked;
    await mount(services);

    click('[data-stage="results"]');
    click(".access-reselect");
    await vi.waitFor(() => expect(document.body.textContent).toContain("所选目录仍无法满足恢复要求"));
    expect(document.body.textContent).not.toContain("目录访问已恢复，并已完成");
  });

  it("starts through the plugin entrypoint", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    vi.resetModules();
    await import("../src/index");
    await vi.waitFor(() => expect(document.querySelectorAll("[data-stage]")).toHaveLength(5));
  });
});
