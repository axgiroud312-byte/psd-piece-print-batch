import { parseInputGroups, parseTemplateConfig, preflightGroups, validateTemplate } from "./domain/preflight";
import type { InputGroupSnapshot, PreflightIssue, PreflightReport, TemplateConfig } from "./domain/types";
import { RunCancellation } from "./workflow/cancellation";
import { createTaskFingerprint, createTemplateFingerprint } from "./workflow/fingerprint";
import type { BatchGroupRecord, BatchRunRecord } from "./workflow/run-batch";
import type { GroupRunResult, RunStage, StageEvent } from "./workflow/types";
import {
  createDefaultOperatorServices,
  type OperatorServices,
  type PersistedOperatorWorkspace,
  type TrialReceipt,
} from "./ui/operator-services";

export type StageId = "template" | "input" | "preview" | "run" | "results";

export interface WorkflowStage {
  id: StageId;
  number: string;
  label: string;
  title: string;
  description: string;
}

export const workflowStages: WorkflowStage[] = [
  { id: "template", number: "01", label: "模板", title: "登记生产母版", description: "导入、校验并保存已经认可的母版结构和输出规则。" },
  { id: "input", number: "02", label: "输入", title: "检查素材分组", description: "扫描素材总文件夹，按固定名称规则确认每一组是否可运行。" },
  { id: "preview", number: "03", label: "预览", title: "先试套一组", description: "正式批量前必须完成一组试套并由操作员确认。" },
  { id: "run", number: "04", label: "运行", title: "串行处理批次", description: "逐组创建干净工作副本，并只在安全边界响应停止。" },
  { id: "results", number: "05", label: "结果", title: "复核并处理失败组", description: "分开查看完成、失败、中断和待确认项目，并只重试合格项目。" },
];

const pluginVersion = "0.1.0";

type BusyAction = "loading" | "template" | "input" | "trial" | "batch" | "retry" | "recovery" | "access";
type WorkflowStatus = "locked" | "ready" | "current" | "completed" | "attention";
type NoticeKind = "success" | "warning" | "error" | "info";

function workflowStatusLabel(status: WorkflowStatus): string {
  if (status === "locked") return "锁定";
  if (status === "completed") return "完成";
  if (status === "attention") return "处理";
  if (status === "current") return "当前";
  return "就绪";
}

interface OperatorState {
  viewedStage: StageId;
  busy?: BusyAction;
  templateText: string;
  template?: TemplateConfig;
  templateFingerprint?: string;
  templateSavedAt?: string;
  templateDirty: boolean;
  masterAccessRequired: boolean;
  templateIssues: PreflightIssue[];
  groupsText: string;
  groups: InputGroupSnapshot[];
  report?: PreflightReport;
  trialGroupName?: string;
  trial?: TrialReceipt;
  trialRun?: GroupRunResult;
  trialEvents: StageEvent[];
  batch?: BatchRunRecord;
  recoverableRuns: BatchRunRecord[];
  persistenceFailures: Array<{ source: string; message: string }>;
  currentGroup?: string;
  currentStage?: RunStage;
  stopRequested: boolean;
  cancellation?: RunCancellation;
  notice?: { kind: NoticeKind; message: string };
}

export interface MountedOperatorApp {
  ready: Promise<void>;
  getState(): Readonly<OperatorState>;
}

const stageLabels: Record<RunStage, string> = {
  preflight: "校验素材与输出",
  "copy-master": "创建母版工作副本",
  "resolve-template": "解析模板结构",
  "replace-artwork": "替换印花素材",
  "validate-structure": "复核模板结构",
  "export-output": "导出文件",
  "verify-output": "重读验证输出",
  "commit-result": "提交结果",
  cleanup: "清理临时资源",
};

