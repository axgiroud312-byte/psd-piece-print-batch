import { describe, expect, it } from "vitest";

import {
  parsePreflightPayload,
  preflightGroups,
  validateTemplate,
} from "../src/domain/preflight";
import { samplePreflightPayload } from "../src/domain/sample";
import type { PreflightPayload, TemplateConfig } from "../src/domain/types";

function cloneSample(): PreflightPayload {
  return structuredClone(samplePreflightPayload);
}

describe("template validation", () => {
  it("distinguishes shared instances from conflicting shared content sources", () => {
    const payload = cloneSample();
    payload.template.artworkEntries.push({
      ...payload.template.artworkEntries[0],
      id: "entry-conflict",
      inputKey: "different-front",
    });

    expect(validateTemplate(payload.template)).toContainEqual(
      expect.objectContaining({
        code: "shared-source-conflict",
        severity: "error",
      }),
    );
  });

  it("rejects contradictory rules for one shared content source", () => {
    const payload = cloneSample();
    payload.template.artworkEntries.push({
      ...payload.template.artworkEntries[0],
      id: "entry-shared-rule-conflict",
      fit: { mode: "cover", anchor: { kind: "center" } },
    });
    payload.template.instances.push({
      id: "instance-shared-rule-conflict",
      garmentPieceId: "piece-front",
      artworkEntryId: "entry-shared-rule-conflict",
      layerPath: ["PRINT｜生产内容", "前片", "第二实例"],
    });

    expect(validateTemplate(payload.template)).toContainEqual(
      expect.objectContaining({
        code: "shared-rule-conflict",
        severity: "error",
      }),
    );
  });

  it("requires one replacement layer contract per shared content source", () => {
    const payload = cloneSample();
    payload.template.artworkEntries.push({
      ...payload.template.artworkEntries[0],
      id: "entry-shared-layer-conflict",
      replacementLayerName: "OTHER_ART",
    });
    payload.template.instances.push({
      id: "instance-shared-layer-conflict",
      garmentPieceId: "piece-front",
      artworkEntryId: "entry-shared-layer-conflict",
      layerPath: ["PRINT｜生产内容", "前片", "另一智能对象实例"],
    });

    expect(validateTemplate(payload.template)).toContainEqual(
      expect.objectContaining({
        code: "shared-rule-conflict",
        severity: "error",
      }),
    );
  });

  it("requires optional and contain behavior to be explicit", () => {
    const payload = cloneSample();
    const entry = payload.template.artworkEntries[0];
    entry.required = false;
    entry.fit = {
      mode: "contain",
      anchor: { kind: "center" },
      allowBlankArea: true,
      background: "",
    };

    const codes = validateTemplate(payload.template).map((issue) => issue.code);
    expect(codes).toContain("missing-optional-behavior");
    expect(codes).toContain("unsafe-contain");
  });

  it("rejects ambiguous instance references", () => {
    const payload = cloneSample();
    payload.template.instances[0].garmentPieceId = "missing-piece";
    payload.template.instances[0].layerPath = [];

    const codes = validateTemplate(payload.template).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["unknown-piece", "missing-layer-path"]),
    );
  });

  it("rejects duplicate layer paths and entries without instances", () => {
    const payload = cloneSample();
    payload.template.instances[1].layerPath = [
      ...payload.template.instances[0].layerPath,
    ];
    payload.template.instances = payload.template.instances.filter(
      (instance) => instance.artworkEntryId !== "entry-sleeves",
    );

    const codes = validateTemplate(payload.template).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "duplicate-layer-path",
        "entry-without-instance",
      ]),
    );
  });

  it("rejects an empty no-op template", () => {
    const payload = cloneSample();
    payload.template.garmentPieces = [];
    payload.template.artworkEntries = [];
    payload.template.instances = [];

    expect(validateTemplate(payload.template)).toContainEqual(
      expect.objectContaining({ code: "empty-template", severity: "error" }),
    );
  });

  it("requires explicit fixed output regions, metadata, and one production target per piece", () => {
    const payload = cloneSample();
    payload.template.output.preview.region.width = 0;
    payload.template.output.preview.profile.background = {
      kind: "transparent",
    };
    payload.template.output.production = [];

    const codes = validateTemplate(payload.template).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "invalid-output-region",
        "output-background",
        "missing-output-piece",
      ]),
    );
  });

  it("rejects output filename collisions and mismatched format settings", () => {
    const payload = cloneSample();
    payload.template.output.production[0].fileName =
      payload.template.output.preview.fileName;
    payload.template.output.production[1].profile.compression = "jpeg-high";

    const codes = validateTemplate(payload.template).map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["duplicate-id", "output-compression"]),
    );
  });

  it("supports combined production output and optional editable work copies", () => {
    const payload = cloneSample();
    const combined = {
      ...payload.template.output.production[0],
      id: "production-combined",
      productionKind: "combined" as const,
      fileName: "合版.png",
    };
    const editable = {
      ...payload.template.output.production[0],
      id: "editable-work-copy",
      productionKind: "editable-work-copy" as const,
      preserveAllLayers: true as const,
      fileName: "工作副本.psb",
      region: {
        x: 0,
        y: 0,
        width: payload.template.document.width,
        height: payload.template.document.height,
      },
      visibleLayerPaths: [],
      markLayerPaths: [],
      maximumFileBytes: 200_000_000,
      profile: {
        ...payload.template.output.production[0].profile,
        format: "psb" as const,
        compression: "photoshop" as const,
        ppi: payload.template.document.ppi,
        includeGuides: true,
        includeMarks: true,
      },
    };
    payload.template.output.productionMode = "combined";
    payload.template.output.production = [combined, editable];

    expect(validateTemplate(payload.template)).toHaveLength(0);
  });

  it("rejects fixed regions outside the registered document canvas", () => {
    const payload = cloneSample();
    payload.template.output.preview.region.x =
      payload.template.document.width - 1;

    expect(validateTemplate(payload.template)).toContainEqual(
      expect.objectContaining({ code: "output-region-outside-document" }),
    );
  });
});

