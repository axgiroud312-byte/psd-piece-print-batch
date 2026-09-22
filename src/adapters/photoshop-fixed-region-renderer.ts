import type { OutputTarget } from "../domain/types";
import type { ModalDocumentControl, OutputArtifactMetadata } from "../workflow/types";
import type { FixedRegionRenderer } from "./fixed-region-output-port";
import { assertBatchPlayResults } from "./photoshop-batch-adapter";
import { UxpOutputStorage, type UxpOutputFile } from "./uxp-output-storage";
import { BatchStoppingError, WorkflowFailure } from "../workflow/failures";

interface RenderLayer {
  id: number;
  name: string;
  visible: boolean;
  layers?: RenderLayer[];
  move?(relative: RenderLayer, placement: unknown): Promise<void>;
}

interface RenderGuide {
  delete(): Promise<void> | void;
}

interface RenderDocument {
  id: number;
  name: string;
  width: number;
  height: number;
  resolution: number;
  mode: unknown;
  bitsPerChannel: unknown;
  colorProfileName?: string;
  layers: RenderLayer[];
  activeLayers: RenderLayer[];
  guides?: RenderGuide[];
  duplicate(name?: string, mergeLayersOnly?: boolean): Promise<RenderDocument>;
  crop(bounds: { left: number; top: number; right: number; bottom: number }): Promise<void>;
  resizeImage(width?: number, height?: number, resolution?: number): Promise<void>;
  flatten(): Promise<void>;
  closeWithoutSaving(): Promise<void> | void;
  saveAs: {
    png(entry: UxpOutputFile, options: { compression: number }, asCopy: boolean): Promise<void>;
    jpg(
      entry: UxpOutputFile,
      options: { quality: number; embedColorProfile: boolean },
      asCopy: boolean,
    ): Promise<void>;
    psd(
      entry: UxpOutputFile,
      options: { embedColorProfile: boolean; maximizeCompatibility: boolean },
      asCopy: boolean,
    ): Promise<void>;
    psb(
      entry: UxpOutputFile,
      options: { embedColorProfile: boolean; maximizeCompatibility: boolean },
      asCopy: boolean,
    ): Promise<void>;
  };
}

interface PhotoshopImageData {
  hasAlpha: boolean;
  dispose(): void;
}

export interface PhotoshopRenderRuntime {
  documents: RenderDocument[];
  open(entry: UxpOutputFile): Promise<RenderDocument>;
  hasAlpha(documentId: number): Promise<boolean>;
  createSolidBackground(document: RenderDocument, color: string): Promise<void>;
}

function documentById(runtime: PhotoshopRenderRuntime, documentId: number): RenderDocument {
  const document = runtime.documents.find((candidate) => candidate.id === documentId);
  if (!document) throw new Error(`找不到 Photoshop 文档 ${documentId}`);
  return document;
}

function children(layer: RenderLayer): RenderLayer[] {
  return Array.isArray(layer.layers) ? layer.layers : [];
}

function setSubtreeVisibility(layer: RenderLayer, visible: boolean): void {
  layer.visible = visible;
  for (const child of children(layer)) setSubtreeVisibility(child, visible);
}

function uniqueLayer(layers: RenderLayer[], name: string, path: string[]): RenderLayer {
  const matches = layers.filter((layer) => layer.name === name);
  if (matches.length !== 1) throw new Error(`输出可见性路径歧义：${[...path, name].join(" / ")}`);
  return matches[0];
}

function applyVisibility(document: RenderDocument, paths: string[][]): void {
  for (const layer of document.layers) setSubtreeVisibility(layer, false);
  for (const path of paths) {
    let layers = document.layers;
    const parents: RenderLayer[] = [];
    for (const name of path) {
      const layer = uniqueLayer(layers, name, parents.map((parent) => parent.name));
      parents.push(layer);
      layers = children(layer);
    }
    for (const parent of parents) parent.visible = true;
    setSubtreeVisibility(parents[parents.length - 1], true);
  }
}

function normalizedColorMode(value: unknown): "rgb" | "cmyk" | undefined {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("cmyk")) return "cmyk";
  if (normalized.includes("rgb")) return "rgb";
  return undefined;
}

