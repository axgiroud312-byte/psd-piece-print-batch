import { preflightGroups } from "../domain/preflight";
import { OperationCancelledError, RunCancellation } from "./cancellation";
import { createTaskFingerprint } from "./fingerprint";
import type {
  ExecutionScope,
  GroupExecutionAdapter,
  GroupRunRequest,
  GroupRunResult,
  RunOptions,
  RunStage,
  StageEvent,
} from "./types";

export { RunCancellation } from "./cancellation";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "发生未知错误";
}

export async function runSingleGroup(
  request: GroupRunRequest,
  adapter: GroupExecutionAdapter,
  options: RunOptions = {},
): Promise<GroupRunResult> {
  const now = options.now ?? (() => new Date().toISOString());
  const cancellation = options.cancellation ?? { isCancellationRequested: false };
  const events: StageEvent[] = [];
  const startedAt = now();
  let taskFingerprint = "unavailable";
  let lastStage: RunStage = "preflight";
  let scope: ExecutionScope | undefined;
  let output: GroupRunResult["output"];
  let status: GroupRunResult["status"] = "failed";
  let failure: string | undefined;
  let cleanupWarning: string | undefined;

  const emit = (stage: RunStage, state: StageEvent["state"], message: string): void => {
    const event = { stage, state, message, at: now() };
    events.push(event);
    try {
      options.onEvent?.(event);
    } catch {
      // Progress observers must never change transaction or cleanup behavior.
    }
  };

  const ensureNotCancelled = (): void => {
    if (cancellation.isCancellationRequested) throw new OperationCancelledError();
  };

  const execute = async <T>(
    stage: RunStage,
    message: string,
    operation: () => Promise<T>,
    checkCancellationAfter = true,
  ): Promise<T> => {
    ensureNotCancelled();
    lastStage = stage;
    emit(stage, "started", message);
    ensureNotCancelled();
    let value: T;
    try {
      value = await operation();
    } catch (error) {
      emit(stage, error instanceof OperationCancelledError ? "cancelled" : "failed", errorMessage(error));
      throw error;
    }
    emit(stage, "completed", `${message}完成`);
    if (checkCancellationAfter) ensureNotCancelled();
    return value;
  };

  try {
    const preflight = preflightGroups({ template: request.template, groups: [request.group] });
    const group = preflight.groups[0];
    if (!group || group.status !== "valid") {
      const messages = group?.issues
        .filter((issue) => issue.severity === "error")
        .map((issue) => issue.message)
        .join("；");
      throw new Error(messages || "素材组预检未通过");
    }
    emit("preflight", "completed", "素材组预检通过");
    taskFingerprint = createTaskFingerprint(request.template, request.group, request.pluginVersion);
    scope = adapter.createScope(request.runId);

    await execute("copy-master", "创建干净母版工作副本", () =>
      adapter.createWorkCopy(scope!, request.template, cancellation),
    );
    await execute("resolve-template", "在工作副本中重新解析模板", () =>
      adapter.resolveTemplate(scope!, request.template, cancellation),
    );
    await execute("replace-artwork", "按唯一内容源替换素材", () =>
      adapter.replaceArtwork(scope!, group.assignments, cancellation),
    );
    await execute("validate-structure", "校验工作副本结构", () =>
      adapter.validateStructure(scope!, request.template, cancellation),
    );
    const draft = await execute("export-preview", "导出本组预览", () =>
      adapter.exportPreview(scope!, request.group, cancellation),
    );
    await execute("verify-output", "重读并验证预览输出", () =>
      adapter.verifyOutput(scope!, draft, cancellation),
    );
    output = await execute("commit-result", "原子提交本组结果", () =>
      adapter.commitResult(scope!, draft, taskFingerprint, cancellation),
      false,
    );
    status = "completed";
  } catch (error) {
    if (error instanceof OperationCancelledError) {
      status = "cancelled";
      failure = error.message;
    } else {
      status = "failed";
      failure = errorMessage(error);
      if (lastStage === "preflight") emit("preflight", "failed", failure);
    }
  } finally {
    if (scope) {
      lastStage = status === "completed" ? "commit-result" : lastStage;
      try {
        emit("cleanup", "started", "关闭插件拥有的临时文档");
        await adapter.cleanup(scope);
        emit("cleanup", "completed", "临时资源清理完成");
      } catch (error) {
        cleanupWarning = errorMessage(error);
        emit("cleanup", "failed", cleanupWarning);
      }
    }
  }

  return {
    runId: request.runId,
    groupName: request.group.name,
    taskFingerprint,
    status,
    lastStage,
    startedAt,
    finishedAt: now(),
    output,
    error: failure,
    cleanupWarning,
    events,
  };
}
