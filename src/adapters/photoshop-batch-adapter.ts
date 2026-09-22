import type { ArtworkAssignment, ArtworkEntry, FitRule, InputGroupSnapshot, TemplateConfig } from "../domain/types";
import { resolveScannedInputFile } from "./uxp-input-scanner";
import { OperationCancelledError } from "../workflow/cancellation";
import type {
  CancellationToken,
  CommittedOutput,
  DraftOutput,
  ExecutionScope,
  GroupExecutionAdapter,
  ModalDocumentControl,
  VerifiedOutput,
} from "../workflow/types";

interface PhotoshopLayer {
  id: number;
  name: string;
  kind?: unknown;
  layers?: PhotoshopLayer[];
  boundsNoEffects?: BoundsLike;
  scale?(widthPercent: number, heightPercent: number): Promise<void>;
  translate?(deltaX: number, deltaY: number): Promise<void>;
  move?(relativeObject: PhotoshopLayer, insertionLocation: unknown): Promise<void>;
  delete?(): Promise<void>;
}

interface PhotoshopDocument {
  id: number;
  name: string;
  width?: NumberLike;
  height?: NumberLike;
  resolution?: number;
  mode?: unknown;
  bitsPerChannel?: unknown;
  colorProfileName?: string;
  layers: PhotoshopLayer[];
  duplicate?(name: string, mergeLayersOnly?: boolean): Promise<PhotoshopDocument>;
  save?(): Promise<void>;
  closeWithoutSaving?(): Promise<void>;
}

interface PhotoshopApplication {
  documents: PhotoshopDocument[];
  activeDocument?: PhotoshopDocument;
  open(file: unknown): Promise<PhotoshopDocument>;
}

interface ModalExecutionContext {
  isCancelled?: boolean;
  hostControl: ModalDocumentControl;
}

interface PhotoshopRuntime {
  hostVersion: string;
  app: PhotoshopApplication;
  core: {
    executeAsModal<T>(
      operation: (context: ModalExecutionContext) => Promise<T>,
      options: { commandName: string; interactive?: boolean },
    ): Promise<T>;
  };
  action: {
    batchPlay(commands: unknown[], options: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
  };
  constants: {
    LayerKind?: { SMARTOBJECT?: unknown };
    ElementPlacement?: { PLACEBEFORE?: unknown };
  };
  localFileSystem: {
    createSessionToken(file: unknown): string;
  };
}

type NumberLike = number | { value?: number; _value?: number };

export interface BoundsLike {
  left: NumberLike;
  top: NumberLike;
  right: NumberLike;
  bottom: NumberLike;
}

export interface FitTransform {
  scalePercent: number;
  targetCenterX: number;
  targetCenterY: number;
}

export interface PhotoshopCapabilityGate {
  m0Validated: boolean;
  smartObjectEditingValidated: boolean;
  validatedPhotoshopVersion: string;
}

export const UNVERIFIED_PHOTOSHOP_CAPABILITY: PhotoshopCapabilityGate = {
  m0Validated: false,
  smartObjectEditingValidated: false,
  validatedPhotoshopVersion: "",
};

export interface SourceResolver {
  resolve(sourceRef: string, expectedFingerprint: string): Promise<unknown>;
}

export interface PhotoshopOutputPort {
  preflight(runId: string, template: TemplateConfig, group: InputGroupSnapshot, pluginVersion: string): Promise<void>;
  exportOutputs(
    scope: ExecutionScope,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    documentId: number,
    pluginVersion: string,
    photoshopVersion: string,
    documentControl: ModalDocumentControl,
  ): Promise<DraftOutput>;
  verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    documentControl: ModalDocumentControl,
  ): Promise<VerifiedOutput>;
  commitResult(scope: ExecutionScope, output: VerifiedOutput): Promise<CommittedOutput>;
  cleanup(scope: ExecutionScope): Promise<void>;
}

export interface PhotoshopAdapterOptions {
  capability?: PhotoshopCapabilityGate;
  masterResolver: SourceResolver;
  artworkResolver?: SourceResolver;
  outputPort: PhotoshopOutputPort;
  runtime?: PhotoshopRuntime;
}

interface ResolvedSource {
  entry: ArtworkEntry;
  layerId: number;
  sourceIdentity: string;
}

interface ResolvedTemplateState {
  documentId: number;
  sources: Map<string, ResolvedSource>;
  structureSignature: string;
}