function normalizedBitDepth(value: unknown): 8 | 16 | undefined {
  if (value === 8 || String(value).toLowerCase().includes("eight")) return 8;
  if (value === 16 || String(value).toLowerCase().includes("sixteen")) return 16;
  return undefined;
}

function decodedFormat(bytes: Uint8Array): OutputArtifactMetadata["format"] {
  if (
    bytes.length >= 8 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  ) {
    return "png";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x38 &&
    bytes[1] === 0x42 &&
    bytes[2] === 0x50 &&
    bytes[3] === 0x53 &&
    bytes[4] === 0 &&
    (bytes[5] === 1 || bytes[5] === 2)
  ) {
    return bytes[5] === 1 ? "psd" : "psb";
  }
  throw new Error("输出文件容器签名无效或不受支持");
}

function requireDocumentControl(control: ModalDocumentControl | undefined): ModalDocumentControl {
  if (!control) throw new Error("真实 Photoshop 输出必须在带自动关闭保护的 modal 中运行");
  return control;
}

async function withOwnedDocument<T>(
  document: RenderDocument,
  control: ModalDocumentControl,
  operation: () => Promise<T>,
): Promise<T> {
  let registered = false;
  try {
    await control.registerAutoCloseDocument(document.id);
    registered = true;
    return await operation();
  } finally {
    await document.closeWithoutSaving();
    if (registered) await control.unregisterAutoCloseDocument(document.id);
  }
}

function defaultRuntime(): PhotoshopRenderRuntime {
  const photoshop = require("photoshop") as {
    app: { documents: RenderDocument[]; open(entry: UxpOutputFile): Promise<RenderDocument> };
    action: { batchPlay(commands: unknown[], options: unknown): Promise<Array<Record<string, unknown>>> };
    constants: { ElementPlacement: { PLACEAFTER: unknown } };
    imaging: {
      getPixels(options: { documentID: number; componentSize: number }): Promise<{ imageData: PhotoshopImageData }>;
    };
  };
  return {
    documents: photoshop.app.documents,
    open: (entry) => photoshop.app.open(entry),
    hasAlpha: async (documentId) => {
      const result = await photoshop.imaging.getPixels({ documentID: documentId, componentSize: 8 });
      try {
        return result.imageData.hasAlpha;
      } finally {
        result.imageData.dispose();
      }
    },
    createSolidBackground: async (document, color) => {
      const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
      if (!match) throw new Error(`输出底色必须使用 #RRGGBB：${color}`);
      const results = await photoshop.action.batchPlay(
        [{
          _obj: "make",
          _target: [{ _ref: "contentLayer" }],
          using: {
            _obj: "contentLayer",
            type: {
              _obj: "solidColorLayer",
              color: {
                _obj: "RGBColor",
                red: Number.parseInt(match[1], 16),
                green: Number.parseInt(match[2], 16),
                blue: Number.parseInt(match[3], 16),
              },
            },
          },
          _options: { dialogOptions: "silent" },
        }],
        { synchronousExecution: false, modalBehavior: "fail" },
      );
      assertBatchPlayResults(results, "创建输出底色");
      const background = document.activeLayers[0];
      const bottom = document.layers[document.layers.length - 1];
      if (!background?.move || !bottom) throw new Error("无法把输出底色放到图层底部");
      if (background.id !== bottom.id) {
        await background.move(bottom, photoshop.constants.ElementPlacement.PLACEAFTER);
      }
    },
  };
}

export class PhotoshopFixedRegionRenderer implements FixedRegionRenderer {
  private readonly runtime: PhotoshopRenderRuntime;

  constructor(
    private readonly storage: UxpOutputStorage,
    runtime?: PhotoshopRenderRuntime,
  ) {
    this.runtime = runtime ?? defaultRuntime();
  }