const groupStateLabels: Record<BatchGroupRecord["state"], string> = {
  queued: "等待",
  running: "处理中",
  completed: "完成",
  failed: "失败",
  interrupted: "中断",
  "review-required": "待确认",
};

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function appendChildren(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

function actionButton(label: string, className: string, disabled = false): HTMLButtonElement {
  const button = createElement("button", className, label);
  button.type = "button";
  button.disabled = disabled;
  return button;
}

function formatTemplate(template: TemplateConfig): string {
  return JSON.stringify(template, null, 2);
}

function hasTemplateErrors(issues: PreflightIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

function validGroups(state: OperatorState): InputGroupSnapshot[] {
  if (!state.report) return [];
  const names = new Set(state.report.groups.filter((group) => group.status === "valid").map((group) => group.groupName));
  return state.groups.filter((group) => names.has(group.name));
}

function trialIsCurrent(state: OperatorState): boolean {
  if (!state.trial?.approved || !state.template || state.templateDirty) return false;
  if (state.trial.templateFingerprint !== state.templateFingerprint) return false;
  const group = state.groups.find((candidate) => candidate.name === state.trial?.groupName);
  if (!group) return false;
  try {
    return createTaskFingerprint(state.template, group, pluginVersion) === state.trial.taskFingerprint;
  } catch {
    return false;
  }
}

function trialRunIsClean(state: OperatorState): boolean {
  return state.trialRun?.status === "completed" &&
    !state.trialRun.cleanupWarning &&
    !state.trialRun.cleanupRequiresReview;
}

function startBlockReason(state: OperatorState, services: OperatorServices): string | undefined {
  if (state.busy) return "请等待当前操作完成。";
  if (!services.capability.productionEnabled) return services.capability.advice;
  if (!state.template || state.templateDirty || !state.templateFingerprint) return "请先保存有效模板草稿。";
  if (state.masterAccessRequired) return "重启后母版访问需要重新选择并校验指纹。";
  if (!state.report || state.report.validGroupCount === 0) return "请先完成素材预检，并至少保留一组可运行素材。";
  if (!trialIsCurrent(state)) return "当前模板、规则和素材组合尚未完成已确认试套。";
  return undefined;
}

function retryBlockReason(state: OperatorState, services: OperatorServices): string | undefined {
  if (state.busy) return "请等待当前操作完成。";
  if (!services.capability.productionEnabled) return services.capability.advice;
  if (!state.template || state.templateDirty) return "请先恢复并保存此批次使用的模板规则。";
  if (state.masterAccessRequired) return "请先重新选择母版 PSD/PSB 并核对内容指纹。";
  if (!state.report) return "请重新选择素材总文件夹并完成预检，系统会核对每组组合指纹。";
  const available = new Set(validGroups(state).map((group) => group.name));
  const missing = state.batch?.groups.find((group) =>
    (group.state === "failed" || group.state === "interrupted") && !available.has(group.groupName)
  );
  if (missing) return `请重新扫描并通过预检：当前缺少 ${missing.groupName} 的有效素材快照。`;
  return undefined;
}

function failureAdvice(group: BatchGroupRecord): string | undefined {
  const code = group.failure?.code;
  if (code === "input-access-expired") return "重新选择素材总文件夹；系统将重新扫描并核对组合指纹。";
  if (code === "retry-fingerprint-changed") return "模板、素材或规则已经变化，请重新预检并完成新试套。";
  if (code === "photoshop-capability-unavailable") return "当前 Photoshop 版本或 M0 能力不匹配，正式生产保持锁定。";
  if (group.cleanupRequiresReview) return "请先确认 Photoshop 中插件创建的临时文档已经关闭。";
  if (group.cleanupWarning) return `临时资源清理未完成：${group.cleanupWarning}。请先执行恢复并核对输出。`;
  if (group.state === "review-required") return "系统无法安全判断提交或临时状态，请保留现有文件并人工复核。";
  return group.error;
}

function workflowStatus(stage: StageId, state: OperatorState, services: OperatorServices): WorkflowStatus {
  if (stage === "template") {
    if (state.templateFingerprint && !state.templateDirty) return "completed";
    return state.viewedStage === stage ? "current" : "ready";
  }
  if (stage === "input") {
    if (!state.templateFingerprint || state.templateDirty) return "locked";
    if (state.report?.invalidGroupCount) return "attention";
    if (state.report?.validGroupCount) return "completed";
    return state.viewedStage === stage ? "current" : "ready";
  }
  if (stage === "preview") {
    if (!state.report?.validGroupCount || state.masterAccessRequired) return "locked";
    if (trialIsCurrent(state)) return "completed";
    if (state.trialRun && state.trialRun.status !== "completed") return "attention";
    return state.viewedStage === stage ? "current" : "ready";
  }
  if (stage === "run") {
    if (state.busy === "batch" || state.busy === "retry") return "current";
    if (state.batch?.status === "completed") return "completed";
    if (state.batch) return "attention";
    return startBlockReason(state, services) ? "locked" : state.viewedStage === stage ? "current" : "ready";
  }
  if (state.batch || state.recoverableRuns.length > 0 || state.persistenceFailures.length > 0) {
    return state.batch?.status === "completed" ? "completed" : "attention";
  }
  return "locked";
}

function renderPreflightReport(container: HTMLElement, report: PreflightReport): void {
  const templateCard = createElement("section", "template-result");
  templateCard.appendChild(createElement(
    "p",
    "template-result__summary",
    `${report.templateSummary.garmentPieceCount} 个裁片 · ${report.templateSummary.artworkEntryCount} 个素材入口 · ${report.templateSummary.instanceCount} 个实例`,
  ));
  for (const mapping of report.templateSummary.mappings) {
    templateCard.appendChild(createElement("p", "template-result__mapping", mapping));
  }
  for (const issue of report.templateIssues) {
    templateCard.appendChild(createElement("p", `group-result__issue group-result__issue--${issue.severity}`, issue.message));
  }
  container.appendChild(templateCard);
  container.appendChild(createElement(
    "p",
    "preflight-summary",
    `${report.groups.length} 组 · ${report.validGroupCount} 组可运行 · ${report.invalidGroupCount} 组需处理`,
  ));
  for (const group of report.groups) {
    const card = createElement("section", `group-result group-result--${group.status}`);
    const header = createElement("div", "group-result__header");
    appendChildren(
      header,
      createElement("strong", "group-result__name", group.groupName),
      createElement("span", "group-result__status", group.status === "valid" ? "可运行" : "已阻止"),
    );
    card.appendChild(header);
    card.appendChild(createElement(
      "p",
      "group-result__assignment",
      group.assignments.length > 0
        ? group.assignments.map((item) => `${item.entryId} / ${item.contentSourceId} ← ${item.fileName}`).join(" / ")
        : "没有可提交的素材映射",
    ));
    for (const issue of group.issues) {
      card.appendChild(createElement("p", `group-result__issue group-result__issue--${issue.severity}`, issue.message));
    }
    container.appendChild(card);
  }
}

function renderIssueList(container: HTMLElement, issues: PreflightIssue[]): void {
  for (const issue of issues) {
    container.appendChild(createElement("p", `group-result__issue group-result__issue--${issue.severity}`, issue.message));
  }
}

function renderResultColumn(
  stateName: BatchGroupRecord["state"],
  groups: BatchGroupRecord[],
  onConfirmCleanup?: (groupName: string) => void,
): HTMLElement {
  const section = createElement("section", `result-column result-column--${stateName}`);
  section.dataset.resultState = stateName;
  const matching = groups.filter((group) => group.state === stateName);
  section.appendChild(createElement("h3", "result-column__title", `${groupStateLabels[stateName]} ${matching.length}`));
  if (matching.length === 0) section.appendChild(createElement("p", "empty-state", "暂无"));
  for (const group of matching) {
    const card = createElement("article", "result-item");
    appendChildren(
      card,
      createElement("strong", "result-item__name", group.groupName),
      createElement("span", "result-item__attempt", `尝试 ${group.attemptCount}`),
    );
    const advice = failureAdvice(group);
    if (advice) card.appendChild(createElement("p", "result-item__advice", advice));
    if (group.output) card.appendChild(createElement("p", "result-item__output", group.output.location));
    if (group.state === "review-required" && group.cleanupRequiresReview && onConfirmCleanup) {
      const confirm = actionButton("我已关闭插件临时文档", "secondary-action cleanup-confirm");
      confirm.dataset.groupName = group.groupName;
      confirm.addEventListener("click", () => { onConfirmCleanup(group.groupName); });
      card.appendChild(confirm);
    }
    section.appendChild(card);
  }
  return section;
}

export function mountApp(
  root: HTMLElement,
  services: OperatorServices = createDefaultOperatorServices(),
): MountedOperatorApp {
  const state: OperatorState = {
    viewedStage: "template",
    busy: "loading",
    templateText: "",
    templateDirty: false,
    masterAccessRequired: false,
    templateIssues: [],
    groupsText: "",
    groups: [],
    trialEvents: [],
    recoverableRuns: [],
    persistenceFailures: [],
    stopRequested: false,
  };

  const workspace = (): PersistedOperatorWorkspace => {
    let draft: PersistedOperatorWorkspace["draft"];
    if (state.template && state.templateFingerprint && state.templateSavedAt) {
      const { masterSourceRef: _sessionReference, ...template } = state.template;
      draft = {
        schemaVersion: 1,
        template: structuredClone(template),
        templateFingerprint: state.templateFingerprint,
        savedAt: state.templateSavedAt,
      };
    }
    return {
      schemaVersion: 1,
      draft,
      trial: state.trial ? { ...state.trial } : undefined,
      latestRun: state.batch ? (() => {
        const { accessGrants: _persistentAccessGrants, ...record } = state.batch;
        return structuredClone(record);
      })() : undefined,
    };
  };

  const persist = async (): Promise<void> => {
    try {
      await services.saveWorkspace(workspace());
    } catch (error) {
      state.notice = { kind: "error", message: `无法保存操作状态：${errorMessage(error)}` };
    }
  };

  const setNotice = (kind: NoticeKind, message: string): void => {
    state.notice = { kind, message };
  };

  const refreshWorkflowIndicators = (): void => {
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-stage]")) {
      const stage = button.dataset.stage as StageId;
      const status = workflowStatus(stage, state, services);
      button.dataset.workflowStatus = status;
      button.classList.remove(
        "stage-nav__item--locked",
        "stage-nav__item--ready",
        "stage-nav__item--current",
        "stage-nav__item--completed",
        "stage-nav__item--attention",
      );
      button.classList.add(`stage-nav__item--${status}`);
      const statusNode = button.querySelector<HTMLElement>(".stage-nav__state");
      if (statusNode) statusNode.textContent = workflowStatusLabel(status);
    }
  };

  const invalidateTrialIfNeeded = (): void => {
    if (!state.trial || !state.template) return;
    const group = state.groups.find((candidate) => candidate.name === state.trial?.groupName);
    if (!group) {
      state.trial = undefined;
      return;
    }
    try {
      if (
        state.trial.templateFingerprint !== state.templateFingerprint ||
        createTaskFingerprint(state.template, group, pluginVersion) !== state.trial.taskFingerprint
      ) state.trial = undefined;
    } catch {
      state.trial = undefined;
    }
  };

  const saveTemplate = async (): Promise<void> => {
    state.busy = "template";
    state.templateIssues = [];
    render();
    try {
      const template = parseTemplateConfig(state.templateText);
      const issues = validateTemplate(template);
      state.templateIssues = issues;
      if (hasTemplateErrors(issues)) throw new Error("模板仍有阻止运行的问题，请按下方提示修正");
      const fingerprint = createTemplateFingerprint(template, pluginVersion);
      if (state.templateFingerprint !== fingerprint) state.trial = undefined;
      state.template = template;
      state.templateFingerprint = fingerprint;
      state.templateSavedAt = new Date().toISOString();
      state.templateDirty = false;
      state.report = undefined;
      setNotice("success", `模板 ${template.templateId} / ${template.version} 已保存`);
      await persist();
    } catch (error) {
      setNotice("error", errorMessage(error));
    } finally {
      state.busy = undefined;
      render();
    }
  };

  const preflightInput = async (): Promise<void> => {
    if (!state.template || state.templateDirty) return;
    state.busy = "input";
    render();
    try {
      const groups = parseInputGroups(state.groupsText);
      const report = preflightGroups({ template: state.template, groups });
      state.groups = groups;
      state.report = report;
      state.trialGroupName = report.groups.find((group) => group.status === "valid")?.groupName;
      invalidateTrialIfNeeded();
      setNotice(
        report.validGroupCount > 0 ? "success" : "error",
        report.validGroupCount > 0
          ? `预检完成：${report.validGroupCount} 组可运行，${report.invalidGroupCount} 组需处理`
          : "没有可运行素材组，请先修正预检错误",
      );
      await persist();
    } catch (error) {
      state.report = undefined;
      setNotice("error", errorMessage(error));
    } finally {
      state.busy = undefined;
      render();
    }
  };

  const runTrial = async (): Promise<void> => {
    if (!state.template || !state.trialGroupName) return;
    if (state.masterAccessRequired) {
      setNotice("warning", "请先选择登记的母版 PSD/PSB 并核对内容指纹");
      render();
      return;
    }
    const group = validGroups(state).find((candidate) => candidate.name === state.trialGroupName);
    if (!group) return;
    state.busy = "trial";
    state.trial = undefined;
    state.trialRun = undefined;
    state.trialEvents = [];
    state.currentGroup = group.name;
    state.currentStage = "preflight";
    render();
    await persist();
    try {
      const result = await services.runTrial(
        { template: state.template, group },
        {
          onEvent(event) {
            state.trialEvents.push(event);
            state.currentStage = event.stage;
            const status = root.querySelector<HTMLElement>(".trial-result__status");
            if (status) status.textContent = `正在执行：${stageLabels[event.stage]}`;
            const events = root.querySelector<HTMLElement>(".trial-result__events");
            if (events) events.appendChild(createElement("p", "trial-result__event", `${stageLabels[event.stage]} / ${event.state}`));
          },
        },
      );
      state.trialRun = result;
      if (result.status === "completed" && !result.cleanupWarning && !result.cleanupRequiresReview) {
        state.trial = {
          templateFingerprint: state.templateFingerprint!,
          taskFingerprint: result.taskFingerprint,
          groupName: group.name,
          completedAt: result.finishedAt,
          approved: false,
        };
        setNotice(
          services.capability.productionEnabled ? "success" : "warning",
          services.capability.productionEnabled
            ? "试套已完成，请检查输出后确认合格"
            : "诊断试套已完成，但不能作为真实生产放行依据",
        );
      } else {
        setNotice("error", result.cleanupWarning
          ? `试套输出已生成，但临时资源清理失败，不能放行：${result.cleanupWarning}`
          : `试套未完成：${result.error ?? result.status}`);
      }
    } catch (error) {
      setNotice("error", `试套失败：${errorMessage(error)}`);
    } finally {
      await persist();
      state.busy = undefined;
      state.currentGroup = undefined;
      state.currentStage = undefined;
      render();
    }
  };

  const approveTrial = async (): Promise<void> => {
    if (!state.trial || !trialRunIsClean(state) || !services.capability.productionEnabled) return;
    state.trial.approved = true;
    setNotice("success", `已确认 ${state.trial.groupName} 试套合格，正式批次已解锁`);
    await persist();
    render();
  };

  const handleProgress = (groupName: string, event: StageEvent): void => {
    state.currentGroup = groupName;
    state.currentStage = event.stage;
    const group = root.querySelector<HTMLElement>(".batch-progress__group");
    const stage = root.querySelector<HTMLElement>(".batch-progress__stage");
    if (group) group.textContent = groupName;
    if (stage) stage.textContent = stageLabels[event.stage];
  };

  const startBatch = async (): Promise<void> => {
    const blocked = startBlockReason(state, services);
    if (blocked || !state.template) {
      if (blocked) setNotice("warning", blocked);
      render();
      return;
    }
    state.busy = "batch";
    state.stopRequested = false;
    state.cancellation = new RunCancellation();
    state.viewedStage = "run";
    render();
    try {
      state.batch = await services.startBatch(
        { template: state.template, groups: validGroups(state) },
        { cancellation: state.cancellation, onGroupEvent: handleProgress },
      );
      state.viewedStage = "results";
      setNotice(
        state.batch.status === "completed" ? "success" : "warning",
        state.batch.status === "completed" ? "批次全部完成" : "批次已结束，请在结果页处理未完成项目",
      );
      await persist();
    } catch (error) {
      setNotice("error", `批次启动失败：${errorMessage(error)}`);
    } finally {
      state.busy = undefined;
      state.currentGroup = undefined;
      state.currentStage = undefined;
      state.cancellation = undefined;
      render();
    }
  };

  const retryFailed = async (): Promise<void> => {
    const blocked = retryBlockReason(state, services);
    if (blocked || !state.template || !state.batch) {
      if (blocked) setNotice("warning", blocked);
      render();
      return;
    }
    state.busy = "retry";
    state.stopRequested = false;
    state.cancellation = new RunCancellation();
    state.viewedStage = "run";
    render();
    try {
      state.batch = await services.retryBatch(
        state.batch.runId,
        { template: state.template, groups: validGroups(state) },
        { cancellation: state.cancellation, onGroupEvent: handleProgress },
      );
      state.recoverableRuns = state.recoverableRuns.map((record) =>
        record.runId === state.batch?.runId ? structuredClone(state.batch) : record
      );
      state.viewedStage = "results";
      setNotice(
        state.batch.status === "completed" ? "success" : "warning",
        state.batch.status === "completed" ? "重试后批次全部完成" : "重试已结束，仍有项目需要处理",
      );
      await persist();
    } catch (error) {
      state.viewedStage = "results";
      setNotice("error", `无法重试：${errorMessage(error)}`);
    } finally {
      state.busy = undefined;
      state.currentGroup = undefined;
      state.currentStage = undefined;
      state.cancellation = undefined;
      render();
    }
  };

  const recoverRun = async (): Promise<void> => {
    if (!state.batch) return;
    state.busy = "recovery";
    render();
    try {
      state.batch = await services.recoverRun(state.batch.runId);
      state.recoverableRuns = state.recoverableRuns.map((record) =>
        record.runId === state.batch?.runId ? structuredClone(state.batch) : record
      );
      setNotice(
        state.batch.status === "access-required" ? "warning" : "success",
        state.batch.status === "access-required"
          ? "恢复需要重新选择母版、素材或输出目录"
          : "已核对提交结果并清理可证明归属的临时资源",
      );
      await persist();
    } catch (error) {
      setNotice("error", `无法恢复批次：${errorMessage(error)}`);
    } finally {
      state.busy = undefined;
      render();
    }
  };

  const reselectRunAccess = async (): Promise<void> => {
    if (!state.batch) return;
    state.busy = "access";
    render();
    try {
      const reselected = await services.reselectRunAccess(state.batch.runId);
      if (!reselected) {
        setNotice("info", "已取消目录重新选择，批次继续保持锁定");
        return;
      }
      state.batch = reselected;
      state.batch = await services.recoverRun(state.batch.runId);
      state.recoverableRuns = state.recoverableRuns.map((record) =>
        record.runId === state.batch?.runId ? structuredClone(state.batch) : record
      );
      setNotice(
        state.batch.status === "access-required" ? "warning" : "success",
        state.batch.status === "access-required"
          ? "所选目录仍无法满足恢复要求，请按提示重新选择正确的母版、素材或输出目录"
          : "目录访问已恢复，并已完成提交状态与临时资源对账",
      );
      await persist();
    } catch (error) {
      setNotice("error", `目录访问恢复失败：${errorMessage(error)}`);
    } finally {
      state.busy = undefined;
      render();
    }
  };

  const confirmManualCleanup = async (groupName: string): Promise<void> => {
    if (!state.batch) return;
    state.busy = "recovery";
    render();
    try {
      state.batch = await services.confirmManualCleanup(state.batch.runId, groupName);
      state.recoverableRuns = state.recoverableRuns.map((record) =>
        record.runId === state.batch?.runId ? structuredClone(state.batch) : record
      );
      setNotice("success", `已记录 ${groupName} 的人工清理确认；系统已重新计算可恢复状态`);
      await persist();
    } catch (error) {
      setNotice("error", `无法确认人工清理：${errorMessage(error)}`);
    } finally {
      state.busy = undefined;
      render();
    }
  };

  const renderStageHeader = (container: HTMLElement, stage: WorkflowStage): void => {
    appendChildren(
      container,
      createElement("p", "stage-detail__eyebrow", `${stage.number} / ${stage.label}`),
      createElement("h2", "stage-detail__title", stage.title),
      createElement("p", "stage-detail__description", stage.description),
    );
    const notice = createElement("div", "stage-detail__notice");
    appendChildren(
      notice,
      createElement("span", "status-dot"),
      createElement(
        "span",
        undefined,
        services.capability.productionEnabled ? "生产能力已验证，仍需通过模板、预检和试套门禁" : "正式生产已锁定：M0 能力尚未验证",
      ),
    );
    container.appendChild(notice);
  };

  const renderTemplateStage = (container: HTMLElement): void => {
    const summary = createElement("section", "operator-card operator-card--summary");
    summary.appendChild(createElement(
      "p",
      "operator-card__eyebrow",
      state.templateFingerprint && !state.templateDirty ? "草稿已保存" : "等待保存",
    ));
    summary.appendChild(createElement(
      "h3",
      "operator-card__title",
      state.template ? `${state.template.templateId} / ${state.template.version}` : "尚未登记模板",
    ));
    summary.appendChild(createElement(
      "p",
      "operator-card__body",
      state.masterAccessRequired
        ? "模板规则已载入，但母版文件访问尚未校验。请选择登记的 PSD/PSB，系统会核对内容指纹。"
        : "保存后才能进入素材预检。修改任何模板或输出规则都会使旧试套失效。",
    ));
    container.appendChild(summary);

    const editorLabel = createElement("label", "field-label", "模板配置 JSON");
    editorLabel.htmlFor = "template-editor";
    const editor = createElement("textarea", "operator-editor template-editor");
    editor.id = "template-editor";
    editor.value = state.templateText;
    editor.placeholder = "选择模板配置 JSON 后在此检查；保存前会执行结构校验。";
    const editorNote = createElement("p", "editor-change-note", state.templateDirty ? "内容已修改，尚未保存。" : "");
    const updateTemplateText = (): void => {
      state.templateText = editor.value;
      state.templateDirty = true;
      state.masterAccessRequired = true;
      state.report = undefined;
      state.trial = undefined;
      setNotice("warning", "模板内容已修改，请重新保存、选择母版、预检并试套");
      editorNote.textContent = "内容已修改；请保存草稿并重新选择母版。";
      save.disabled = !state.templateText.trim();
      selectMaster.disabled = !state.templateText.trim();
      const summaryState = root.querySelector<HTMLElement>(".operator-card__eyebrow");
      if (summaryState) summaryState.textContent = "等待保存";
      refreshWorkflowIndicators();
      void persist();
    };
    editor.addEventListener("input", updateTemplateText);
    editor.addEventListener("change", updateTemplateText);
    appendChildren(container, editorLabel, editor, editorNote);
    const actions = createElement("div", "action-row");
    const select = actionButton("选择模板配置", "secondary-action template-import", Boolean(state.busy));
    select.addEventListener("click", () => {
      void (async () => {
        state.busy = "template";
        render();
        try {
          const json = await services.selectTemplateJson();
          if (!json) return;
          parseTemplateConfig(json);
          state.templateText = json;
          state.templateDirty = true;
          state.masterAccessRequired = true;
          state.report = undefined;
          state.trial = undefined;
          setNotice("info", "模板配置已载入；请保存草稿，并选择登记的母版文件核对指纹");
        } catch (error) {
          setNotice("error", errorMessage(error));
        } finally {
          state.busy = undefined;
          render();
        }
      })();
    });
    const selectMaster = actionButton(
      state.masterAccessRequired ? "选择并校验母版 PSD" : "重新校验母版 PSD",
      "secondary-action master-select",
      Boolean(state.busy) || !state.templateText.trim(),
    );
    selectMaster.addEventListener("click", () => {
      void (async () => {
        state.busy = "template";
        render();
        try {
          const template = parseTemplateConfig(state.templateText);
          const selected = await services.selectAndVerifyMaster(template);
          if (!selected) return;
          template.masterSourceRef = selected.sourceRef;
          template.masterFingerprint = selected.fingerprint;
          state.templateText = formatTemplate(template);
          state.templateDirty = true;
          state.masterAccessRequired = false;
          state.report = undefined;
          state.trial = undefined;
          setNotice("success", "母版内容指纹已核对；请保存草稿后继续");
        } catch (error) {
          state.masterAccessRequired = true;
          setNotice("error", `母版校验失败：${errorMessage(error)}`);
        } finally {
          state.busy = undefined;
          render();
        }
      })();
    });
    const save = actionButton("校验并保存草稿", "primary-action template-save", Boolean(state.busy) || !state.templateText.trim());
    save.addEventListener("click", () => { void saveTemplate(); });
    appendChildren(actions, select, selectMaster, save);
    container.appendChild(actions);
    renderIssueList(container, state.templateIssues);
  };

  const renderInputStage = (container: HTMLElement): void => {
    if (!state.templateFingerprint || state.templateDirty) {
      container.appendChild(createElement("div", "locked-panel", "此阶段已锁定。请先在模板阶段保存无错误的草稿。"));
      return;
    }
    const editorLabel = createElement("label", "field-label", "素材分组清单 JSON");
    editorLabel.htmlFor = "groups-editor";
    const editor = createElement("textarea", "operator-editor groups-editor");
    editor.id = "groups-editor";
    editor.value = state.groupsText;
    editor.placeholder = "选择素材总文件夹后自动生成清单；也可在诊断时粘贴清单 JSON。";
    const editorNote = createElement("p", "editor-change-note", "");
    const updateGroupsText = (): void => {
      state.groupsText = editor.value;
      state.report = undefined;
      state.trial = undefined;
      setNotice("warning", "素材清单已变化，请重新预检");
      editorNote.textContent = "素材清单已变化，请重新预检。";
      preflight.disabled = !state.groupsText.trim();
      root.querySelector(".preflight-results")?.remove();
      refreshWorkflowIndicators();
      void persist();
    };
    editor.addEventListener("input", updateGroupsText);
    editor.addEventListener("change", updateGroupsText);
    appendChildren(container, editorLabel, editor, editorNote);
    const actions = createElement("div", "action-row");
    const scan = actionButton("选择素材总文件夹", "secondary-action input-scan", Boolean(state.busy));
    scan.addEventListener("click", () => {
      void (async () => {
        state.busy = "input";
        render();
        try {
          const groups = await services.selectInputGroups();
          if (!groups) return;
          state.groups = groups;
          state.groupsText = JSON.stringify(groups, null, 2);
          setNotice("info", `已读取 ${groups.length} 个素材组，正在预检`);
          await preflightInput();
        } catch (error) {
          setNotice("error", `无法扫描素材目录：${errorMessage(error)}`);
        } finally {
          state.busy = undefined;
          render();
        }
      })();
    });
    const preflight = actionButton("预检当前清单", "primary-action input-preflight", Boolean(state.busy) || !state.groupsText.trim());
    preflight.addEventListener("click", () => { void preflightInput(); });
    appendChildren(actions, scan, preflight);
    container.appendChild(actions);
    if (state.report) {
      const results = createElement("div", "preflight-results");
      renderPreflightReport(results, state.report);
      container.appendChild(results);
    }
  };

  const renderPreviewStage = (container: HTMLElement): void => {
    const groups = validGroups(state);
    if (groups.length === 0) {
      container.appendChild(createElement("div", "locked-panel", "此阶段已锁定。请先完成素材预检并保留至少一组可运行素材。"));
      return;
    }
    if (state.masterAccessRequired) {
      container.appendChild(createElement("div", "locked-panel", "此阶段已锁定。请回到模板阶段，选择登记的母版 PSD/PSB 并核对内容指纹。"));
      return;
    }
    const selectorLabel = createElement("label", "field-label", "选择试套素材组");
    selectorLabel.htmlFor = "trial-group-select";
    const selector = createElement("select", "group-select trial-group-select");
    selector.id = "trial-group-select";
    selector.disabled = Boolean(state.busy);
    for (const group of groups) {
      const option = createElement("option", undefined, group.name);
      option.value = group.name;
      option.selected = group.name === state.trialGroupName;
      selector.appendChild(option);
    }
    selector.addEventListener("change", () => {
      state.trialGroupName = selector.value;
      state.trialRun = undefined;
      state.trialEvents = [];
      render();
    });
    appendChildren(container, selectorLabel, selector);
    const run = actionButton(
      state.busy === "trial" ? "试套处理中…" : services.capability.productionEnabled ? "运行真实单组试套" : "运行诊断试套",
      "primary-action trial-run",
      Boolean(state.busy),
    );
    run.addEventListener("click", () => { void runTrial(); });
    container.appendChild(run);

    if (state.trialRun || state.trialEvents.length > 0 || state.busy === "trial") {
      const result = createElement("section", "trial-result");
      const resultStatus = !state.trialRun ? "running" : trialRunIsClean(state) ? "completed" : "failed";
      result.appendChild(createElement(
        "p",
        `trial-result__status trial-result__status--${resultStatus}`,
        state.trialRun
          ? trialRunIsClean(state)
            ? "试套事务已完成"
            : state.trialRun.cleanupWarning
              ? `试套不能放行：${state.trialRun.cleanupWarning}`
              : `试套未完成：${state.trialRun.error ?? state.trialRun.status}`
          : `正在执行：${state.currentStage ? stageLabels[state.currentStage] : "准备"}`,
      ));
      const events = createElement("div", "trial-result__events");
      for (const event of state.trialEvents) events.appendChild(createElement("p", "trial-result__event", `${stageLabels[event.stage]} / ${event.state}`));
      result.appendChild(events);
      container.appendChild(result);
    }
    const approve = actionButton(
      state.trial?.approved ? "试套已确认" : "确认试套合格",
      "secondary-action trial-approve",
      !services.capability.productionEnabled || !trialRunIsClean(state) || state.trial?.approved || Boolean(state.busy),
    );
    approve.title = services.capability.productionEnabled ? "检查真实输出后确认" : "诊断试套不能解锁正式生产";
    approve.addEventListener("click", () => { void approveTrial(); });
    container.appendChild(approve);
  };

  const renderRunStage = (container: HTMLElement): void => {
    const reason = startBlockReason(state, services);
    const checklist = createElement("section", "readiness-list");
    const checks = [
      { ready: Boolean(state.templateFingerprint && !state.templateDirty), label: "模板草稿已保存" },
      { ready: Boolean(state.report?.validGroupCount), label: "素材预检有可运行组" },
      { ready: trialIsCurrent(state), label: "当前组合试套已确认" },
      { ready: !state.masterAccessRequired, label: "母版访问仍有效" },
      { ready: services.capability.productionEnabled, label: "M0 与生产能力已验证" },
    ];
    for (const check of checks) {
      const row = createElement("p", `readiness-item readiness-item--${check.ready ? "ready" : "blocked"}`);
      appendChildren(row, createElement("span", "readiness-item__mark", check.ready ? "✓" : "×"), createElement("span", undefined, check.label));
      checklist.appendChild(row);
    }
    container.appendChild(checklist);
    if (reason) container.appendChild(createElement("p", "action-advice", reason));

    if (state.busy === "batch" || state.busy === "retry") {
      const progress = createElement("section", "batch-progress");
      progress.setAttribute("role", "status");
      progress.setAttribute("aria-live", "polite");
      appendChildren(
        progress,
        createElement("p", "batch-progress__eyebrow", state.stopRequested ? "已请求安全停止" : "批次运行中"),
        createElement("h3", "batch-progress__group", state.currentGroup ?? "准备下一组"),
        createElement("p", "batch-progress__stage", state.currentStage ? stageLabels[state.currentStage] : "正在准备"),
      );
      const stop = actionButton(
        state.stopRequested ? "等待安全边界…" : "安全停止",
        "danger-action batch-stop",
        state.stopRequested,
      );
      stop.addEventListener("click", () => {
        state.cancellation?.cancel();
        state.stopRequested = true;
        setNotice("warning", "已请求停止；当前操作完成后将在安全边界结束，不会提交未完成组");
        render();
      });
      progress.appendChild(stop);
      container.appendChild(progress);
    } else {
      const start = actionButton("启动正式批次", "primary-action batch-start", Boolean(reason));
      start.title = reason ?? "串行运行全部可运行素材组";
      start.addEventListener("click", () => { void startBatch(); });
      container.appendChild(start);
    }
  };

  const renderResultsStage = (container: HTMLElement): void => {
    for (const failure of state.persistenceFailures) {
      container.appendChild(createElement("p", "recovery-error", `运行记录 ${failure.source} 无法读取：${failure.message}`));
    }
    if (!state.batch) {
      container.appendChild(createElement(
        "div",
        "locked-panel",
        state.recoverableRuns.length > 0
          ? `发现 ${state.recoverableRuns.length} 个可恢复批次；请先恢复目录访问并核对指纹。`
          : "尚无批次结果。完成正式运行后将在这里显示分组状态。",
      ));
      return;
    }
    if (state.recoverableRuns.length > 1) {
      const runLabel = createElement("label", "field-label", "选择要处理的中断批次");
      runLabel.htmlFor = "recoverable-run-select";
      const runSelector = createElement("select", "group-select recoverable-run-select");
      runSelector.id = "recoverable-run-select";
      runSelector.disabled = Boolean(state.busy);
      for (const record of state.recoverableRuns) {
        const option = createElement("option", undefined, `${record.runId} / ${record.updatedAt}`);
        option.value = record.runId;
        option.selected = record.runId === state.batch.runId;
        runSelector.appendChild(option);
      }
      runSelector.addEventListener("change", () => {
        const selected = state.recoverableRuns.find((record) => record.runId === runSelector.value);
        if (!selected) return;
        state.batch = structuredClone(selected);
        setNotice("info", `正在查看可恢复批次 ${selected.runId}`);
        void persist();
        render();
      });
      appendChildren(container, runLabel, runSelector);
    }
    const summary = createElement("section", "result-summary");
    appendChildren(
      summary,
      createElement("p", "result-summary__eyebrow", `运行 ${state.batch.runId}`),
      createElement("h3", "result-summary__title", state.batch.status === "completed" ? "批次全部完成" : "批次需要处理"),
      createElement("p", "result-summary__body", state.batch.status === "access-required"
        ? "目录访问已失效。重新选择对应目录后，系统必须先核对指纹和已提交结果，再允许重试。"
        : `最后更新 ${state.batch.updatedAt}`),
    );
    container.appendChild(summary);
    const board = createElement("div", "result-board");
    for (const stateName of ["completed", "failed", "interrupted", "review-required", "running", "queued"] as const) {
      board.appendChild(renderResultColumn(stateName, state.batch.groups, (groupName) => { void confirmManualCleanup(groupName); }));
    }
    container.appendChild(board);
    const needsRecovery = state.batch.groups.some((group) =>
      group.state === "running" ||
      group.state === "queued" ||
      group.state === "review-required" ||
      Boolean(group.requiresReconciliation) ||
      Boolean(group.cleanupWarning)
    );
    const resultActions = createElement("div", "action-row result-actions");
    if (state.batch.status === "access-required") {
      const access = actionButton(
        state.busy === "access" ? "正在恢复目录访问…" : "重新选择失效目录",
        "secondary-action access-reselect",
        Boolean(state.busy),
      );
      access.addEventListener("click", () => { void reselectRunAccess(); });
      resultActions.appendChild(access);
    }
    if (needsRecovery) {
      const recover = actionButton(
        state.busy === "recovery" ? "正在对账与清理…" : "恢复并核对批次",
        "secondary-action batch-recover",
        Boolean(state.busy) || state.batch.status === "access-required",
      );
      recover.addEventListener("click", () => { void recoverRun(); });
      resultActions.appendChild(recover);
    }
    const eligible = state.batch.groups.some((group) =>
      (group.state === "failed" || group.state === "interrupted") &&
      !group.requiresReconciliation &&
      !group.cleanupWarning &&
      !group.cleanupRequiresReview
    );
    const retryReason = retryBlockReason(state, services);
    if (eligible && retryReason) resultActions.appendChild(createElement("p", "action-advice", retryReason));
    const retry = actionButton(
      state.busy === "retry" ? "正在重试…" : "仅重试失败或中断组",
      "primary-action batch-retry",
      !eligible || needsRecovery || Boolean(retryReason) || state.batch.status === "access-required",
    );
    retry.addEventListener("click", () => { void retryFailed(); });
    resultActions.appendChild(retry);
    container.appendChild(resultActions);
  };

  function render(): void {
    root.replaceChildren();
    const shell = createElement("section", "app-shell");
    const header = createElement("header", "masthead");
    const brand = createElement("div", "brand-mark", "裁");
    const heading = createElement("div", "masthead__copy");
    appendChildren(
      heading,
      createElement("p", "kicker", "PHOTOSHOP UXP / OPERATOR FLOW"),
      createElement("h1", "masthead__title", "裁片印花批量套图"),
      createElement("p", "masthead__subtitle", "复用已认可的裁片母版，不重新排版。"),
    );
    appendChildren(header, brand, heading);

    const capability = createElement("section", `capability-card capability-card--${services.capability.productionEnabled ? "ready" : "locked"}`);
    const capabilityHeader = createElement("div", "capability-card__header");
    appendChildren(
      capabilityHeader,
      createElement("span", "status-pill", services.capability.label),
      createElement("span", "version", `v${pluginVersion}`),
    );
    appendChildren(
      capability,
      capabilityHeader,
      createElement("h2", "capability-card__title", services.capability.title),
      createElement("p", "capability-card__body", services.capability.advice),
    );

    if (state.notice) {
      const notice = createElement("div", `global-notice global-notice--${state.notice.kind}`, state.notice.message);
      notice.setAttribute("role", state.notice.kind === "error" ? "alert" : "status");
      notice.setAttribute("aria-live", state.notice.kind === "error" ? "assertive" : "polite");
      shell.appendChild(notice);
    }
    if (state.busy === "loading") shell.appendChild(createElement("div", "loading-state", "正在恢复模板草稿和中断批次…"));

    const workflow = createElement("section", "workflow");
    workflow.appendChild(createElement("p", "section-label", "工作流"));
    const navigation = createElement("div", "stage-nav");
    for (const stage of workflowStages) {
      const status = workflowStatus(stage.id, state, services);
      const button = createElement("button", `stage-nav__item stage-nav__item--${status}`);
      button.type = "button";
      button.dataset.stage = stage.id;
      button.dataset.selected = String(state.viewedStage === stage.id);
      button.dataset.workflowStatus = status;
      button.setAttribute("aria-current", state.viewedStage === stage.id ? "step" : "false");
      button.disabled = Boolean(state.busy);
      if (state.viewedStage === stage.id) button.classList.add("is-active");
      appendChildren(
        button,
        createElement("span", "stage-nav__number", stage.number),
        createElement("span", "stage-nav__label", state.viewedStage === stage.id ? `${stage.label}（查看）` : stage.label),
        createElement("span", "stage-nav__state", workflowStatusLabel(status)),
      );
      button.addEventListener("click", () => {
        state.viewedStage = stage.id;
        render();
      });
      navigation.appendChild(button);
    }
    const detail = createElement("article", "stage-detail");
    const stage = workflowStages.find((candidate) => candidate.id === state.viewedStage)!;
    renderStageHeader(detail, stage);
    if (stage.id === "template") renderTemplateStage(detail);
    if (stage.id === "input") renderInputStage(detail);
    if (stage.id === "preview") renderPreviewStage(detail);
    if (stage.id === "run") renderRunStage(detail);
    if (stage.id === "results") renderResultsStage(detail);
    appendChildren(workflow, navigation, detail);

    const footer = createElement("footer", "diagnostics");
    appendChildren(
      footer,
      createElement("span", "diagnostics__label", "STATE"),
      createElement("span", "diagnostics__value", state.busy ? `忙碌 / ${state.busy}` : "就绪 / Manifest v5 / API v2"),
    );
    appendChildren(shell, header, capability, workflow, footer);
    root.appendChild(shell);
  }

  render();
  const ready = (async () => {
    const loaded = await services.loadWorkspace();
    let recovery: Awaited<ReturnType<OperatorServices["listRecoverableRuns"]>> = { records: [], failures: [] };
    try {
      recovery = await services.listRecoverableRuns();
    } catch (error) {
      state.persistenceFailures.push({ source: "运行记录目录", message: errorMessage(error) });
    }
    if (loaded.failure) state.persistenceFailures.push({ source: "操作草稿", message: loaded.failure });
    if (loaded.workspace?.latestRun) {
      state.batch = {
        ...structuredClone(loaded.workspace.latestRun),
        accessGrants: { master: "", input: "", output: "" },
      };
    }
    if (loaded.workspace?.draft) {
      const restored: TemplateConfig = {
        ...structuredClone(loaded.workspace.draft.template),
        masterSourceRef: "reselection-required",
      };
      state.template = restored;
      state.templateText = formatTemplate(restored);
      state.templateFingerprint = loaded.workspace.draft.templateFingerprint;
      state.templateSavedAt = loaded.workspace.draft.savedAt;
      state.templateDirty = false;
      state.masterAccessRequired = true;
      state.trial = loaded.workspace.trial ? { ...loaded.workspace.trial } : undefined;
      setNotice("warning", "已恢复模板草稿；为避免保存会话 token，母版文件必须重新选择并核对指纹");
    }
    state.persistenceFailures.push(...recovery.failures);
    const recoveredRecords: BatchRunRecord[] = [];
    for (const record of recovery.records) {
      try {
        recoveredRecords.push(await services.recoverRun(record.runId));
      } catch (error) {
        recoveredRecords.push(structuredClone(record));
        state.persistenceFailures.push({ source: record.runId, message: `自动恢复失败：${errorMessage(error)}` });
      }
    }
    state.recoverableRuns = recoveredRecords;
    if (state.recoverableRuns.length > 0) {
      state.batch = structuredClone(state.recoverableRuns[0]);
      state.viewedStage = "results";
    }
    state.busy = undefined;
    if (state.batch) await persist();
    render();
  })().catch((error) => {
    state.busy = undefined;
    setNotice("error", `启动恢复失败：${errorMessage(error)}`);
    render();
  });

  return { ready, getState: () => state };
}

export type { OperatorServices } from "./ui/operator-services";
