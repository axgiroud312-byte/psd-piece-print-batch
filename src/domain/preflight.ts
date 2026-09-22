import type {
  ArtworkEntry,
  ArtworkInstance,
  FitAnchor,
  FitRule,
  GarmentPiece,
  GroupPreflight,
  InputFileSnapshot,
  OutputBackground,
  OutputIccPolicy,
  OutputRenderProfile,
  OutputTarget,
  PreflightIssue,
  PreflightPayload,
  PreflightReport,
  ProductionOutputTarget,
  TemplateConfig,
  TemplateOutputConfig,
} from "./types";

const supportedExtensions = new Set(["png", "jpg", "jpeg"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`字段 ${key} 必须是数组`);
  return value;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`字段 ${key} 必须是非空字符串`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`字段 ${key} 必须是有限数字`);
  }
  return value;
}

function optionalNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`字段 ${key} 必须是有限数字`);
  }
  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`字段 ${key} 必须是布尔值`);
  return value;
}

function requireRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!isRecord(value)) throw new Error(`字段 ${key} 必须是对象`);
  return value;
}

function uniqueIssues(
  values: { id: string; label: string }[],
): PreflightIssue[] {
  const seen = new Set<string>();
  const issues: PreflightIssue[] = [];
  for (const value of values) {
    const normalized = value.id.toLowerCase();
    if (seen.has(normalized)) {
      issues.push({
        severity: "error",
        code: "duplicate-id",
        message: `${value.label} ID 重复：${value.id}`,
      });
    }
    seen.add(normalized);
  }
  return issues;
}

function validateEntry(entry: ArtworkEntry): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const requiredStrings: Array<[string, string]> = [
    [entry.id, "素材入口 ID"],
    [entry.name, "素材入口名称"],
    [entry.inputKey, "输入名称"],
    [entry.contentSourceId, "内容源 ID"],
    [entry.replacementLayerName, "智能对象内部替换层名称"],
  ];
  for (const [value, label] of requiredStrings) {
    if (typeof value !== "string" || value.trim() === "") {
      issues.push({
        severity: "error",
        code: "invalid-entry",
        message: `${label}不能为空`,
      });
    }
  }

  if (!Number.isInteger(entry.canvas?.width) || entry.canvas.width <= 0) {
    issues.push({
      severity: "error",
      code: "invalid-canvas",
      message: `${entry.name} 的画布宽度无效`,
    });
  }
  if (!Number.isInteger(entry.canvas?.height) || entry.canvas.height <= 0) {
    issues.push({
      severity: "error",
      code: "invalid-canvas",
      message: `${entry.name} 的画布高度无效`,
    });
  }
  if (!entry.required && entry.optionalBehavior !== "keep-fixed") {
    issues.push({
      severity: "error",
      code: "missing-optional-behavior",
      message: `${entry.name} 是可选入口，必须声明缺图时保留固定内容`,
    });
  }
  if (!entry.fit || !["strict", "cover", "contain"].includes(entry.fit.mode)) {
    issues.push({
      severity: "error",
      code: "invalid-fit",
      message: `${entry.name} 的素材适配模式无效`,
    });
  } else if (entry.fit.mode === "contain") {
    if (
      entry.fit.allowBlankArea !== true ||
      entry.fit.background.trim() === ""
    ) {
      issues.push({
        severity: "error",
        code: "unsafe-contain",
        message: `${entry.name} 使用完整放入时必须允许空白并声明底色`,
      });
    }
  }
  if (entry.fit?.anchor?.kind === "offset") {
    if (
      !Number.isFinite(entry.fit.anchor.x) ||
      !Number.isFinite(entry.fit.anchor.y)
    ) {
      issues.push({
        severity: "error",
        code: "invalid-anchor",
        message: `${entry.name} 的固定偏移无效`,
      });
    }
  } else if (entry.fit?.anchor?.kind !== "center") {
    issues.push({
      severity: "error",
      code: "invalid-anchor",
      message: `${entry.name} 的锚点无效`,
    });
  }
  return issues;
}

const outputExtensions = {
  png: "png",
  jpeg: "jpg",
  psd: "psd",
  psb: "psb",
} as const;

function invalidOutputFileName(fileName: string): boolean {
  const normalized = fileName.toLowerCase();
  return (
    fileName.trim() !== fileName ||
    fileName === "." ||
    fileName === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(fileName) ||
    /[. ]$/.test(fileName) ||
    normalized === "result.json"
  );
}