  private assertDocumentProfile(document: RenderDocument, target: OutputTarget): void {
    const colorMode = normalizedColorMode(document.mode);
    const bitDepth = normalizedBitDepth(document.bitsPerChannel);
    if (colorMode !== target.profile.colorMode || bitDepth !== target.profile.bitDepth) {
      throw new Error(
        `输出 ${target.fileName} 要求 ${target.profile.colorMode}/${target.profile.bitDepth} 位，但工作副本为 ${colorMode ?? "未知"}/${bitDepth ?? "未知"} 位`,
      );
    }
    if (target.profile.icc.mode === "embed" && document.colorProfileName !== target.profile.icc.profile) {
      throw new Error(`输出 ${target.fileName} 要求 ICC ${target.profile.icc.profile}，工作副本为 ${document.colorProfileName ?? "无"}`);
    }
  }

  async render(
    documentId: number,
    target: OutputTarget,
    _kind: "preview" | "production",
    destination: string,
    documentControl?: ModalDocumentControl,
  ): Promise<void> {
    const control = requireDocumentControl(documentControl);
    const source = documentById(this.runtime, documentId);
    const output = await source.duplicate(`批量输出-${target.id}`, false);
    await withOwnedDocument(output, control, async () => {
      this.assertDocumentProfile(output, target);
      const editable = "productionKind" in target && target.productionKind === "editable-work-copy";
      if (!editable) {
        applyVisibility(output, [
          ...target.visibleLayerPaths,
          ...(target.profile.includeMarks ? target.markLayerPaths : []),
        ]);
        if (!target.profile.includeGuides) {
          for (const guide of [...(output.guides ?? [])]) await guide.delete();
        }
        await output.crop({
          left: target.region.x,
          top: target.region.y,
          right: target.region.x + target.region.width,
          bottom: target.region.y + target.region.height,
        });
        if (Math.abs(output.resolution - target.profile.ppi) > 0.01) {
          await output.resizeImage(undefined, undefined, target.profile.ppi);
        }
        if (target.profile.background.kind === "solid") {
          await this.runtime.createSolidBackground(output, target.profile.background.color);
        }
        if (target.profile.format === "jpeg") await output.flatten();
      }
      const entry = await this.storage.fileEntry(destination, true);
      const embedColorProfile = target.profile.icc.mode === "embed";
      try {
        if (target.profile.format === "png") {
          await output.saveAs.png(entry, { compression: 6 }, true);
        } else if (target.profile.format === "jpeg") {
          await output.saveAs.jpg(entry, { quality: 12, embedColorProfile }, true);
        } else if (target.profile.format === "psd") {
          await output.saveAs.psd(entry, { embedColorProfile, maximizeCompatibility: true }, true);
        } else {
          await output.saveAs.psb(entry, { embedColorProfile, maximizeCompatibility: true }, true);
        }
      } catch (error) {
        if (error instanceof WorkflowFailure) throw error;
        const cancellation = error as { number?: number; message?: string };
        if (cancellation.number === -128 || /cancelled|canceled|取消/i.test(cancellation.message ?? "")) throw error;
        throw new BatchStoppingError(
          "photoshop-output-save-failed",
          error instanceof Error ? `Photoshop 保存 ${target.fileName} 失败：${error.message}` : `Photoshop 保存 ${target.fileName} 失败`,
        );
      }
    });
  }

  async inspect(
    bytes: Uint8Array,
    _fileName: string,
    location: string,
    _expected: OutputArtifactMetadata,
    documentControl?: ModalDocumentControl,
  ): Promise<OutputArtifactMetadata> {
    const control = requireDocumentControl(documentControl);
    const document = await this.runtime.open(await this.storage.fileEntry(location));
    return withOwnedDocument(document, control, async () => {
      const hasAlpha = await this.runtime.hasAlpha(document.id);
      return {
        format: decodedFormat(bytes),
        width: document.width,
        height: document.height,
        ppi: document.resolution,
        colorMode: normalizedColorMode(document.mode) ?? ("invalid" as OutputArtifactMetadata["colorMode"]),
        bitDepth: normalizedBitDepth(document.bitsPerChannel) ?? (0 as OutputArtifactMetadata["bitDepth"]),
        iccProfile: document.colorProfileName && document.colorProfileName !== "None" ? document.colorProfileName : null,
        background: hasAlpha ? "transparent" : "opaque",
        includesGuides: (document.guides?.length ?? 0) > 0,
      };
    });
  }
}
