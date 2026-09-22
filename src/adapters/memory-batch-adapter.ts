import type { ArtworkAssignment, InputGroupSnapshot, TemplateConfig } from "../domain/types";
import { OperationCancelledError } from "../workflow/cancellation";
import { fingerprintValue } from "../workflow/fingerprint";
import type {
  CancellationToken,
  CommittedOutput,
  DraftOutput,
  ExecutionScope,
  GroupExecutionAdapter,
  RunStage,
} from "../workflow/types";

interface MemoryScope extends ExecutionScope {
  resolved: boolean;
  artwork: Map<string, { sourceRef: string; fingerprint: string; fileName: string }>;
}

export interface MemoryAdapterOptions {
  failAt?: Exclude<RunStage, "preflight">;
  cancelAt?: Exclude<RunStage, "preflight">;
}

export class MemoryBatchAdapter implements GroupExecutionAdapter {
  readonly calls: RunStage[] = [];
  readonly committed: CommittedOutput[] = [];
  readonly masterFingerprint: string;
  private sequence = 0;
  private readonly scopes = new Map<string, MemoryScope>();
  private readonly masterState: { fingerprint: string };

  constructor(
    masterFingerprint: string,
    private readonly options: MemoryAdapterOptions = {},
  ) {
    this.masterFingerprint = masterFingerprint;
    this.masterState = { fingerprint: masterFingerprint };
  }

  get openSessionCount(): number {
    return this.scopes.size;
  }

  get retainedScopeCount(): number {
    return this.scopes.size;
  }

  get ownedTemporaryCount(): number {
    return [...this.scopes.values()].reduce((count, scope) => count + scope.temporaryLocations.length, 0);
  }

  get masterStateDigest(): string {
    return fingerprintValue(this.masterState);
  }

  private record(stage: Exclude<RunStage, "preflight">): void {
    this.calls.push(stage);
  }

  private interrupt(stage: Exclude<RunStage, "preflight">): void {
    if (this.options.cancelAt === stage) throw new OperationCancelledError(`宿主取消：${stage}`);
    if (this.options.failAt === stage) throw new Error(`模拟失败：${stage}`);
  }

  private ensureNotCancelled(cancellation: CancellationToken): void {
    if (cancellation.isCancellationRequested) throw new OperationCancelledError();
  }

  private memoryScope(scope: ExecutionScope): MemoryScope {
    const current = this.scopes.get(scope.scopeId);
    if (!current) throw new Error("执行作用域不存在或已经清理");
    return current;
  }

  createScope(runId: string): ExecutionScope {
    this.sequence += 1;
    const scope: MemoryScope = {
      scopeId: `${runId}-scope-${this.sequence}`,
      runId,
      documents: { contentDocumentIds: [] },
      temporaryLocations: [],
      resolved: false,
      artwork: new Map(),
    };
    this.scopes.set(scope.scopeId, scope);
    return scope;
  }

  async createWorkCopy(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.record("copy-master");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    if (template.masterFingerprint !== this.masterFingerprint) throw new Error("母版指纹与适配器不一致");
    current.documents.masterDocumentId = `master-${this.masterFingerprint.slice(0, 8)}`;
    current.documents.workCopyDocumentId = `work-${scope.scopeId}`;
    this.interrupt("copy-master");
  }

  async resolveTemplate(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.record("resolve-template");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    if (template.instances.length === 0) throw new Error("模板没有可解析实例");
    current.resolved = true;
    this.interrupt("resolve-template");
  }

  async replaceArtwork(
    scope: ExecutionScope,
    assignments: ArtworkAssignment[],
    cancellation: CancellationToken,
  ): Promise<void> {
    this.record("replace-artwork");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    if (!current.resolved) throw new Error("必须先重新解析模板");
    for (let index = 0; index < assignments.length; index += 1) {
      const assignment = assignments[index];
      current.documents.contentDocumentIds.push(`content-${assignment.contentSourceId}-${index}`);
      current.artwork.set(assignment.contentSourceId, {
        sourceRef: assignment.sourceRef,
        fingerprint: assignment.sourceFingerprint,
        fileName: assignment.fileName,
      });
      if (index === 0) this.interrupt("replace-artwork");
    }
  }

  async validateStructure(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.record("validate-structure");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    const requiredSources = new Set(
      template.artworkEntries.filter((entry) => entry.required).map((entry) => entry.contentSourceId),
    );
    for (const source of requiredSources) {
      if (!current.artwork.has(source)) throw new Error(`必需内容源尚未替换：${source}`);
    }
    this.interrupt("validate-structure");
  }

  async exportPreview(
    scope: ExecutionScope,
    group: InputGroupSnapshot,
    cancellation: CancellationToken,
  ): Promise<DraftOutput> {
    this.record("export-preview");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    const temporaryLocation = `temp/${scope.scopeId}`;
    current.temporaryLocations.push(temporaryLocation);
    const artwork = [...current.artwork.entries()].sort(([left], [right]) => left.localeCompare(right));
    const fingerprint = fingerprintValue({ group: group.name, artwork });
    const output = {
      temporaryLocation,
      artifacts: [{ name: "预览.json", kind: "preview" as const, fingerprint }],
    };
    this.interrupt("export-preview");
    return output;
  }

  async verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.record("verify-output");
    this.ensureNotCancelled(cancellation);
    this.memoryScope(scope);
    if (output.artifacts.length !== 1 || output.artifacts[0].kind !== "preview") {
      throw new Error("预览输出不完整");
    }
    this.interrupt("verify-output");
  }

  async commitResult(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<CommittedOutput> {
    this.record("commit-result");
    this.ensureNotCancelled(cancellation);
    this.memoryScope(scope);
    this.interrupt("commit-result");
    const committed = {
      location: `runs/${scope.scopeId}/${taskFingerprint.slice(0, 12)}`,
      artifacts: [...output.artifacts],
    };
    this.committed.push(committed);
    return committed;
  }

  async cleanup(scope: ExecutionScope): Promise<void> {
    this.record("cleanup");
    const current = this.scopes.get(scope.scopeId);
    if (current) {
      current.documents.contentDocumentIds.length = 0;
      current.temporaryLocations.length = 0;
      current.artwork.clear();
      this.scopes.delete(scope.scopeId);
    }
    this.interrupt("cleanup");
  }
}