function validateOutputTarget(
  target: OutputTarget,
  label: string,
  document: TemplateConfig["document"],
): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  const editable =
    "productionKind" in target &&
    target.productionKind === "editable-work-copy";
  if (
    !target?.id?.trim() ||
    !target.fileName?.trim() ||
    invalidOutputFileName(target.fileName)
  ) {
    issues.push({
      severity: "error",
      code: "invalid-output-name",
      message: `${label} 的 ID 或文件名无效`,
    });
  }
  const region = target?.region;
  if (
    !region ||
    !Number.isSafeInteger(region.x) ||
    !Number.isSafeInteger(region.y) ||
    region.x < 0 ||
    region.y < 0 ||
    !Number.isSafeInteger(region.width) ||
    !Number.isSafeInteger(region.height) ||
    region.width <= 0 ||
    region.height <= 0
  ) {
    issues.push({
      severity: "error",
      code: "invalid-output-region",
      message: `${label} 的固定导出区域无效`,
    });
  } else if (
    document &&
    (region.x + region.width > document.width ||
      region.y + region.height > document.height)
  ) {
    issues.push({
      severity: "error",
      code: "output-region-outside-document",
      message: `${label} 的固定区域超出母版画布`,
    });
  }
  const invalidVisiblePaths =
    !Array.isArray(target?.visibleLayerPaths) ||
    (!editable && target.visibleLayerPaths.length === 0) ||
    target.visibleLayerPaths.some(
      (path) =>
        !Array.isArray(path) ||
        path.length === 0 ||
        path.some((part) => !part?.trim()),
    );
  if (invalidVisiblePaths) {
    issues.push({
      severity: "error",
      code: "invalid-output-visibility",
      message: `${label} 必须声明非空可见图层路径`,
    });
  }
  if (
    !Array.isArray(target?.markLayerPaths) ||
    target.markLayerPaths.some(
      (path) =>
        !Array.isArray(path) ||
        path.length === 0 ||
        path.some((part) => !part?.trim()),
    )
  ) {
    issues.push({
      severity: "error",
      code: "invalid-output-marks",
      message: `${label} 的工艺标记图层路径无效`,
    });
  }
  if (
    !Number.isSafeInteger(target?.maximumFileBytes) ||
    target.maximumFileBytes <= 0
  ) {
    issues.push({
      severity: "error",
      code: "output-file-limit",
      message: `${label} 必须声明正整数文件大小上限`,
    });
  }

  const profile = target?.profile;
  const format = profile?.format;
  const expectedExtension = format ? outputExtensions[format] : undefined;
  const actualExtension = target?.fileName?.split(".").pop()?.toLowerCase();
  if (
    !expectedExtension ||
    (actualExtension !== expectedExtension &&
      !(format === "jpeg" && actualExtension === "jpeg"))
  ) {
    issues.push({
      severity: "error",
      code: "output-extension",
      message: `${label} 的扩展名与格式不一致`,
    });
  }
  const validCompression =
    (format === "png" && profile?.compression === "lossless") ||
    (format === "jpeg" && profile?.compression === "jpeg-high") ||
    ((format === "psd" || format === "psb") &&
      profile?.compression === "photoshop");
  if (!validCompression) {
    issues.push({
      severity: "error",
      code: "output-compression",
      message: `${label} 的格式与压缩组合无效`,
    });
  }
  if (
    !profile ||
    !Number.isFinite(profile.ppi) ||
    profile.ppi <= 0 ||
    !["rgb", "cmyk"].includes(profile.colorMode) ||
    ![8, 16].includes(profile.bitDepth)
  ) {
    issues.push({
      severity: "error",
      code: "output-metadata",
      message: `${label} 的 PPI、色彩模式或位深无效`,
    });
  }
  if (
    !profile?.icc ||
    !["none", "embed"].includes(profile.icc.mode) ||
    (profile.icc.mode === "embed" && !profile.icc.profile?.trim())
  ) {
    issues.push({
      severity: "error",
      code: "output-icc",
      message: `${label} 的 ICC 规则无效`,
    });
  }
  if (
    !profile?.background ||
    !["transparent", "solid"].includes(profile.background.kind) ||
    (profile.background.kind === "solid" &&
      !profile.background.color?.trim()) ||
    (format === "jpeg" && profile.background.kind !== "solid")
  ) {
    issues.push({
      severity: "error",
      code: "output-background",
      message: `${label} 的透明或底色规则无效`,
    });
  }
  if (
    typeof profile?.includeGuides !== "boolean" ||
    typeof profile.includeMarks !== "boolean"
  ) {
    issues.push({
      severity: "error",
      code: "output-marks",
      message: `${label} 必须明确辅助线和工艺标记规则`,
    });
  }
  return issues;
}

