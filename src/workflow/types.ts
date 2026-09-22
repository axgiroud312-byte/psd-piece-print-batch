import type {
  ArtworkAssignment,
  InputGroupSnapshot,
  TemplateConfig,
} from "../domain/types";

export type RunStage =
  | "preflight"
  | "copy-master"
  | "resolve-template"
  | "replace-artwork"
  | "validate-structure"
  | "export-preview"
  | "verify-output"
  | "commit-result"
  | "cleanup";

export type StageEventState = "started" | "completed" | "failed" | "cancelled";

export interface StageEvent {
  stage: RunStage;
  state: StageEventState;
  at: string;
  message: string;
}

export interface OwnedDocuments {
  masterDocumentId?: string;
  workCopyDocumentId?: string;
  contentDocumentIds: string[];
}

export interface ExecutionScope {
  scopeId: string;
  runId: string;
  documents: OwnedDocuments;
  temporaryLocations: string[];
}

export interface OutputArtifact {
  name: string;
  kind: "preview" | "production" | "report";
  fingerprint: string;
  width?: number;
  height?: number;
}

export interface DraftOutput {
  temporaryLocation: string;
  artifacts: OutputArtifact[];
}

export interface CommittedOutput {
  location: string;
  artifacts: OutputArtifact[];
}

export interface GroupExecutionAdapter {
  createScope(runId: string): ExecutionScope;
  createWorkCopy(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  resolveTemplate(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  replaceArtwork(scope: ExecutionScope, assignments: ArtworkAssignment[], cancellation: CancellationToken): Promise<void>;
  validateStructure(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  exportPreview(
    scope: ExecutionScope,
    group: InputGroupSnapshot,
    cancellation: CancellationToken,
  ): Promise<DraftOutput>;
  verifyOutput(scope: ExecutionScope, output: DraftOutput, cancellation: CancellationToken): Promise<void>;
  commitResult(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<CommittedOutput>;
  cleanup(scope: ExecutionScope): Promise<void>;
}

export interface GroupRunRequest {
  runId: string;
  pluginVersion: string;
  template: TemplateConfig;
  group: InputGroupSnapshot;
}

export interface GroupRunResult {
  runId: string;
  groupName: string;
  taskFingerprint: string;
  status: "completed" | "failed" | "cancelled";
  lastStage: RunStage;
  startedAt: string;
  finishedAt: string;
  output?: CommittedOutput;
  error?: string;
  cleanupWarning?: string;
  events: StageEvent[];
}

export interface CancellationToken {
  readonly isCancellationRequested: boolean;
}

export interface RunOptions {
  cancellation?: CancellationToken;
  now?: () => string;
  onEvent?: (event: StageEvent) => void;
}