describe("group preflight", () => {
  it("matches PNG and JPEG by declared names and ignores PPI for placement", () => {
    const payload = cloneSample();
    payload.groups = [payload.groups[0]];

    const report = preflightGroups(payload);

    expect(report.validGroupCount).toBe(1);
    expect(report.groups[0].assignments).toHaveLength(3);
    expect(report.groups[0].issues).toHaveLength(0);
  });

  it("reports missing, duplicate, extra, unsupported, and strict-size problems", () => {
    const payload = cloneSample();
    payload.groups = [
      {
        name: "异常组",
        files: [
          { name: "front.png", width: 1200, height: 1600 },
          { name: "front.jpg", width: 2400, height: 3200 },
          { name: "sleeves.png", width: 1800, height: 2400 },
          { name: "unused.jpeg", width: 50, height: 50 },
          { name: "notes.txt" },
        ],
      },
    ];

    const codes = preflightGroups(payload).groups[0].issues.map(
      (issue) => issue.code,
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "duplicate-match",
        "missing-required",
        "extra-file",
        "unsupported-file",
      ]),
    );
  });

  it("checks strict-size mismatch separately from duplicate matching", () => {
    const payload = cloneSample();
    payload.groups[0].files[0] = {
      ...payload.groups[0].files[0],
      width: 1200,
      height: 1600,
    };

    expect(preflightGroups(payload).groups[0].issues).toContainEqual(
      expect.objectContaining({
        code: "strict-size-mismatch",
        fileName: "front.png",
      }),
    );
  });

  it("requires real dimensions for proportional fitting", () => {
    const payload = cloneSample();
    payload.groups[0].files[1] = {
      ...payload.groups[0].files[1],
      width: undefined,
      height: undefined,
    };

    expect(preflightGroups(payload).groups[0].issues).toContainEqual(
      expect.objectContaining({
        code: "missing-dimensions",
        fileName: "back.jpg",
      }),
    );
  });

  it("requires a scanned source reference and content fingerprint", () => {
    const payload = cloneSample();
    payload.groups[0].files[0].sourceRef = undefined;
    payload.groups[0].files[0].fingerprint = undefined;

    expect(preflightGroups(payload).groups[0].issues).toContainEqual(
      expect.objectContaining({
        code: "missing-source-identity",
        fileName: "front.png",
      }),
    );
  });

  it("rejects a fixed offset that cannot preserve the fitting contract", () => {
    const payload = cloneSample();
    payload.template.artworkEntries[1].fit = {
      mode: "cover",
      anchor: { kind: "offset", x: 100000, y: 100000 },
    };

    expect(preflightGroups(payload).groups[0].issues).toContainEqual(
      expect.objectContaining({
        code: "offset-out-of-range",
        entryId: "entry-back",
      }),
    );
  });

  it("accepts Chinese names, Windows-style paths, and legal punctuation", () => {
    const payload = cloneSample();
    payload.groups[0].name = "款式 01-蓝花（复核版）";
    payload.template.artworkEntries[0].inputKey = "前片 01-蓝花";
    payload.groups[0].files[0].name = "子目录\\前片 01-蓝花.PNG";

    expect(preflightGroups(payload).groups[0].status).toBe("valid");
  });
});

describe("manifest parsing", () => {
  it("parses a structurally valid payload", () => {
    const template = parsePreflightPayload(
      JSON.stringify(samplePreflightPayload),
    ).template;
    expect(template.templateId).toBe("shirt-demo-one-size");
    expect(template.schemaVersion).toBe(2);
    expect(template.output.preview.region).toEqual({
      x: 0,
      y: 0,
      width: 4800,
      height: 3600,
    });
    expect(template.output.production).toHaveLength(4);
  });

  it("rejects malformed JSON and missing arrays", () => {
    expect(() => parsePreflightPayload("not-json")).toThrow(
      "清单不是有效的 JSON",
    );
    const invalid: Partial<TemplateConfig> = { templateId: "x" };
    expect(() =>
      parsePreflightPayload(JSON.stringify({ template: invalid, groups: [] })),
    ).toThrow();
  });

  it("rejects malformed nested objects and boolean-like strings", () => {
    const nullPiece = cloneSample() as unknown as {
      template: { garmentPieces: unknown[] };
    };
    nullPiece.template.garmentPieces[0] = null;
    expect(() => parsePreflightPayload(JSON.stringify(nullPiece))).toThrow(
      "裁片必须是对象",
    );

    const stringBoolean = cloneSample() as unknown as {
      template: { artworkEntries: Array<{ required: unknown }> };
    };
    stringBoolean.template.artworkEntries[0].required = "false";
    expect(() => parsePreflightPayload(JSON.stringify(stringBoolean))).toThrow(
      "字段 required 必须是布尔值",
    );
  });
});