function validateOutputConfig(template: TemplateConfig): PreflightIssue[] {
  const output = template.output;
  if (
    !output?.capabilityProfileId?.trim() ||
    !["pieces", "combined", "pieces-and-combined"].includes(
      output.productionMode,
    ) ||
    !output.preview ||
    !Array.isArray(output.production)
  ) {
    return [
      {
        severity: "error",
        code: "output-config",
        message: "模板必须声明输出能力、预览和生产配置",
      },
    ];
  }
  const issues = [
    ...validateOutputTarget(output.preview, "预览输出", template.document),
    ...output.production.flatMap((target) =>
      validateOutputTarget(
        target,
        `生产输出 ${target?.id ?? "未知"}`,
        template.document,
      ),
    ),
  ];
  const allTargets = [output.preview, ...output.production];
  issues.push(
    ...uniqueIssues(
      allTargets.map((target) => ({ id: target.id, label: "输出目标" })),
    ),
    ...uniqueIssues(
      allTargets.map((target) => ({
        id: target.fileName,
        label: "输出文件名",
      })),
    ),
  );
  const pieceIds = new Set(template.garmentPieces.map((piece) => piece.id));
  const outputPieces = new Set<string>();
  let combinedCount = 0;
  for (const target of output.production) {
    if (target.productionKind === "piece") {
      if (!pieceIds.has(target.garmentPieceId)) {
        issues.push({
          severity: "error",
          code: "unknown-output-piece",
          message: `生产输出 ${target.id} 引用了不存在的裁片 ${target.garmentPieceId}`,
        });
      }
      if (outputPieces.has(target.garmentPieceId)) {
        issues.push({
          severity: "error",
          code: "duplicate-output-piece",
          message: `裁片 ${target.garmentPieceId} 有重复生产输出`,
        });
      }
      outputPieces.add(target.garmentPieceId);
    } else if (target.productionKind === "combined") {
      combinedCount += 1;
    } else if (target.productionKind === "editable-work-copy") {
      if (target.profile.format !== "psd" && target.profile.format !== "psb") {
        issues.push({
          severity: "error",
          code: "editable-output-format",
          message: `可编辑工作副本 ${target.id} 必须使用 PSD 或 PSB`,
        });
      }
      if (
        target.preserveAllLayers !== true ||
        target.region.x !== 0 ||
        target.region.y !== 0 ||
        target.region.width !== template.document.width ||
        target.region.height !== template.document.height ||
        target.profile.ppi !== template.document.ppi ||
        target.profile.colorMode !== template.document.colorMode ||
        target.profile.bitDepth !== template.document.bitDepth ||
        (template.document.iccProfile === null
          ? target.profile.icc.mode !== "none"
          : target.profile.icc.mode !== "embed" ||
            target.profile.icc.profile !== template.document.iccProfile) ||
        target.profile.includeGuides !== true ||
        target.profile.includeMarks !== true ||
        target.visibleLayerPaths.length !== 0 ||
        target.markLayerPaths.length !== 0
      ) {
        issues.push({
          severity: "error",
          code: "editable-output-contract",
          message: `可编辑工作副本 ${target.id} 必须保留完整画布、分辨率、图层、辅助线和标记`,
        });
      }
    }
  }
  if (
    output.productionMode === "pieces" ||
    output.productionMode === "pieces-and-combined"
  ) {
    for (const piece of template.garmentPieces) {
      if (!outputPieces.has(piece.id)) {
        issues.push({
          severity: "error",
          code: "missing-output-piece",
          message: `裁片 ${piece.name} 缺少生产输出`,
        });
      }
    }
  }
  if (
    (output.productionMode === "combined" ||
      output.productionMode === "pieces-and-combined") &&
    combinedCount === 0
  ) {
    issues.push({
      severity: "error",
      code: "missing-combined-output",
      message: "当前生产模式必须声明合版输出",
    });
  }
  if (output.productionMode === "combined" && outputPieces.size > 0) {
    issues.push({
      severity: "error",
      code: "unexpected-piece-output",
      message: "仅合版模式不能同时声明分片输出",
    });
  }
  if (output.productionMode === "pieces" && combinedCount > 0) {
    issues.push({
      severity: "error",
      code: "unexpected-combined-output",
      message: "仅分片模式不能同时声明合版输出",
    });
  }
  return issues;
}