export class PhotoshopCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoshopCapabilityError";
  }
}

function numberValue(value: NumberLike | undefined, label: string): number {
  const resolved =
    typeof value === "number"
      ? value
      : typeof value?.value === "number"
        ? value.value
        : typeof value?._value === "number"
          ? value._value
          : Number.NaN;
  if (!Number.isFinite(resolved)) throw new Error(`${label} 不是有效像素值`);
  return resolved;
}

function documentColorMode(value: unknown): "rgb" | "cmyk" | undefined {
  const normalized = String(value).toLowerCase();
  if (normalized.includes("cmyk")) return "cmyk";
  if (normalized.includes("rgb")) return "rgb";
  return undefined;
}

function documentBitDepth(value: unknown): 8 | 16 | undefined {
  if (value === 8 || String(value).toLowerCase().includes("eight")) return 8;
  if (value === 16 || String(value).toLowerCase().includes("sixteen")) return 16;
  return undefined;
}

function assertDocumentSpec(document: PhotoshopDocument, template: TemplateConfig): void {
  const expected = template.document;
  const actual = {
    width: numberValue(document.width, "母版宽度"),
    height: numberValue(document.height, "母版高度"),
    ppi: document.resolution,
    colorMode: documentColorMode(document.mode),
    bitDepth: documentBitDepth(document.bitsPerChannel),
    iccProfile:
      document.colorProfileName && document.colorProfileName !== "None" ? document.colorProfileName : null,
  };
  if (
    actual.width !== expected.width ||
    actual.height !== expected.height ||
    !Number.isFinite(actual.ppi) ||
    Math.abs((actual.ppi as number) - expected.ppi) > 0.01 ||
    actual.colorMode !== expected.colorMode ||
    actual.bitDepth !== expected.bitDepth ||
    actual.iccProfile !== expected.iccProfile
  ) {
    throw new Error(
      `实际母版规格与登记不一致：登记 ${expected.width}×${expected.height}/${expected.ppi} PPI/${expected.colorMode}/${expected.bitDepth} 位/${expected.iccProfile ?? "无 ICC"}，实际 ${actual.width}×${actual.height}/${actual.ppi ?? "未知"} PPI/${actual.colorMode ?? "未知"}/${actual.bitDepth ?? "未知"} 位/${actual.iccProfile ?? "无 ICC"}`,
    );
  }
}

function anchorOffset(fit: FitRule): { x: number; y: number } {
  return fit.anchor.kind === "offset" ? { x: fit.anchor.x, y: fit.anchor.y } : { x: 0, y: 0 };
}

export function calculateFitTransform(
  bounds: BoundsLike,
  canvas: { width: number; height: number },
  fit: FitRule,
): FitTransform {
  const width = numberValue(bounds.right, "素材右边界") - numberValue(bounds.left, "素材左边界");
  const height = numberValue(bounds.bottom, "素材下边界") - numberValue(bounds.top, "素材上边界");
  if (width <= 0 || height <= 0) throw new Error("素材可见边界为空");
  const widthScale = canvas.width / width;
  const heightScale = canvas.height / height;
  if (fit.mode === "strict" && Math.abs(widthScale - heightScale) > 0.0001) {
    throw new Error("严格尺寸素材的可见边界比例与智能对象画布不一致");
  }
  const scale =
    fit.mode === "contain"
      ? Math.min(widthScale, heightScale)
      : fit.mode === "cover"
        ? Math.max(widthScale, heightScale)
        : widthScale;
  const offset = anchorOffset(fit);
  return {
    scalePercent: scale * 100,
    targetCenterX: canvas.width / 2 + offset.x,
    targetCenterY: canvas.height / 2 + offset.y,
  };
}

export function assertBatchPlayResults(results: Array<Record<string, unknown>>, operation: string): void {
  for (const result of results) {
    if (result.result === -128) throw new OperationCancelledError(`${operation}已由 Photoshop 取消`);
    if (result._obj === "error" || typeof result.message === "string" && typeof result.result === "number" && result.result < 0) {
      throw new Error(`${operation}失败：${String(result.message ?? result.result ?? "未知 Photoshop 错误")}`);
    }
  }
}

function defaultRuntime(): PhotoshopRuntime {
  const photoshop = require("photoshop") as Omit<PhotoshopRuntime, "localFileSystem" | "hostVersion">;
  const uxp = require("uxp") as {
    host: { version: string };
    storage: { localFileSystem: PhotoshopRuntime["localFileSystem"] };
  };
  return {
    ...photoshop,
    hostVersion: uxp.host.version,
    localFileSystem: uxp.storage.localFileSystem,
  };
}

