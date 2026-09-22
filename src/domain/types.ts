export type FitAnchor =
  { kind: "center" } | { kind: "offset"; x: number; y: number };

export type FitRule =
  | { mode: "strict"; anchor: FitAnchor }
  | { mode: "cover"; anchor: FitAnchor }
  | {
      mode: "contain";
      anchor: FitAnchor;
      allowBlankArea: true;
      background: string;
    };

export interface GarmentPiece {
  id: string;
  name: string;
}

export interface TemplateDocumentSpec {
  width: number;
  height: number;
  ppi: number;
  colorMode: "rgb" | "cmyk";
  bitDepth: 8 | 16;
  iccProfile: string | null;
}

export interface ArtworkEntry {
  id: string;
  name: string;
  inputKey: string;
  contentSourceId: string;
  replacementLayerName: string;
  required: boolean;
  optionalBehavior?: "keep-fixed";
  canvas: {
    width: number;
    height: number;
  };
  fit: FitRule;
}

export interface ArtworkInstance {
  id: string;
  garmentPieceId: string;
  artworkEntryId: string;
  layerPath: string[];
}

export type OutputFormat = "png" | "jpeg" | "psd" | "psb";
export type OutputCompression = "lossless" | "jpeg-high" | "photoshop";
export type OutputColorMode = "rgb" | "cmyk";
export type OutputBitDepth = 8 | 16;

export interface OutputRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OutputIccPolicy =
  { mode: "none" } | { mode: "embed"; profile: string };

export type OutputBackground =
  { kind: "transparent" } | { kind: "solid"; color: string };

export interface OutputRenderProfile {
  format: OutputFormat;
  compression: OutputCompression;
  ppi: number;
  colorMode: OutputColorMode;
  bitDepth: OutputBitDepth;
  icc: OutputIccPolicy;
  background: OutputBackground;
  includeGuides: boolean;
  includeMarks: boolean;
}

export interface OutputTarget {
  id: string;
  fileName: string;
  region: OutputRegion;
  visibleLayerPaths: string[][];
  markLayerPaths: string[][];
  maximumFileBytes: number;
  profile: OutputRenderProfile;
}

export type ProductionOutputTarget =
  | (OutputTarget & { productionKind: "piece"; garmentPieceId: string })
  | (OutputTarget & { productionKind: "combined" })
  | (OutputTarget & {
      productionKind: "editable-work-copy";
      preserveAllLayers: true;
    });

export interface TemplateOutputConfig {
  capabilityProfileId: string;
  productionMode: "pieces" | "combined" | "pieces-and-combined";
  preview: OutputTarget;
  production: ProductionOutputTarget[];
}

export interface TemplateConfig {
  schemaVersion: 2;
  templateId: string;
  version: string;
  masterFingerprint: string;
  masterSourceRef: string;
  document: TemplateDocumentSpec;
  garmentPieces: GarmentPiece[];
  artworkEntries: ArtworkEntry[];
  instances: ArtworkInstance[];
  output: TemplateOutputConfig;
}

export interface InputFileSnapshot {
  name: string;
  width?: number;
  height?: number;
  ppi?: number;
  sourceRef?: string;
  fingerprint?: string;
  metadataError?: string;
}

export interface InputGroupSnapshot {
  name: string;
  files: InputFileSnapshot[];
}

export interface PreflightPayload {
  template: TemplateConfig;
  groups: InputGroupSnapshot[];
}

export type IssueSeverity = "error" | "warning" | "info";

export interface PreflightIssue {
  severity: IssueSeverity;
  code: string;
  message: string;
  entryId?: string;
  fileName?: string;
}

export interface ArtworkAssignment {
  entryId: string;
  contentSourceId: string;
  fileName: string;
  sourceRef: string;
  sourceFingerprint: string;
}

export interface GroupPreflight {
  groupName: string;
  status: "valid" | "invalid";
  assignments: ArtworkAssignment[];
  issues: PreflightIssue[];
}

export interface PreflightReport {
  templateIssues: PreflightIssue[];
  templateSummary: {
    garmentPieceCount: number;
    artworkEntryCount: number;
    instanceCount: number;
    mappings: string[];
  };
  groups: GroupPreflight[];
  validGroupCount: number;
  invalidGroupCount: number;
}