export function validateTemplate(template: TemplateConfig): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  if (template.schemaVersion !== 2) {
    issues.push({
      severity: "error",
      code: "schema-version",
      message: "只支持模板结构版本 2",
    });
  }
  if (
    !template.templateId?.trim() ||
    !template.version?.trim() ||
    !template.masterFingerprint?.trim() ||
    !template.masterSourceRef?.trim()
  ) {
    issues.push({
      severity: "error",
      code: "template-identity",
      message: "模板编号、版本、母版指纹和母版来源引用都必须有明确值",
    });
  }
  if (
    !template.document ||
    !Number.isSafeInteger(template.document.width) ||
    !Number.isSafeInteger(template.document.height) ||
    template.document.width <= 0 ||
    template.document.height <= 0 ||
    !Number.isFinite(template.document.ppi) ||
    template.document.ppi <= 0 ||
    !["rgb", "cmyk"].includes(template.document.colorMode) ||
    ![8, 16].includes(template.document.bitDepth) ||
    (template.document.iccProfile !== null &&
      (typeof template.document.iccProfile !== "string" ||
        template.document.iccProfile.trim() === ""))
  ) {
    issues.push({
      severity: "error",
      code: "document-spec",
      message: "母版像素尺寸、PPI、色彩模式和位深必须明确有效",
    });
  }
  if (
    template.garmentPieces.length === 0 ||
    template.artworkEntries.length === 0 ||
    template.instances.length === 0
  ) {
    issues.push({
      severity: "error",
      code: "empty-template",
      message: "模板必须至少包含一个裁片、一个素材入口和一个实例",
    });
  }

  issues.push(
    ...uniqueIssues(
      template.garmentPieces.map((piece) => ({ id: piece.id, label: "裁片" })),
    ),
    ...uniqueIssues(
      template.artworkEntries.map((entry) => ({
        id: entry.id,
        label: "素材入口",
      })),
    ),
    ...uniqueIssues(
      template.instances.map((instance) => ({
        id: instance.id,
        label: "实例",
      })),
    ),
  );
  for (const entry of template.artworkEntries)
    issues.push(...validateEntry(entry));
  issues.push(...validateOutputConfig(template));

  const pieceIds = new Set(template.garmentPieces.map((piece) => piece.id));
  const entryIds = new Set(template.artworkEntries.map((entry) => entry.id));
  const referencedEntries = new Set<string>();
  const paths = new Map<string, ArtworkInstance>();
  for (const instance of template.instances) {
    referencedEntries.add(instance.artworkEntryId);
    if (!pieceIds.has(instance.garmentPieceId)) {
      issues.push({
        severity: "error",
        code: "unknown-piece",
        message: `实例 ${instance.id} 引用了不存在的裁片 ${instance.garmentPieceId}`,
      });
    }
    if (!entryIds.has(instance.artworkEntryId)) {
      issues.push({
        severity: "error",
        code: "unknown-entry",
        message: `实例 ${instance.id} 引用了不存在的素材入口 ${instance.artworkEntryId}`,
      });
    }
    if (!Array.isArray(instance.layerPath) || instance.layerPath.length === 0) {
      issues.push({
        severity: "error",
        code: "missing-layer-path",
        message: `实例 ${instance.id} 缺少完整图层路径`,
      });
    } else {
      const normalizedPath = instance.layerPath
        .map((part) => part.toLowerCase())
        .join("/");
      const existing = paths.get(normalizedPath);
      if (existing) {
        issues.push({
          severity: "error",
          code: "duplicate-layer-path",
          message: `实例 ${existing.id} 与 ${instance.id} 指向同一图层路径`,
        });
      } else {
        paths.set(normalizedPath, instance);
      }
    }
  }
  for (const entry of template.artworkEntries) {
    if (!referencedEntries.has(entry.id)) {
      issues.push({
        severity: "error",
        code: "entry-without-instance",
        message: `素材入口 ${entry.name} 没有绑定任何实例`,
      });
    }
  }

  const contentSources = new Map<string, ArtworkEntry>();
  for (const entry of template.artworkEntries) {
    const existing = contentSources.get(entry.contentSourceId);
    if (!existing) {
      contentSources.set(entry.contentSourceId, entry);
      continue;
    }
    if (existing.inputKey.toLowerCase() !== entry.inputKey.toLowerCase()) {
      issues.push({
        severity: "error",
        code: "shared-source-conflict",
        message: `共享内容源 ${entry.contentSourceId} 被分配了不同输入：${existing.inputKey} 与 ${entry.inputKey}`,
      });
    }
    if (
      existing.canvas.width !== entry.canvas.width ||
      existing.canvas.height !== entry.canvas.height
    ) {
      issues.push({
        severity: "error",
        code: "shared-canvas-conflict",
        message: `共享内容源 ${entry.contentSourceId} 的内部画布定义不一致`,
      });
    }
    if (
      existing.required !== entry.required ||
      existing.optionalBehavior !== entry.optionalBehavior ||
      existing.replacementLayerName !== entry.replacementLayerName ||
      JSON.stringify(existing.fit) !== JSON.stringify(entry.fit)
    ) {
      issues.push({
        severity: "error",
        code: "shared-rule-conflict",
        message: `共享内容源 ${entry.contentSourceId} 的必需状态或适配规则不一致`,
      });
    }
  }
  return issues;
}