function documentById(runtime: PhotoshopRuntime, documentId: number | undefined): PhotoshopDocument {
  const document = runtime.app.documents.find((candidate) => candidate.id === documentId);
  if (!document) throw new Error(`Photoshop 文档 ${String(documentId)} 不存在`);
  return document;
}

function findLayerAtPath(document: PhotoshopDocument, path: string[]): PhotoshopLayer {
  let layers = document.layers;
  let current: PhotoshopLayer | undefined;
  for (const segment of path) {
    const matches = layers.filter((layer) => layer.name === segment);
    if (matches.length !== 1) {
      throw new Error(`图层路径 ${path.join("/")} 在 ${segment} 处${matches.length === 0 ? "不存在" : "不唯一"}`);
    }
    current = matches[0];
    layers = current.layers ?? [];
  }
  if (!current) throw new Error("图层路径不能为空");
  return current;
}

function descriptorSourceIdentity(descriptor: Record<string, unknown>): string {
  const smartObject = descriptor.smartObject as Record<string, unknown> | undefined;
  const smartObjectMore = descriptor.smartObjectMore as Record<string, unknown> | undefined;
  const linked = Boolean(smartObject?.linked ?? smartObject?.link ?? descriptor.linked);
  if (linked) throw new Error("首版不支持外链智能对象，请先转换为嵌入式智能对象");
  const fileReference = String(descriptor.fileReference ?? smartObject?.fileReference ?? "").toLowerCase();
  if (/\.(pdf|ai)$/.test(fileReference)) throw new Error("首版不支持 PDF/AI 智能对象内容");
  const identity = smartObjectMore?.ID ?? smartObjectMore?.id ?? smartObject?.ID ?? smartObject?.id;
  if (typeof identity !== "string" && typeof identity !== "number") {
    throw new Error("无法取得智能对象内容源标识，需要在 M0 中记录并验证描述符");
  }
  return String(identity);
}

function stableDescriptorValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableDescriptorValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableDescriptorValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function descriptorStructureSignature(descriptor: Record<string, unknown>): string {
  const smartObjectMore = descriptor.smartObjectMore as Record<string, unknown> | undefined;
  return JSON.stringify(
    stableDescriptorValue({
      transform: smartObjectMore?.transform ?? descriptor.transform,
      hasUserMask: descriptor.hasUserMask,
      hasVectorMask: descriptor.hasVectorMask,
      opacity: descriptor.opacity,
      fillOpacity: descriptor.fillOpacity,
      mode: descriptor.mode,
    }),
  );
}

function assertSimpleReplacementLayer(descriptor: Record<string, unknown>, layerName: string): void {
  const opacity = descriptor.opacity;
  const fillOpacity = descriptor.fillOpacity;
  const modeValue =
    typeof descriptor.mode === "object" && descriptor.mode
      ? (descriptor.mode as Record<string, unknown>)._value
      : descriptor.mode;
  if (
    descriptor.hasUserMask === true ||
    descriptor.hasVectorMask === true ||
    descriptor.layerEffects !== undefined ||
    descriptor.group === true ||
    descriptor.clipping === true ||
    descriptor.visible === false ||
    (modeValue !== undefined && modeValue !== "normal" && modeValue !== "normalBlendMode") ||
    (opacity !== undefined && opacity !== 255) ||
    (fillOpacity !== undefined && fillOpacity !== 255)
  ) {
    throw new Error(`${layerName} 带有隐藏、混合、蒙版、效果、剪贴或非默认透明度，首版不自动迁移这些语义`);
  }
}

async function closeDocument(document: PhotoshopDocument): Promise<void> {
  if (!document.closeWithoutSaving) throw new Error(`文档 ${document.name} 不支持无保存关闭`);
  await document.closeWithoutSaving();
}

function ensureNotCancelled(cancellation: CancellationToken): void {
  if (cancellation.isCancellationRequested) throw new OperationCancelledError();
}

function ensureModalNotCancelled(context: ModalExecutionContext, cancellation: CancellationToken): void {
  ensureNotCancelled(cancellation);
  if (context.isCancelled) throw new OperationCancelledError("Photoshop 已取消当前操作");
}

