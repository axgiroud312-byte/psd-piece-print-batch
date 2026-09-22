import type {
  ArtworkAssignment,
  InputGroupSnapshot,
  OutputColorMode,
  OutputFormat,
  OutputRegion,
  OutputRenderProfile,
  TemplateConfig,
} from "../domain/types";
import type { FailureDetails } from "./failures";

export type RunStage =
  | "preflight"
  | "copy-master"
  | "resolve-template"
  | "replace-artwork"
  | "validate-structure"
  | "export-output"
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
  masterDocumentId?: string | number;
  workCopyDocumentId?: string | number;
  contentDocumentIds: Array<string | number>;
}

export interface ModalDocumentControl {
  registerAutoCloseDocument(documentId: number): Promise<void>;
  unregisterAutoCloseDocument(documentId: number): Promise<void>;
}

export interface ExecutionScope {
  scopeId: string;
  runId: string;
  attemptId: string;
  taskFingerprint: string;
  documents: OwnedDocuments;
  temporaryLocations: string[];
}

export interface OutputArtifact {
  name: string;
  kind: "preview" | "production" | "report";
  fingerprint: string;
  byteLength: number;
  metadata?: OutputArtifactMetadata;
}

export interface OutputArtifactMetadata {
  format: OutputFormat;
  width: number;
  height: number;
  ppi: number;
  colorMode: OutputColorMode;
  bitDepth: 8 | 16;
  iccProfile: string | null;
  background: "transparent" | "opaque";
  includesGuides: boolean;
}

export interface OutputArtifactExpectation {
  targetId: string;
  name: string;
  kind: "preview" | "production";
  region: OutputRegion;
  visibleLayerPaths: string[][];
  markLayerPaths: string[][];
  maximumFileBytes: number;
  renderProfile: OutputRenderProfile;
  metadata: OutputArtifactMetadata;
}

export interface DraftOutput {
  temporaryLocation: string;
  ownershipLocation?: string;
  finalLocation: string;
  groupName: string;
  capabilityProfileId: string;
  expectedArtifacts: OutputArtifactExpectation[];
  audit: OutputAuditContext;
}

export interface OutputAuditContext {
  pluginVersion: string;
  outputImplementationVersion: string;
  photoshopVersion: string;
  templateId: string;
  templateVersion: string;
  masterFingerprint: string;
  outputConfigFingerprint: string;
  sourceFingerprints: Array<{ name: string; fingerprint: string }>;
}

export interface VerifiedOutput {
  temporaryLocation: string;
  ownershipLocation?: string;
  finalLocation: string;
  groupName: string;
  capabilityProfileId: string;
  taskFingerprint: string;
  artifacts: OutputArtifact[];
}

export interface CommittedOutput {
  location: string;
  artifacts: OutputArtifact[];
}

export interface GroupExecutionAdapter {
  preflightOutput(
    runId: string,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    attemptId: string,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<void>;
  createScope(runId: string, attemptId: string, taskFingerprint: string): ExecutionScope;
  createWorkCopy(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  resolveTemplate(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  replaceArtwork(scope: ExecutionScope, assignments: ArtworkAssignment[], cancellation: CancellationToken): Promise<void>;
  validateStructure(scope: ExecutionScope, template: TemplateConfig, cancellation: CancellationToken): Promise<void>;
  exportOutputs(
    scope: ExecutionScope,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    cancellation: CancellationToken,
  ): Promise<DraftOutput>;
  verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<VerifiedOutput>;
  commitResult(
    scope: ExecutionScope,
    output: VerifiedOutput,
    cancellation: CancellationToken,
  ): Promise<CommittedOutput>;
  cleanup(scope: ExecutionScope): Promise<void>;
}

export interface GroupRunRequest {
  runId: string;
  pluginVersion: string;
  template: TemplateConfig;
  group: InputGroupSnapshot;
  attemptId?: string;
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
  failure?: FailureDetails;
  cleanupWarning?: string;
  cleanupRequiresReview?: boolean;
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