function fileParts(fileName: string): { stem: string; extension: string } {
  const baseName = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  const separator = baseName.lastIndexOf(".");
  if (separator <= 0) return { stem: baseName.toLowerCase(), extension: "" };
  return {
    stem: baseName.slice(0, separator).toLowerCase(),
    extension: baseName.slice(separator + 1).toLowerCase(),
  };
}

function preflightGroup(
  template: TemplateConfig,
  templateIssues: PreflightIssue[],
  groupName: string,
  files: InputFileSnapshot[],
): GroupPreflight {
  const issues: PreflightIssue[] = [...templateIssues];
  const assignments: GroupPreflight["assignments"] = [];
  const assignedSources = new Set<string>();
  const supportedByStem = new Map<string, InputFileSnapshot[]>();
  const matchedNames = new Set<string>();

  for (const file of files) {
    const parts = fileParts(file.name);
    if (!supportedExtensions.has(parts.extension)) {
      issues.push({
        severity: "warning",
        code: "unsupported-file",
        message: `未配置或不支持的文件：${file.name}`,
        fileName: file.name,
      });
      continue;
    }
    const matches = supportedByStem.get(parts.stem) ?? [];
    matches.push(file);
    supportedByStem.set(parts.stem, matches);
  }

  for (const entry of template.artworkEntries) {
    const matches = supportedByStem.get(entry.inputKey.toLowerCase()) ?? [];
    if (matches.length === 0) {
      issues.push({
        severity: entry.required ? "error" : "info",
        code: entry.required ? "missing-required" : "optional-fixed",
        message: entry.required
          ? `缺少必需素材 ${entry.inputKey}`
          : `未提供可选素材 ${entry.inputKey}，将保留登记的固定内容`,
        entryId: entry.id,
      });
      continue;
    }
    if (matches.length > 1) {
      issues.push({
        severity: "error",
        code: "duplicate-match",
        message: `${entry.inputKey} 同时匹配 ${matches.map((match) => match.name).join("、")}`,
        entryId: entry.id,
      });
      for (const match of matches) matchedNames.add(match.name);
      continue;
    }

    const file = matches[0];
    matchedNames.add(file.name);
    if (file.metadataError) {
      issues.push({
        severity: "error",
        code: "unreadable-metadata",
        message: `${file.name} 无法读取图像尺寸：${file.metadataError}`,
        entryId: entry.id,
        fileName: file.name,
      });
      continue;
    }
    if (!file.sourceRef?.trim() || !file.fingerprint?.trim()) {
      issues.push({
        severity: "error",
        code: "missing-source-identity",
        message: `${file.name} 缺少来源引用或内容指纹，请重新扫描素材目录`,
        entryId: entry.id,
        fileName: file.name,
      });
      continue;
    }
    if (
      !Number.isInteger(file.width) ||
      !Number.isInteger(file.height) ||
      file.width! <= 0 ||
      file.height! <= 0
    ) {
      issues.push({
        severity: "error",
        code: "missing-dimensions",
        message: `${file.name} 缺少有效的像素尺寸`,
        entryId: entry.id,
        fileName: file.name,
      });
      continue;
    }
    if (entry.fit.mode === "strict") {
      if (
        file.width !== entry.canvas.width ||
        file.height !== entry.canvas.height
      ) {
        issues.push({
          severity: "error",
          code: "strict-size-mismatch",
          message: `${file.name} 为 ${file.width}×${file.height}，要求 ${entry.canvas.width}×${entry.canvas.height}`,
          entryId: entry.id,
          fileName: file.name,
        });
        continue;
      }
    }
    if (entry.fit.anchor.kind === "offset") {
      const scale =
        entry.fit.mode === "contain"
          ? Math.min(
              entry.canvas.width / file.width!,
              entry.canvas.height / file.height!,
            )
          : Math.max(
              entry.canvas.width / file.width!,
              entry.canvas.height / file.height!,
            );
      const scaledWidth = file.width! * scale;
      const scaledHeight = file.height! * scale;
      const maxX = Math.max(0, Math.abs(scaledWidth - entry.canvas.width) / 2);
      const maxY = Math.max(
        0,
        Math.abs(scaledHeight - entry.canvas.height) / 2,
      );
      if (
        Math.abs(entry.fit.anchor.x) > maxX ||
        Math.abs(entry.fit.anchor.y) > maxY
      ) {
        issues.push({
          severity: "error",
          code: "offset-out-of-range",
          message: `${entry.name} 的固定偏移超出可用范围（横向 ±${maxX.toFixed(2)}，纵向 ±${maxY.toFixed(2)}）`,
          entryId: entry.id,
          fileName: file.name,
        });
        continue;
      }
    }
    if (!assignedSources.has(entry.contentSourceId)) {
      assignments.push({
        entryId: entry.id,
        contentSourceId: entry.contentSourceId,
        fileName: file.name,
        sourceRef: file.sourceRef,
        sourceFingerprint: file.fingerprint,
      });
      assignedSources.add(entry.contentSourceId);
    }
  }

  for (const file of files) {
    const parts = fileParts(file.name);
    if (
      supportedExtensions.has(parts.extension) &&
      !matchedNames.has(file.name)
    ) {
      issues.push({
        severity: "warning",
        code: "extra-file",
        message: `没有素材入口使用文件 ${file.name}`,
        fileName: file.name,
      });
    }
  }

  return {
    groupName,
    status: issues.some((issue) => issue.severity === "error")
      ? "invalid"
      : "valid",
    assignments,
    issues,
  };
}