export class PhotoshopBatchAdapter implements GroupExecutionAdapter {
  private sequence = 0;
  private runtimeInstance?: PhotoshopRuntime;
  private readonly capability: PhotoshopCapabilityGate;
  private readonly resolvedScopes = new Map<string, ResolvedTemplateState>();
  private readonly masterResolver: SourceResolver;
  private readonly artworkResolver: SourceResolver;
  private readonly outputPort: PhotoshopOutputPort;

  constructor(options: PhotoshopAdapterOptions) {
    this.capability = options.capability ?? UNVERIFIED_PHOTOSHOP_CAPABILITY;
    this.masterResolver = options.masterResolver;
    this.artworkResolver = options.artworkResolver ?? {
      resolve: async (sourceRef, expectedFingerprint) =>
        resolveScannedInputFile(sourceRef, expectedFingerprint),
    };
    this.outputPort = options.outputPort;
    this.runtimeInstance = options.runtime;
  }

  private get runtime(): PhotoshopRuntime {
    if (!this.runtimeInstance) this.runtimeInstance = defaultRuntime();
    return this.runtimeInstance;
  }

  private assertCapability(): void {
    if (!this.capability.m0Validated || !this.capability.smartObjectEditingValidated) {
      throw new PhotoshopCapabilityError("真实 Photoshop 操作尚未通过 M0 验证，当前入口保持禁用");
    }
    const expected = this.capability.validatedPhotoshopVersion;
    if (!expected) throw new PhotoshopCapabilityError("缺少经过 M0 验证的 Photoshop 精确版本");
    const actual = this.runtime.hostVersion;
    if (!actual || expected !== actual) {
      throw new PhotoshopCapabilityError(`当前 Photoshop ${actual} 不在已验证版本 ${expected} 内`);
    }
  }

  private async modal<T>(commandName: string, operation: (context: ModalExecutionContext) => Promise<T>): Promise<T> {
    try {
      return await this.runtime.core.executeAsModal(operation, { commandName, interactive: false });
    } catch (error) {
      const record = error as { number?: number; message?: string };
      if (record.number === -128 || /cancelled|canceled|取消/i.test(record.message ?? "")) {
        throw new OperationCancelledError(record.message ?? "Photoshop 已取消当前操作");
      }
      throw error;
    }
  }

  async preflightOutput(
    runId: string,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.assertCapability();
    ensureNotCancelled(cancellation);
    await this.outputPort.preflight(runId, template, group, pluginVersion);
  }

  private async selectLayer(documentId: number, layerId: number): Promise<void> {
    const results = await this.runtime.action.batchPlay(
      [
        {
          _obj: "select",
          _target: [
            { _ref: "layer", _id: layerId },
            { _ref: "document", _id: documentId },
          ],
          makeVisible: false,
          _options: { dialogOptions: "silent" },
        },
      ],
      {},
    );
    assertBatchPlayResults(results, "选择智能对象图层");
  }

  private async layerDescriptor(documentId: number, layerId: number): Promise<Record<string, unknown>> {
    const results = await this.runtime.action.batchPlay(
      [
        {
          _obj: "get",
          _target: [
            { _ref: "layer", _id: layerId },
            { _ref: "document", _id: documentId },
          ],
          _options: { dialogOptions: "silent" },
        },
      ],
      {},
    );
    assertBatchPlayResults(results, "读取智能对象描述符");
    if (!results[0]) throw new Error("Photoshop 未返回图层描述符");
    return results[0];
  }

  private async resolveDocumentTemplate(document: PhotoshopDocument, template: TemplateConfig): Promise<ResolvedTemplateState> {
    const sources = new Map<string, ResolvedSource>();
    const identityOwners = new Map<string, string>();
    const signatures: string[] = [];
    for (const instance of template.instances) {
      const layer = findLayerAtPath(document, instance.layerPath);
      const smartObjectKind = this.runtime.constants.LayerKind?.SMARTOBJECT;
      if (smartObjectKind !== undefined && layer.kind !== smartObjectKind) {
        throw new Error(`图层 ${instance.layerPath.join("/")} 不是智能对象`);
      }
      const descriptor = await this.layerDescriptor(document.id, layer.id);
      const sourceIdentity = descriptorSourceIdentity(descriptor);
      const entry = template.artworkEntries.find((candidate) => candidate.id === instance.artworkEntryId);
      if (!entry) throw new Error(`实例 ${instance.id} 的素材入口不存在`);
      const existing = sources.get(entry.contentSourceId);
      if (existing && existing.sourceIdentity !== sourceIdentity) {
        throw new Error(`登记为共享的内容源 ${entry.contentSourceId} 在 Photoshop 中并未共享`);
      }
      const owner = identityOwners.get(sourceIdentity);
      if (owner && owner !== entry.contentSourceId) {
        throw new Error(`登记为独立的内容源 ${owner} 与 ${entry.contentSourceId} 实际发生联动`);
      }
      identityOwners.set(sourceIdentity, entry.contentSourceId);
      if (!existing) sources.set(entry.contentSourceId, { entry, layerId: layer.id, sourceIdentity });
      signatures.push(
        `${instance.id}:${instance.layerPath.join("/")}:${layer.id}:${sourceIdentity}:${descriptorStructureSignature(descriptor)}`,
      );
    }
    return {
      documentId: document.id,
      sources,
      structureSignature: signatures.sort().join("|"),
    };
  }

