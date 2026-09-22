import { MemoryBatchAdapter } from "../adapters/memory-batch-adapter";
import {
  selectAndScanInputRoot,
  selectTemplateConfigJson,
} from "../adapters/uxp-input-scanner";
import { PLUGIN_VERSION } from "../config";
import type { InputGroupSnapshot, TemplateConfig } from "../domain/types";
import type { BatchRunRecord } from "../workflow/run-batch";
import { fingerprintBytes } from "../workflow/fingerprint";
import { runSingleGroup } from "../workflow/run-group";
import type {
  CancellationToken,
  GroupRunResult,
  StageEvent,
} from "../workflow/types";

export interface OperatorCapability {
  productionEnabled: boolean;
  label: string;
  title: string;
  advice: string;
}

export interface TrialReceipt {
  templateFingerprint: string;
  taskFingerprint: string;
  groupName: string;
  completedAt: string;
  approved: boolean;
}

export interface PersistedTemplateDraft {
  schemaVersion: 1;
  template: Omit<TemplateConfig, "masterSourceRef">;
  templateFingerprint: string;
  savedAt: string;
}

export interface PersistedOperatorWorkspace {
  schemaVersion: 1;
  draft?: PersistedTemplateDraft;
  trial?: TrialReceipt;
  latestRun?: Omit<BatchRunRecord, "accessGrants">;
}

export interface SelectedMaster {
  sourceRef: string;
  fingerprint: string;
}

export interface WorkspaceLoadResult {
  workspace?: PersistedOperatorWorkspace;
  failure?: string;
}

export interface OperatorRunInput {
  template: TemplateConfig;
  groups: InputGroupSnapshot[];
}

export interface OperatorServices {
  capability: OperatorCapability;
  loadWorkspace(): Promise<WorkspaceLoadResult>;
  saveWorkspace(workspace: PersistedOperatorWorkspace): Promise<void>;
  selectTemplateJson(): Promise<string | null>;
  selectAndVerifyMaster(
    template: TemplateConfig,
  ): Promise<SelectedMaster | null>;
  selectInputGroups(): Promise<InputGroupSnapshot[] | null>;
  runTrial(
    input: { template: TemplateConfig; group: InputGroupSnapshot },
    options: { onEvent(event: StageEvent): void },
  ): Promise<GroupRunResult>;
  startBatch(
    input: OperatorRunInput,
    options: {
      cancellation: CancellationToken;
      onGroupEvent(groupName: string, event: StageEvent): void;
    },
  ): Promise<BatchRunRecord>;
  retryBatch(
    runId: string,
    input: OperatorRunInput,
    options: {
      cancellation: CancellationToken;
      onGroupEvent(groupName: string, event: StageEvent): void;
    },
  ): Promise<BatchRunRecord>;
  listRecoverableRuns(): Promise<{
    records: BatchRunRecord[];
    failures: Array<{ source: string; message: string }>;
  }>;
  recoverRun(runId: string): Promise<BatchRunRecord>;
  reselectRunAccess(runId: string): Promise<BatchRunRecord | null>;
  confirmManualCleanup(
    runId: string,
    groupName: string,
  ): Promise<BatchRunRecord>;
}

const WORKSPACE_KEY = "psd-piece-print-batch.operator-workspace.v1";

function isWorkspace(value: unknown): value is PersistedOperatorWorkspace {
  if (!value || typeof value !== "object") return false;
  const workspace = value as Partial<PersistedOperatorWorkspace>;
  if (workspace.schemaVersion !== 1) return false;
  if (workspace.draft !== undefined) {
    if (
      workspace.draft.schemaVersion !== 1 ||
      !workspace.draft.template ||
      typeof workspace.draft.templateFingerprint !== "string" ||
      typeof workspace.draft.savedAt !== "string" ||
      "masterSourceRef" in workspace.draft.template
    )
      return false;
  }
  if (
    workspace.trial !== undefined &&
    (typeof workspace.trial.templateFingerprint !== "string" ||
      typeof workspace.trial.taskFingerprint !== "string" ||
      typeof workspace.trial.groupName !== "string" ||
      typeof workspace.trial.completedAt !== "string" ||
      typeof workspace.trial.approved !== "boolean")
  )
    return false;
  if (
    workspace.latestRun !== undefined &&
    (workspace.latestRun.schemaVersion !== 1 ||
      typeof workspace.latestRun.runId !== "string" ||
      !Array.isArray(workspace.latestRun.groups) ||
      "accessGrants" in workspace.latestRun)
  )
    return false;
  return true;
}