export function preflightGroups(payload: PreflightPayload): PreflightReport {
  const templateIssues = validateTemplate(payload.template);
  const groups = payload.groups.map((group) =>
    preflightGroup(payload.template, templateIssues, group.name, group.files),
  );
  return {
    templateIssues,
    templateSummary: {
      garmentPieceCount: payload.template.garmentPieces.length,
      artworkEntryCount: payload.template.artworkEntries.length,
      instanceCount: payload.template.instances.length,
      mappings: payload.template.instances.map((instance) => {
        const piece = payload.template.garmentPieces.find(
          (item) => item.id === instance.garmentPieceId,
        );
        const entry = payload.template.artworkEntries.find(
          (item) => item.id === instance.artworkEntryId,
        );
        return `${piece?.name ?? instance.garmentPieceId} ← ${entry?.name ?? instance.artworkEntryId} · ${instance.layerPath.join("/")}`;
      }),
    },
    groups,
    validGroupCount: groups.filter((group) => group.status === "valid").length,
    invalidGroupCount: groups.filter((group) => group.status === "invalid")
      .length,
  };
}

function parseAnchor(value: unknown): FitAnchor {
  if (!isRecord(value)) throw new Error("素材适配锚点必须是对象");
  const kind = requireString(value, "kind");
  if (kind === "center") return { kind };
  if (kind === "offset") {
    return { kind, x: requireNumber(value, "x"), y: requireNumber(value, "y") };
  }
  throw new Error(`不支持的锚点：${kind}`);
}

function parseFit(value: unknown): FitRule {
  if (!isRecord(value)) throw new Error("素材适配规则必须是对象");
  const mode = requireString(value, "mode");
  const anchor = parseAnchor(value.anchor);
  if (mode === "strict" || mode === "cover") return { mode, anchor };
  if (mode === "contain") {
    if (requireBoolean(value, "allowBlankArea") !== true) {
      throw new Error("完整放入必须明确允许空白区域");
    }
    return {
      mode,
      anchor,
      allowBlankArea: true,
      background: requireString(value, "background"),
    };
  }
  throw new Error(`不支持的素材适配模式：${mode}`);
}

function parseGarmentPiece(value: unknown): GarmentPiece {
  if (!isRecord(value)) throw new Error("裁片必须是对象");
  return { id: requireString(value, "id"), name: requireString(value, "name") };
}

function parseArtworkEntry(value: unknown): ArtworkEntry {
  if (!isRecord(value)) throw new Error("素材入口必须是对象");
  const canvas = requireRecord(value, "canvas");
  const required = requireBoolean(value, "required");
  const optionalBehavior = value.optionalBehavior;
  if (optionalBehavior !== undefined && optionalBehavior !== "keep-fixed") {
    throw new Error("可选入口行为只支持 keep-fixed");
  }
  return {
    id: requireString(value, "id"),
    name: requireString(value, "name"),
    inputKey: requireString(value, "inputKey"),
    contentSourceId: requireString(value, "contentSourceId"),
    replacementLayerName: requireString(value, "replacementLayerName"),
    required,
    optionalBehavior,
    canvas: {
      width: requireNumber(canvas, "width"),
      height: requireNumber(canvas, "height"),
    },
    fit: parseFit(value.fit),
  };
}