  createScope(runId: string): ExecutionScope {
    this.sequence += 1;
    return {
      scopeId: `${runId}-photoshop-${this.sequence}`,
      runId,
      documents: { contentDocumentIds: [] },
      temporaryLocations: [],
    };
  }

  async createWorkCopy(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.assertCapability();
    ensureNotCancelled(cancellation);
    const masterFile = await this.masterResolver.resolve(template.masterSourceRef, template.masterFingerprint);
    await this.modal("创建母版工作副本", async (context) => {
      ensureModalNotCancelled(context, cancellation);
      const before = new Set(this.runtime.app.documents.map((document) => document.id));
      const master = await this.runtime.app.open(masterFile);
      if (before.has(master.id)) throw new Error("母版已经由用户打开，无法确认文档所有权，请先关闭后重试");
      scope.documents.masterDocumentId = master.id;
      await context.hostControl.registerAutoCloseDocument(master.id);
      if (!master.duplicate) throw new Error("当前 Photoshop 不支持复制未合并文档");
      const workCopy = await master.duplicate(`${template.templateId}-${scope.runId}`, false);
      scope.documents.workCopyDocumentId = workCopy.id;
      await context.hostControl.registerAutoCloseDocument(workCopy.id);
      assertDocumentSpec(workCopy, template);
      await closeDocument(master);
      await context.hostControl.unregisterAutoCloseDocument(workCopy.id);
    });
  }

  async resolveTemplate(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.assertCapability();
    await this.modal("重新解析模板结构", async (context) => {
      ensureModalNotCancelled(context, cancellation);
      const document = documentById(this.runtime, Number(scope.documents.workCopyDocumentId));
      const resolved = await this.resolveDocumentTemplate(document, template);
      this.resolvedScopes.set(scope.scopeId, resolved);
    });
  }