interface UxpMasterFile {
  isFile: boolean;
  read(options: { format: string }): Promise<ArrayBuffer | string>;
}

interface UxpMasterStorage {
  localFileSystem: {
    getFileForOpening(options: {
      types: string[];
    }): Promise<UxpMasterFile | UxpMasterFile[] | null>;
    createPersistentToken(entry: UxpMasterFile): Promise<string>;
  };
  formats: { binary: string };
}

async function selectAndVerifyMaster(
  template: TemplateConfig,
): Promise<SelectedMaster | null> {
  const storage = require("uxp").storage as UxpMasterStorage;
  const selected = await storage.localFileSystem.getFileForOpening({
    types: ["psd", "psb"],
  });
  const file = Array.isArray(selected) ? selected[0] : selected;
  if (!file) return null;
  if (!file.isFile) throw new Error("母版必须选择 PSD 或 PSB 文件");
  const data = await file.read({ format: storage.formats.binary });
  if (!(data instanceof ArrayBuffer))
    throw new Error("母版读取结果不是二进制内容");
  const fingerprint = fingerprintBytes(new Uint8Array(data));
  if (fingerprint !== template.masterFingerprint) {
    throw new Error(
      "所选母版与配置登记的内容指纹不一致，请选择正确母版或重新登记模板",
    );
  }
  return {
    sourceRef: await storage.localFileSystem.createPersistentToken(file),
    fingerprint,
  };
}

export function createDefaultOperatorServices(): OperatorServices {
  return {
    capability: {
      productionEnabled: false,
      label: "待 M0 验证",
      title: "操作流可检查，真实生产仍保持锁定",
      advice:
        "请先提供真实母版、三组代表素材、认可输出和工厂规范，并在目标 Photoshop 版本完成 M0。诊断试套不能替代真实试套。",
    },
    async loadWorkspace() {
      try {
        const serialized = localStorage.getItem(WORKSPACE_KEY);
        if (!serialized) return {};
        const parsed: unknown = JSON.parse(serialized);
        if (!isWorkspace(parsed))
          return { failure: "已保存的操作草稿结构无效，请重新登记模板" };
        return { workspace: parsed };
      } catch (error) {
        return {
          failure:
            error instanceof Error
              ? `无法恢复操作草稿：${error.message}`
              : "无法恢复操作草稿",
        };
      }
    },
    async saveWorkspace(workspace) {
      localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
    },
    selectTemplateJson: () => selectTemplateConfigJson(),
    selectAndVerifyMaster,
    selectInputGroups: () => selectAndScanInputRoot(),
    async runTrial(input, options) {
      return runSingleGroup(
        {
          runId: `diagnostic-trial-${Date.now()}`,
          pluginVersion: PLUGIN_VERSION,
          template: input.template,
          group: input.group,
        },
        new MemoryBatchAdapter(input.template.masterFingerprint),
        { onEvent: options.onEvent },
      );
    },
    async startBatch() {
      throw new Error("真实生产能力尚未通过 M0，不能启动正式批次");
    },
    async retryBatch() {
      throw new Error("真实生产能力尚未通过 M0，不能重试正式批次");
    },
    async listRecoverableRuns() {
      return { records: [], failures: [] };
    },
    async recoverRun() {
      throw new Error("真实恢复入口尚未通过 M0 验证，不能修改运行记录");
    },
    async reselectRunAccess() {
      throw new Error("真实目录恢复入口尚未通过 M0 验证，不能修改运行记录");
    },
    async confirmManualCleanup() {
      throw new Error("真实人工清理确认入口尚未通过 M0 验证，不能修改运行记录");
    },
  };
}