function parseArtworkInstance(value: unknown): ArtworkInstance {
  if (!isRecord(value)) throw new Error("实例必须是对象");
  const layerPath = requireArray(value, "layerPath").map((part) => {
    if (typeof part !== "string" || part.trim() === "")
      throw new Error("图层路径必须由非空字符串组成");
    return part;
  });
  return {
    id: requireString(value, "id"),
    garmentPieceId: requireString(value, "garmentPieceId"),
    artworkEntryId: requireString(value, "artworkEntryId"),
    layerPath,
  };
}

function requireOneOf<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T {
  const value = requireString(record, key);
  if (!allowed.includes(value as T))
    throw new Error(`字段 ${key} 的值不受支持：${value}`);
  return value as T;
}

function parseOutputIcc(value: unknown): OutputIccPolicy {
  if (!isRecord(value)) throw new Error("ICC 规则必须是对象");
  const mode = requireOneOf(value, "mode", ["none", "embed"] as const);
  return mode === "embed"
    ? { mode, profile: requireString(value, "profile") }
    : { mode };
}

function parseOutputBackground(value: unknown): OutputBackground {
  if (!isRecord(value)) throw new Error("输出背景规则必须是对象");
  const kind = requireOneOf(value, "kind", ["transparent", "solid"] as const);
  return kind === "solid"
    ? { kind, color: requireString(value, "color") }
    : { kind };
}

function parseOutputProfile(value: unknown): OutputRenderProfile {
  if (!isRecord(value)) throw new Error("输出配置必须是对象");
  const bitDepth = requireNumber(value, "bitDepth");
  if (bitDepth !== 8 && bitDepth !== 16)
    throw new Error("输出位深只支持 8 或 16");
  return {
    format: requireOneOf(value, "format", [
      "png",
      "jpeg",
      "psd",
      "psb",
    ] as const),
    compression: requireOneOf(value, "compression", [
      "lossless",
      "jpeg-high",
      "photoshop",
    ] as const),
    ppi: requireNumber(value, "ppi"),
    colorMode: requireOneOf(value, "colorMode", ["rgb", "cmyk"] as const),
    bitDepth,
    icc: parseOutputIcc(value.icc),
    background: parseOutputBackground(value.background),
    includeGuides: requireBoolean(value, "includeGuides"),
    includeMarks: requireBoolean(value, "includeMarks"),
  };
}

function parseOutputTarget(value: unknown): OutputTarget {
  if (!isRecord(value)) throw new Error("输出目标必须是对象");
  const region = requireRecord(value, "region");
  const visibleLayerPaths = requireArray(value, "visibleLayerPaths").map(
    (path) => {
      if (!Array.isArray(path) || path.length === 0)
        throw new Error("可见图层路径必须是非空数组");
      return path.map((part) => {
        if (typeof part !== "string" || part.trim() === "")
          throw new Error("可见图层路径必须由非空字符串组成");
        return part;
      });
    },
  );
  const markLayerPaths = requireArray(value, "markLayerPaths").map((path) => {
    if (!Array.isArray(path) || path.length === 0)
      throw new Error("工艺标记图层路径必须是非空数组");
    return path.map((part) => {
      if (typeof part !== "string" || part.trim() === "")
        throw new Error("工艺标记图层路径必须由非空字符串组成");
      return part;
    });
  });
  return {
    id: requireString(value, "id"),
    fileName: requireString(value, "fileName"),
    region: {
      x: requireNumber(region, "x"),
      y: requireNumber(region, "y"),
      width: requireNumber(region, "width"),
      height: requireNumber(region, "height"),
    },
    visibleLayerPaths,
    markLayerPaths,
    maximumFileBytes: requireNumber(value, "maximumFileBytes"),
    profile: parseOutputProfile(value.profile),
  };
}

function parseProductionOutputTarget(value: unknown): ProductionOutputTarget {
  if (!isRecord(value)) throw new Error("生产输出目标必须是对象");
  const productionKind = requireOneOf(value, "productionKind", [
    "piece",
    "combined",
    "editable-work-copy",
  ] as const);
  if (productionKind === "piece") {
    return {
      ...parseOutputTarget(value),
      productionKind,
      garmentPieceId: requireString(value, "garmentPieceId"),
    };
  }
  if (productionKind === "editable-work-copy") {
    if (requireBoolean(value, "preserveAllLayers") !== true)
      throw new Error("可编辑工作副本必须保留全部图层");
    return {
      ...parseOutputTarget(value),
      productionKind,
      preserveAllLayers: true,
    };
  }
  return { ...parseOutputTarget(value), productionKind };
}