  async replaceArtwork(
    scope: ExecutionScope,
    assignments: ArtworkAssignment[],
    cancellation: CancellationToken,
  ): Promise<void> {
    this.assertCapability();
    const resolved = this.resolvedScopes.get(scope.scopeId);
    if (!resolved) throw new Error("工作副本尚未重新解析模板");
    for (const assignment of assignments) {
      ensureNotCancelled(cancellation);
      const source = resolved.sources.get(assignment.contentSourceId);
      if (!source) throw new Error(`工作副本中没有内容源 ${assignment.contentSourceId}`);
      const artworkFile = await this.artworkResolver.resolve(assignment.sourceRef, assignment.sourceFingerprint);
      await this.modal(`替换 ${source.entry.name}`, async (context) => {
        ensureModalNotCancelled(context, cancellation);
        const workDocument = documentById(this.runtime, resolved.documentId);
        this.runtime.app.activeDocument = workDocument;
        await this.selectLayer(workDocument.id, source.layerId);
        const beforeDocuments = new Set(this.runtime.app.documents.map((document) => document.id));
        const openResults = await this.runtime.action.batchPlay(
          [
            {
              _obj: "placedLayerEditContents",
              _options: { dialogOptions: "silent" },
            },
          ],
          {},
        );
        assertBatchPlayResults(openResults, "打开智能对象内容");
        const opened = this.runtime.app.documents.filter((document) => !beforeDocuments.has(document.id));
        if (opened.length !== 1) {
          throw new Error("智能对象内容未打开为唯一的新文档，已打开内容或复杂嵌套需要单独验证");
        }
        const contentDocument = opened[0];
        scope.documents.contentDocumentIds.push(contentDocument.id);
        await context.hostControl.registerAutoCloseDocument(contentDocument.id);
        const replacementLayers = contentDocument.layers.filter(
          (layer) => layer.name === source.entry.replacementLayerName,
        );
        if (replacementLayers.length !== 1) {
          throw new Error(`智能对象顶层必须有且仅有一个 ${source.entry.replacementLayerName} 图层`);
        }
        const oldLayer = replacementLayers[0];
        if (source.entry.fit.mode === "contain") {
          throw new Error("完整放入的背景渲染尚未通过 M0 验证，真实 Photoshop 入口暂不支持");
        }
        const documentWidth = numberValue(contentDocument.width, "智能对象画布宽度");
        const documentHeight = numberValue(contentDocument.height, "智能对象画布高度");
        if (documentWidth !== source.entry.canvas.width || documentHeight !== source.entry.canvas.height) {
          throw new Error("智能对象内部画布与登记尺寸不一致");
        }
        const smartObjectKind = this.runtime.constants.LayerKind?.SMARTOBJECT;
        for (const layer of contentDocument.layers) {
          if (layer.layers && layer.layers.length > 0) {
            throw new Error("智能对象内容包含未验证的嵌套图层组，已在置入素材前阻止");
          }
          if (layer !== oldLayer && smartObjectKind !== undefined && layer.kind === smartObjectKind) {
            throw new Error("智能对象内容包含额外嵌套智能对象，已在置入素材前阻止");
          }
        }
        const oldLayerDescriptor = await this.layerDescriptor(contentDocument.id, oldLayer.id);
        assertSimpleReplacementLayer(oldLayerDescriptor, source.entry.replacementLayerName);
        if (smartObjectKind !== undefined && oldLayer.kind === smartObjectKind) {
          descriptorSourceIdentity(oldLayerDescriptor);
        }
        const fixedLayerSignature = contentDocument.layers
          .filter((layer) => layer !== oldLayer)
          .map((layer) => `${layer.id}:${layer.name}:${String(layer.kind)}`)
          .join("|");
        await this.selectLayer(contentDocument.id, oldLayer.id);
        const existingLayerIds = new Set(contentDocument.layers.map((layer) => layer.id));
        const token = this.runtime.localFileSystem.createSessionToken(artworkFile);
        const placeResults = await this.runtime.action.batchPlay(
          [
            {
              _obj: "placeEvent",
              null: { _path: token, _kind: "local" },
              linked: false,
              _options: { dialogOptions: "silent" },
            },
          ],
          {},
        );
        assertBatchPlayResults(placeResults, "置入印花素材");
        ensureModalNotCancelled(context, cancellation);
        const placedLayers = contentDocument.layers.filter((layer) => !existingLayerIds.has(layer.id));
        if (placedLayers.length !== 1) throw new Error("置入素材后无法唯一识别新图层");
        const placedLayer = placedLayers[0];
        if (!placedLayer.boundsNoEffects || !placedLayer.scale || !placedLayer.translate) {
          throw new Error("当前 Photoshop 无法读取或变换置入素材边界");
        }
        const transform = calculateFitTransform(placedLayer.boundsNoEffects, source.entry.canvas, source.entry.fit);
        await placedLayer.scale(transform.scalePercent, transform.scalePercent);
        if (!placedLayer.boundsNoEffects) throw new Error("缩放后无法重读素材边界");
        const currentCenterX =
          (numberValue(placedLayer.boundsNoEffects.left, "素材左边界") +
            numberValue(placedLayer.boundsNoEffects.right, "素材右边界")) /
          2;
        const currentCenterY =
          (numberValue(placedLayer.boundsNoEffects.top, "素材上边界") +
            numberValue(placedLayer.boundsNoEffects.bottom, "素材下边界")) /
          2;
        await placedLayer.translate(
          transform.targetCenterX - currentCenterX,
          transform.targetCenterY - currentCenterY,
        );
        const placeBefore = this.runtime.constants.ElementPlacement?.PLACEBEFORE;
        if (!placedLayer.move || placeBefore === undefined) {
          throw new Error("当前 Photoshop 无法把新素材移动到原替换层位置");
        }
        await placedLayer.move(oldLayer, placeBefore);
        placedLayer.name = source.entry.replacementLayerName;
        if (!oldLayer.delete) throw new Error("当前 Photoshop 不支持删除旧素材层");
        await oldLayer.delete();
        const fixedLayerAfter = contentDocument.layers
          .filter((layer) => layer !== placedLayer)
          .map((layer) => `${layer.id}:${layer.name}:${String(layer.kind)}`)
          .join("|");
        if (fixedLayerAfter !== fixedLayerSignature) {
          throw new Error("置入素材时非替换图层的结构或顺序发生变化");
        }
        if (!contentDocument.save) throw new Error("当前 Photoshop 不支持保存智能对象内容");
        await contentDocument.save();
        await closeDocument(contentDocument);
        scope.documents.contentDocumentIds = scope.documents.contentDocumentIds.filter(
          (documentId) => Number(documentId) !== contentDocument.id,
        );
      });
    }
  }

