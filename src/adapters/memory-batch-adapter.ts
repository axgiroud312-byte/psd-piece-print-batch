import type { ArtworkAssignment, InputGroupSnapshot, OutputTarget, TemplateConfig } from "../domain/types";
import { OperationCancelledError } from "../workflow/cancellation";
import { fingerprintValue } from "../workflow/fingerprint";
import type {
  CancellationToken,
  CommittedOutput,
  DraftOutput,
  ExecutionScope,
  GroupExecutionAdapter,
  OutputArtifact,
  OutputArtifactExpectation,
  OutputArtifactMetadata,
  RunStage,
  VerifiedOutput,
} from "../workflow/types";

interface MemoryScope extends ExecutionScope {
  resolved: boolean;
  artwork: Map<string, { sourceRef: string; fingerprint: string; fileName: string }>;
}

function expectedMetadata(target: OutputTarget): OutputArtifactMetadata {
  return {
    format: target.profile.format,
    width: target.region.width,
    height: target.region.height,
    ppi: target.profile.ppi,
    colorMode: target.profile.colorMode,
    bitDepth: target.profile.bitDepth,
    iccProfile: target.profile.icc.mode === "embed" ? target.profile.icc.profile : null,
    background: target.profile.background.kind === "solid" ? "opaque" : "transparent",
    includesGuides: target.profile.includeGuides,
  };
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

  async preflightOutput(
    _runId: string,
    _template: TemplateConfig,
    _group: InputGroupSnapshot,
    _pluginVersion: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.ensureNotCancelled(cancellation);
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

  async exportOutputs(
    scope: ExecutionScope,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    cancellation: CancellationToken,
  ): Promise<DraftOutput> {
    this.record("export-output");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    const temporaryLocation = `temp/${scope.scopeId}`;
    current.temporaryLocations.push(temporaryLocation);
    const expectedArtifacts: OutputArtifactExpectation[] = [
      {
        targetId: template.output.preview.id,
        name: template.output.preview.fileName,
        kind: "preview",
        region: { ...template.output.preview.region },
        visibleLayerPaths: structuredClone(template.output.preview.visibleLayerPaths),
        markLayerPaths: structuredClone(template.output.preview.markLayerPaths),
        maximumFileBytes: template.output.preview.maximumFileBytes,
        renderProfile: structuredClone(template.output.preview.profile),
        metadata: expectedMetadata(template.output.preview),
      },
      ...template.output.production.map((target) => ({
        targetId: target.id,
        name: target.fileName,
        kind: "production" as const,
        region: { ...target.region },
        visibleLayerPaths: structuredClone(target.visibleLayerPaths),
        markLayerPaths: structuredClone(target.markLayerPaths),
        maximumFileBytes: target.maximumFileBytes,
        renderProfile: structuredClone(target.profile),
        metadata: expectedMetadata(target),
      })),
    ];
    const output = {
      temporaryLocation,
      finalLocation: `runs/${scope.runId}/${group.name}`,
      groupName: group.name,
      capabilityProfileId: template.output.capabilityProfileId,
      expectedArtifacts,
      audit: {
        pluginVersion,
        outputImplementationVersion: "memory-adapter-v1",
        photoshopVersion: "memory-adapter",
        templateId: template.templateId,
        templateVersion: template.version,
        masterFingerprint: template.masterFingerprint,
        outputConfigFingerprint: fingerprintValue(template.output),
        sourceFingerprints: group.files
          .filter((file): file is typeof file & { fingerprint: string } => Boolean(file.fingerprint))
          .map((file) => ({ name: file.name, fingerprint: file.fingerprint })),
      },
    };
    this.interrupt("export-output");
    return output;
  }

  async verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<VerifiedOutput> {
    this.record("verify-output");
    this.ensureNotCancelled(cancellation);
    const current = this.memoryScope(scope);
    const artwork = [...current.artwork.entries()].sort(([left], [right]) => left.localeCompare(right));
    const artifacts: OutputArtifact[] = output.expectedArtifacts.map((expected) => ({
      name: expected.name,
      kind: expected.kind,
      fingerprint: fingerprintValue({ expected, artwork }),
      byteLength: 1,
      metadata: { ...expected.metadata },
    }));
    const reportText = JSON.stringify({ taskFingerprint, artifacts });
    artifacts.push({
      name: "result.json",
      kind: "report",
      fingerprint: fingerprintValue(reportText),
      byteLength: reportText.length,
    });
    this.interrupt("verify-output");
    return { ...output, taskFingerprint, artifacts };
  }

  async commitResult(
    scope: ExecutionScope,
    output: VerifiedOutput,
    cancellation: CancellationToken,
  ): Promise<CommittedOutput> {
    this.record("commit-result");
    this.ensureNotCancelled(cancellation);
    this.memoryScope(scope);
    this.interrupt("commit-result");
    const committed = {
      location: output.finalLocation,
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