function parseTemplateOutput(value: unknown): TemplateOutputConfig {
  if (!isRecord(value)) throw new Error("模板输出配置必须是对象");
  return {
    capabilityProfileId: requireString(value, "capabilityProfileId"),
    productionMode: requireOneOf(value, "productionMode", [
      "pieces",
      "combined",
      "pieces-and-combined",
    ] as const),
    preview: parseOutputTarget(value.preview),
    production: requireArray(value, "production").map(
      parseProductionOutputTarget,
    ),
  };
}

function parseTemplateDocument(value: unknown): TemplateConfig["document"] {
  if (!isRecord(value)) throw new Error("母版文档规格必须是对象");
  const bitDepth = requireNumber(value, "bitDepth");
  if (bitDepth !== 8 && bitDepth !== 16)
    throw new Error("母版位深只支持 8 或 16");
  const iccProfile = value.iccProfile;
  if (
    iccProfile !== null &&
    (typeof iccProfile !== "string" || iccProfile.trim() === "")
  ) {
    throw new Error("母版 ICC 必须是非空字符串或 null");
  }
  return {
    width: requireNumber(value, "width"),
    height: requireNumber(value, "height"),
    ppi: requireNumber(value, "ppi"),
    colorMode: requireOneOf(value, "colorMode", ["rgb", "cmyk"] as const),
    bitDepth,
    iccProfile,
  };
}

function parseInputFile(value: unknown): InputFileSnapshot {
  if (!isRecord(value)) throw new Error("素材文件必须是对象");
  const width = optionalNumber(value, "width");
  const height = optionalNumber(value, "height");
  const ppi = optionalNumber(value, "ppi");
  const sourceRef = value.sourceRef;
  const fingerprint = value.fingerprint;
  const metadataError = value.metadataError;
  if (
    fingerprint !== undefined &&
    (typeof fingerprint !== "string" || fingerprint.trim() === "")
  ) {
    throw new Error("字段 fingerprint 必须是非空字符串");
  }
  if (
    sourceRef !== undefined &&
    (typeof sourceRef !== "string" || sourceRef.trim() === "")
  ) {
    throw new Error("字段 sourceRef 必须是非空字符串");
  }
  if (metadataError !== undefined && typeof metadataError !== "string") {
    throw new Error("字段 metadataError 必须是字符串");
  }
  return {
    name: requireString(value, "name"),
    width,
    height,
    ppi,
    sourceRef,
    fingerprint,
    metadataError,
  };
}

function parseTemplateRecord(
  template: Record<string, unknown>,
): TemplateConfig {
  const schemaVersion = requireNumber(template, "schemaVersion");
  if (schemaVersion !== 2) throw new Error("只支持模板结构版本 2");
  return {
    schemaVersion,
    templateId: requireString(template, "templateId"),
    version: requireString(template, "version"),
    masterFingerprint: requireString(template, "masterFingerprint"),
    masterSourceRef: requireString(template, "masterSourceRef"),
    document: parseTemplateDocument(template.document),
    garmentPieces: requireArray(template, "garmentPieces").map(
      parseGarmentPiece,
    ),
    artworkEntries: requireArray(template, "artworkEntries").map(
      parseArtworkEntry,
    ),
    instances: requireArray(template, "instances").map(parseArtworkInstance),
    output: parseTemplateOutput(template.output),
  };
}

function parseGroupsValue(groups: unknown): PreflightPayload["groups"] {
  if (!Array.isArray(groups)) throw new Error("素材清单必须是数组");
  return groups.map((group) => {
    if (!isRecord(group)) throw new Error("每个素材组都必须是对象");
    return {
      name: requireString(group, "name"),
      files: requireArray(group, "files").map(parseInputFile),
    };
  });
}

export function parseTemplateConfig(json: string): TemplateConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("模板配置不是有效的 JSON");
  }
  if (!isRecord(parsed)) throw new Error("模板配置必须是对象");
  return parseTemplateRecord(parsed);
}

export function parseInputGroups(json: string): PreflightPayload["groups"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("素材清单不是有效的 JSON");
  }
  return parseGroupsValue(parsed);
}

export function parsePreflightPayload(json: string): PreflightPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("清单不是有效的 JSON");
  }
  if (!isRecord(parsed) || !isRecord(parsed.template)) {
    throw new Error("清单必须包含 template 对象");
  }
  return {
    template: parseTemplateRecord(parsed.template),
    groups: parseGroupsValue(parsed.groups),
  };
}