  async validateStructure(
    scope: ExecutionScope,
    template: TemplateConfig,
    cancellation: CancellationToken,
  ): Promise<void> {
    this.assertCapability();
    await this.modal("校验工作副本结构", async (context) => {
      ensureModalNotCancelled(context, cancellation);
      const baseline = this.resolvedScopes.get(scope.scopeId);
      if (!baseline) throw new Error("缺少替换前结构基线");
      const document = documentById(this.runtime, Number(scope.documents.workCopyDocumentId));
      const current = await this.resolveDocumentTemplate(document, template);
      if (current.structureSignature !== baseline.structureSignature) {
        throw new Error("替换后智能对象路径、图层 ID 或共享关系发生变化");
      }
    });
  }

  async exportOutputs(
    scope: ExecutionScope,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    cancellation: CancellationToken,
  ): Promise<DraftOutput> {
    this.assertCapability();
    ensureNotCancelled(cancellation);
    const documentId = Number(scope.documents.workCopyDocumentId);
    if (!Number.isFinite(documentId)) throw new Error("缺少工作副本文档");
    return this.modal("导出本组预览与生产文件", async (context) => {
      ensureModalNotCancelled(context, cancellation);
      return this.outputPort.exportOutputs(
        scope,
        template,
        group,
        documentId,
        pluginVersion,
        this.runtime.hostVersion,
        context.hostControl,
      );
    });
  }

  async verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    cancellation: CancellationToken,
  ): Promise<VerifiedOutput> {
    this.assertCapability();
    ensureNotCancelled(cancellation);
    return this.modal("重读并验证全部输出", async (context) => {
      ensureModalNotCancelled(context, cancellation);
      return this.outputPort.verifyOutput(scope, output, taskFingerprint, context.hostControl);
    });
  }

  async commitResult(
    scope: ExecutionScope,
    output: VerifiedOutput,
    cancellation: CancellationToken,
  ): Promise<CommittedOutput> {
    this.assertCapability();
    ensureNotCancelled(cancellation);
    return this.outputPort.commitResult(scope, output);
  }

  async cleanup(scope: ExecutionScope): Promise<void> {
    const errors: string[] = [];
    try {
      await this.outputPort.cleanup(scope);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "输出临时文件清理失败");
    }
    try {
      await this.modal("清理插件临时文档", async () => {
        const ownedIds = [
          ...scope.documents.contentDocumentIds.map(Number).reverse(),
          scope.documents.workCopyDocumentId,
          scope.documents.masterDocumentId,
        ];
        const failedIds: Array<string | number> = [];
        for (const documentId of ownedIds) {
          const document = this.runtime.app.documents.find((candidate) => candidate.id === Number(documentId));
          if (!document) continue;
          try {
            await closeDocument(document);
          } catch (error) {
            failedIds.push(documentId!);
            errors.push(
              `关闭 ${document.name} 失败：${error instanceof Error ? error.message : "未知错误"}`,
            );
          }
        }
        scope.documents.contentDocumentIds = scope.documents.contentDocumentIds.filter((id) =>
          failedIds.some((failed) => Number(failed) === Number(id)),
        );
        if (!failedIds.some((id) => Number(id) === Number(scope.documents.workCopyDocumentId))) {
          scope.documents.workCopyDocumentId = undefined;
        }
        if (!failedIds.some((id) => Number(id) === Number(scope.documents.masterDocumentId))) {
          scope.documents.masterDocumentId = undefined;
        }
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Photoshop 临时文档清理失败");
    }
    if (errors.length === 0) {
      this.resolvedScopes.delete(scope.scopeId);
      scope.temporaryLocations.length = 0;
    }
    if (errors.length > 0) throw new Error(errors.join("；"));
  }
}
