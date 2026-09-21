export type FitAnchor =
  | { kind: "center" }
  | { kind: "offset"; x: number; y: number };

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

export interface ArtworkEntry {
  id: string;
  name: string;
  inputKey: string;
  contentSourceId: string;
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

export interface TemplateConfig {
  schemaVersion: 1;
  templateId: string;
  version: string;
  masterFingerprint: string;
  garmentPieces: GarmentPiece[];
  artworkEntries: ArtworkEntry[];
  instances: ArtworkInstance[];
}

export interface InputFileSnapshot {
  name: string;
  width?: number;
  height?: number;
  ppi?: number;
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
