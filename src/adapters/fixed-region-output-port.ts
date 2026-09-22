import type {
  InputGroupSnapshot,
  OutputRenderProfile,
  OutputTarget,
  TemplateConfig,
} from "../domain/types";
import { fingerprintBytes, fingerprintValue } from "../workflow/fingerprint";
import type {
  BatchRecoveryPort,
  CommitReconciliation,
} from "../workflow/run-batch";
import type {
  CommittedOutput,
  DraftOutput,
  ExecutionScope,
  ModalDocumentControl,
  OutputArtifact,
  OutputArtifactExpectation,
  OutputArtifactMetadata,
  VerifiedOutput,
} from "../workflow/types";
import type { PhotoshopOutputPort } from "./photoshop-batch-adapter";

export interface OutputStorage {
  exists(location: string): Promise<boolean>;
  assertWritable(location: string): Promise<void>;
  ensureDirectory(location: string): Promise<void>;
  createExclusiveDirectory(location: string): Promise<void>;
  writeFile(location: string, bytes: Uint8Array): Promise<void>;
  readFile(location: string): Promise<Uint8Array>;
  removeFile(location: string): Promise<void>;
  listFiles(location: string): Promise<string[]>;
  promoteDirectoryExclusive(
    temporaryLocation: string,
    finalLocation: string,
  ): Promise<void>;
  removeDirectory(location: string): Promise<void>;
}

export interface FixedRegionRenderer {
  render(
    documentId: number,
    target: OutputTarget,
    kind: "preview" | "production",
    destination: string,
    documentControl?: ModalDocumentControl,
  ): Promise<void>;
  inspect(
    bytes: Uint8Array,
    fileName: string,
    location: string,
    expected: OutputArtifactMetadata,
    documentControl?: ModalDocumentControl,
  ): Promise<OutputArtifactMetadata>;
}

export interface OutputCombinationCapability {
  profile: OutputRenderProfile;
  maxWidth: number;
  maxHeight: number;
  maxEstimatedBytes: number;
  maxFileBytes: number;
}

export interface OutputCapabilityGate {
  m0Validated: boolean;
  atomicPromotionValidated: boolean;
  profileId: string;
  pluginVersion: string;
  implementationVersion: string;
  storageScopeId: string;
  documentSpecFingerprint: string;
  outputConfigFingerprint: string;
  masterFingerprints: string[];
  validatedSourceSetFingerprints: string[];
  combinations: OutputCombinationCapability[];
}

export const UNVERIFIED_OUTPUT_CAPABILITY: OutputCapabilityGate = {
  m0Validated: false,
  atomicPromotionValidated: false,
  profileId: "",
  pluginVersion: "",
  implementationVersion: "",
  storageScopeId: "",
  documentSpecFingerprint: "",
  outputConfigFingerprint: "",
  masterFingerprints: [],
  validatedSourceSetFingerprints: [],
  combinations: [],
};

export const OUTPUT_IMPLEMENTATION_VERSION = "fixed-region-output-v1";
const OWNERSHIP_FILE_NAME = ".psd-batch-owner.json";

interface OwnershipMarker {
  schemaVersion?: unknown;
  owner?: unknown;
  runId?: unknown;
  groupName?: unknown;
  taskFingerprint?: unknown;
  attemptId?: unknown;
  stagingLocation?: unknown;
}

export interface FixedRegionOutputPortOptions {
  outputRoot: string;
  storageScopeId: string;
  storage: OutputStorage;
  renderer: FixedRegionRenderer;
  capability?: OutputCapabilityGate;
  now?: () => string;
}

export class OutputCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutputCapabilityError";
  }
}

function joinLocation(parent: string, child: string): string {
  return `${parent.replace(/[\\/]+$/, "")}/${child}`;
}

function assertSafeSegment(value: string, label: string): void {
  const normalized = value.trim();
  const stem = normalized.split(".")[0].toLowerCase();
  if (
    normalized !== value ||
    normalized === "" ||
    normalized === "." ||
    normalized === ".." ||
    /[<>:"/\\|?*\u0000-\u001f]/.test(normalized) ||
    /[. ]$/.test(normalized) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(stem)
  ) {
    throw new Error(`${label} 不能安全用作输出目录或文件名：${value}`);
  }
}

function expectedMetadata(target: OutputTarget): OutputArtifactMetadata {
  return {
    format: target.profile.format,
    width: target.region.width,
    height: target.region.height,
    ppi: target.profile.ppi,
    colorMode: target.profile.colorMode,
    bitDepth: target.profile.bitDepth,
    iccProfile:
      target.profile.icc.mode === "embed" ? target.profile.icc.profile : null,
    background:
      target.profile.background.kind === "solid" ? "opaque" : "transparent",
    includesGuides: target.profile.includeGuides,
  };
}

function capabilityMatches(
  capability: OutputCombinationCapability,
  profile: OutputRenderProfile,
): boolean {
  return fingerprintValue(capability.profile) === fingerprintValue(profile);
}

function estimatedBytes(target: OutputTarget): number {
  return (
    target.region.width *
    target.region.height *
    4 *
    (target.profile.bitDepth / 8)
  );
}

function sourceSetFingerprint(
  template: TemplateConfig,
  group: InputGroupSnapshot,
): string {
  const keys = new Set(
    template.artworkEntries.map((entry) => entry.inputKey.toLowerCase()),
  );
  const sources = group.files
    .filter((file) => {
      const base = file.name.replace(/\\/g, "/").split("/").pop() ?? file.name;
      const separator = base.lastIndexOf(".");
      const stem = (
        separator > 0 ? base.slice(0, separator) : base
      ).toLowerCase();
      return keys.has(stem);
    })
    .map((file) => {
      if (!file.fingerprint?.trim())
        throw new OutputCapabilityError(
          `素材 ${file.name} 缺少输出能力校验指纹`,
        );
      return { name: file.name, fingerprint: file.fingerprint };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return fingerprintValue(sources);
}

function metadataDifference(
  expected: OutputArtifactMetadata,
  actual: OutputArtifactMetadata,
): string | undefined {
  if (
    !Number.isSafeInteger(actual.width) ||
    !Number.isSafeInteger(actual.height) ||
    actual.width <= 0 ||
    actual.height <= 0 ||
    !Number.isFinite(actual.ppi) ||
    actual.ppi <= 0 ||
    !["png", "jpeg", "psd", "psb"].includes(actual.format) ||
    !["rgb", "cmyk"].includes(actual.colorMode) ||
    ![8, 16].includes(actual.bitDepth) ||
    (actual.iccProfile !== null &&
      (typeof actual.iccProfile !== "string" ||
        actual.iccProfile.trim() === "")) ||
    !["transparent", "opaque"].includes(actual.background) ||
    typeof actual.includesGuides !== "boolean"
  ) {
    return "解码后的必要元数据无效或缺失";
  }
  const exactFields: Array<keyof OutputArtifactMetadata> = [
    "format",
    "width",
    "height",
    "colorMode",
    "bitDepth",
    "iccProfile",
    "background",
    "includesGuides",
  ];
  for (const field of exactFields) {
    if (actual[field] !== expected[field])
      return `${field} 应为 ${String(expected[field])}，实际为 ${String(actual[field])}`;
  }
  if (Math.abs(actual.ppi - expected.ppi) > 0.01)
    return `ppi 应为 ${expected.ppi}，实际为 ${actual.ppi}`;
  return undefined;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameNames(actual: string[], expected: string[]): boolean {
  const normalize = (values: string[]): string[] =>
    values.map((value) => value.toLowerCase()).sort();
  return (
    JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected))
  );
}

export class FixedRegionOutputPort
  implements PhotoshopOutputPort, BatchRecoveryPort
{
  private readonly capability: OutputCapabilityGate;
  private readonly now: () => string;
  private readonly ownedStaging = new Map<string, Set<string>>();
  private readonly ownedSidecars = new Map<string, Set<string>>();
  private readonly draftLimits = new Map<
    string,
    Map<string, OutputCombinationCapability>
  >();
  private readonly verifiedDrafts = new Map<string, string>();

  constructor(private readonly options: FixedRegionOutputPortOptions) {
    this.capability = options.capability ?? UNVERIFIED_OUTPUT_CAPABILITY;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private capabilityFor(target: OutputTarget): OutputCombinationCapability {
    const combination = this.capability.combinations.find((candidate) =>
      capabilityMatches(candidate, target.profile),
    );
    if (!combination) {
      throw new OutputCapabilityError(
        `输出组合未通过 M0：${target.profile.format}/${target.profile.colorMode}/${target.profile.bitDepth} 位/${target.profile.background.kind}`,
      );
    }
    const limits = [
      combination.maxWidth,
      combination.maxHeight,
      combination.maxEstimatedBytes,
      combination.maxFileBytes,
    ];
    if (limits.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
      throw new OutputCapabilityError("输出能力包含无效或无限制的大小上限");
    }
    if (
      target.region.width > combination.maxWidth ||
      target.region.height > combination.maxHeight ||
      estimatedBytes(target) > combination.maxEstimatedBytes ||
      estimatedBytes(target) > target.maximumFileBytes ||
      target.maximumFileBytes > combination.maxFileBytes
    ) {
      throw new OutputCapabilityError(
        `输出 ${target.fileName} 超过已验证的大文件限制`,
      );
    }
    return combination;
  }

  private assertCapability(
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
  ): void {
    if (
      !this.capability.m0Validated ||
      !this.capability.atomicPromotionValidated
    ) {
      throw new OutputCapabilityError(
        "输出格式组合与原子目录提升尚未通过 M0 验证",
      );
    }
    if (template.output.capabilityProfileId !== this.capability.profileId) {
      throw new OutputCapabilityError(
        `模板要求输出能力 ${template.output.capabilityProfileId}，当前仅验证 ${this.capability.profileId || "无"}`,
      );
    }
    if (
      pluginVersion !== this.capability.pluginVersion ||
      this.capability.implementationVersion !== OUTPUT_IMPLEMENTATION_VERSION
    ) {
      throw new OutputCapabilityError("插件或输出实现版本与 M0 验证版本不一致");
    }
    if (this.options.storageScopeId !== this.capability.storageScopeId) {
      throw new OutputCapabilityError(
        "当前输出目录或存储提供器未通过原子提交验证",
      );
    }
    if (
      fingerprintValue(template.document) !==
      this.capability.documentSpecFingerprint
    ) {
      throw new OutputCapabilityError("母版文档规格不在当前 M0 输出能力范围内");
    }
    if (
      fingerprintValue(template.output) !==
      this.capability.outputConfigFingerprint
    ) {
      throw new OutputCapabilityError("输出配置与 M0 验证配置不一致");
    }
    if (
      !this.capability.masterFingerprints.includes(template.masterFingerprint)
    ) {
      throw new OutputCapabilityError("母版指纹未包含在当前 M0 输出能力中");
    }
    if (
      !this.capability.validatedSourceSetFingerprints.includes(
        sourceSetFingerprint(template, group),
      )
    ) {
      throw new OutputCapabilityError(
        "当前素材集合未通过输出文件大小、重读与重开验证",
      );
    }
    for (const target of [
      template.output.preview,
      ...template.output.production,
    ])
      this.capabilityFor(target);
  }

  private own(scope: ExecutionScope, location: string): void {
    const locations = this.ownedStaging.get(scope.scopeId) ?? new Set<string>();
    locations.add(location);
    this.ownedStaging.set(scope.scopeId, locations);
    scope.temporaryLocations.push(location);
  }

  private ownSidecar(scope: ExecutionScope, location: string): void {
    const locations =
      this.ownedSidecars.get(scope.scopeId) ?? new Set<string>();
    locations.add(location);
    this.ownedSidecars.set(scope.scopeId, locations);
    scope.temporaryLocations.push(location);
  }

  private assertOwned(
    scope: ExecutionScope,
    output: DraftOutput | VerifiedOutput,
  ): void {
    if (!this.ownedStaging.get(scope.scopeId)?.has(output.temporaryLocation)) {
      throw new Error("输出暂存目录不属于当前执行作用域");
    }
  }

  private async markerMatchesScope(
    scope: ExecutionScope,
    markerLocation: string,
    stagingLocation: string,
  ): Promise<boolean> {
    if (!(await this.options.storage.exists(markerLocation))) return false;
    try {
      const marker = JSON.parse(
        new TextDecoder().decode(
          await this.options.storage.readFile(markerLocation),
        ),
      ) as OwnershipMarker;
      return (
        marker.schemaVersion === 1 &&
        marker.owner === "psd-piece-print-batch" &&
        marker.runId === scope.runId &&
        marker.taskFingerprint === scope.taskFingerprint &&
        marker.attemptId === scope.attemptId &&
        marker.stagingLocation === stagingLocation
      );
    } catch {
      return false;
    }
  }

  private plan(
    runId: string,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    attemptId: string,
  ) {
    this.assertCapability(template, group, pluginVersion);
    assertSafeSegment(runId, "运行编号");
    assertSafeSegment(group.name, "素材组名称");
    const targets: Array<{
      target: OutputTarget;
      kind: "preview" | "production";
    }> = [
      { target: template.output.preview, kind: "preview" },
      ...template.output.production.map((target) => ({
        target,
        kind: "production" as const,
      })),
    ];
    const names = new Set<string>();
    for (const { target } of targets) {
      assertSafeSegment(target.fileName, "输出文件名");
      const normalized = target.fileName.toLowerCase();
      if (
        normalized === "result.json" ||
        normalized === OWNERSHIP_FILE_NAME ||
        names.has(normalized)
      ) {
        throw new Error(`输出文件名冲突：${target.fileName}`);
      }
      names.add(normalized);
    }
    const runLocation = joinLocation(this.options.outputRoot, runId);
    return {
      targets,
      runLocation,
      finalLocation: joinLocation(runLocation, group.name),
      stagingLocation: joinLocation(
        runLocation,
        `.staging-${fingerprintValue({ runId, groupName: group.name, attemptId }).slice(0, 16)}`,
      ),
    };
  }

  async preflight(
    runId: string,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    pluginVersion: string,
    attemptId = fingerprintValue({
      runId,
      groupName: group.name,
      taskFingerprint: "direct",
    }),
    _taskFingerprint = "unavailable",
  ): Promise<void> {
    const plan = this.plan(runId, template, group, pluginVersion, attemptId);
    if (await this.options.storage.exists(plan.finalLocation)) {
      throw new Error(`输出目录已存在，禁止覆盖：${plan.finalLocation}`);
    }
    if (await this.options.storage.exists(plan.stagingLocation)) {
      throw new Error(`暂存目录冲突：${plan.stagingLocation}`);
    }
    await this.options.storage.assertWritable(plan.stagingLocation);
  }

  async exportOutputs(
    scope: ExecutionScope,
    template: TemplateConfig,
    group: InputGroupSnapshot,
    documentId: number,
    pluginVersion: string,
    photoshopVersion: string,
    documentControl?: ModalDocumentControl,
  ): Promise<DraftOutput> {
    await this.preflight(
      scope.runId,
      template,
      group,
      pluginVersion,
      scope.attemptId,
      scope.taskFingerprint,
    );
    const { targets, runLocation, finalLocation, stagingLocation } = this.plan(
      scope.runId,
      template,
      group,
      pluginVersion,
      scope.attemptId,
    );
    const ownershipLocation = joinLocation(
      stagingLocation,
      OWNERSHIP_FILE_NAME,
    );
    await this.options.storage.ensureDirectory(runLocation);
    await this.options.storage.createExclusiveDirectory(stagingLocation);
    this.own(scope, stagingLocation);
    await this.options.storage.writeFile(
      ownershipLocation,
      new TextEncoder().encode(
        JSON.stringify({
          schemaVersion: 1,
          owner: "psd-piece-print-batch",
          runId: scope.runId,
          groupName: group.name,
          taskFingerprint: scope.taskFingerprint,
          attemptId: scope.attemptId,
          stagingLocation,
        }),
      ),
    );
    this.ownSidecar(scope, ownershipLocation);
    this.draftLimits.set(
      stagingLocation,
      new Map(
        targets.map(({ target }) => [
          target.fileName.toLowerCase(),
          this.capabilityFor(target),
        ]),
      ),
    );

    const expectedArtifacts: OutputArtifactExpectation[] = [];
    for (const { target, kind } of targets) {
      await this.options.renderer.render(
        documentId,
        target,
        kind,
        joinLocation(stagingLocation, target.fileName),
        documentControl,
      );
      expectedArtifacts.push({
        targetId: target.id,
        name: target.fileName,
        kind,
        region: { ...target.region },
        visibleLayerPaths: target.visibleLayerPaths.map((path) => [...path]),
        markLayerPaths: target.markLayerPaths.map((path) => [...path]),
        maximumFileBytes: target.maximumFileBytes,
        renderProfile: structuredClone(target.profile),
        metadata: expectedMetadata(target),
      });
    }
    return {
      temporaryLocation: stagingLocation,
      ownershipLocation,
      finalLocation,
      groupName: group.name,
      capabilityProfileId: template.output.capabilityProfileId,
      expectedArtifacts,
      audit: {
        pluginVersion,
        outputImplementationVersion: OUTPUT_IMPLEMENTATION_VERSION,
        photoshopVersion,
        templateId: template.templateId,
        templateVersion: template.version,
        masterFingerprint: template.masterFingerprint,
        outputConfigFingerprint: fingerprintValue(template.output),
        sourceFingerprints: group.files
          .filter((file): file is typeof file & { fingerprint: string } =>
            Boolean(file.fingerprint),
          )
          .map((file) => ({ name: file.name, fingerprint: file.fingerprint }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      },
    };
  }

  async verifyOutput(
    scope: ExecutionScope,
    output: DraftOutput,
    taskFingerprint: string,
    documentControl?: ModalDocumentControl,
  ): Promise<VerifiedOutput> {
    this.assertOwned(scope, output);
    const expectedNames = output.expectedArtifacts.map(
      (artifact) => artifact.name,
    );
    const exportedNames = (
      await this.options.storage.listFiles(output.temporaryLocation)
    ).filter((name) => name.toLowerCase() !== OWNERSHIP_FILE_NAME);
    if (!sameNames(exportedNames, expectedNames))
      throw new Error("输出文件数量或名称与登记目标不一致");

    const artifacts: OutputArtifact[] = [];
    for (const expected of output.expectedArtifacts) {
      const location = joinLocation(output.temporaryLocation, expected.name);
      const bytes = await this.options.storage.readFile(location);
      if (bytes.byteLength === 0)
        throw new Error(`输出文件为空：${expected.name}`);
      const metadata = await this.options.renderer.inspect(
        bytes,
        expected.name,
        location,
        expected.metadata,
        documentControl,
      );
      const difference = metadataDifference(expected.metadata, metadata);
      if (difference)
        throw new Error(`输出 ${expected.name} 元数据不一致：${difference}`);
      const capability = this.draftLimits
        .get(output.temporaryLocation)
        ?.get(expected.name.toLowerCase());
      if (
        !capability ||
        bytes.byteLength > capability.maxFileBytes ||
        bytes.byteLength > expected.maximumFileBytes
      ) {
        throw new OutputCapabilityError(
          `输出 ${expected.name} 超过已验证的文件大小限制`,
        );
      }
      artifacts.push({
        name: expected.name,
        kind: expected.kind,
        fingerprint: fingerprintBytes(bytes),
        byteLength: bytes.byteLength,
        metadata,
      });
    }

    const report = {
      schemaVersion: 1,
      status: "verified",
      runId: scope.runId,
      groupName: output.groupName,
      taskFingerprint,
      capabilityProfileId: output.capabilityProfileId,
      verifiedAt: this.now(),
      audit: output.audit,
      outputs: output.expectedArtifacts.map((expected, index) => ({
        targetId: expected.targetId,
        kind: expected.kind,
        name: expected.name,
        fixedRegion: expected.region,
        physicalSizeMm: {
          width: (expected.metadata.width / expected.metadata.ppi) * 25.4,
          height: (expected.metadata.height / expected.metadata.ppi) * 25.4,
        },
        visibleLayerPaths: expected.visibleLayerPaths,
        markLayerPaths: expected.markLayerPaths,
        maximumFileBytes: expected.maximumFileBytes,
        renderProfile: expected.renderProfile,
        artifact: artifacts[index],
      })),
    };
    const reportBytes = new TextEncoder().encode(
      JSON.stringify(report, null, 2),
    );
    const reportLocation = joinLocation(
      output.temporaryLocation,
      "result.json",
    );
    await this.options.storage.writeFile(reportLocation, reportBytes);
    const rereadReport = await this.options.storage.readFile(reportLocation);
    if (!equalBytes(rereadReport, reportBytes))
      throw new Error("质量报告重读内容与写入内容不一致");
    let parsedReport: {
      status?: unknown;
      taskFingerprint?: unknown;
      outputs?: unknown;
    };
    try {
      parsedReport = JSON.parse(
        new TextDecoder().decode(rereadReport),
      ) as typeof parsedReport;
    } catch {
      throw new Error("质量报告无法重读解码");
    }
    if (
      parsedReport.status !== "verified" ||
      parsedReport.taskFingerprint !== taskFingerprint ||
      !Array.isArray(parsedReport.outputs) ||
      parsedReport.outputs.length !== artifacts.length
    ) {
      throw new Error("质量报告内容不完整");
    }
    const verifiedNames = (
      await this.options.storage.listFiles(output.temporaryLocation)
    ).filter((name) => name.toLowerCase() !== OWNERSHIP_FILE_NAME);
    if (!sameNames(verifiedNames, [...expectedNames, "result.json"])) {
      throw new Error("质量报告写入后的文件数量不正确");
    }
    artifacts.push({
      name: "result.json",
      kind: "report",
      fingerprint: fingerprintBytes(rereadReport),
      byteLength: rereadReport.byteLength,
    });
    this.verifiedDrafts.set(output.temporaryLocation, taskFingerprint);
    return { ...output, taskFingerprint, artifacts };
  }

  async commitResult(
    scope: ExecutionScope,
    output: VerifiedOutput,
  ): Promise<CommittedOutput> {
    this.assertOwned(scope, output);
    if (
      this.verifiedDrafts.get(output.temporaryLocation) !==
      output.taskFingerprint
    ) {
      throw new Error("输出尚未完成重读验证，禁止提交");
    }
    const committedNames = (
      await this.options.storage.listFiles(output.temporaryLocation)
    ).filter((name) => name.toLowerCase() !== OWNERSHIP_FILE_NAME);
    if (
      !sameNames(
        committedNames,
        output.artifacts.map((item) => item.name),
      )
    ) {
      throw new Error("验证后输出文件清单发生变化");
    }
    for (const artifact of output.artifacts) {
      const bytes = await this.options.storage.readFile(
        joinLocation(output.temporaryLocation, artifact.name),
      );
      if (
        bytes.byteLength !== artifact.byteLength ||
        fingerprintBytes(bytes) !== artifact.fingerprint
      ) {
        throw new Error(`验证后输出文件发生变化：${artifact.name}`);
      }
    }
    if (await this.options.storage.exists(output.finalLocation)) {
      throw new Error(`输出目录已存在，禁止覆盖：${output.finalLocation}`);
    }
    await this.options.storage.promoteDirectoryExclusive(
      output.temporaryLocation,
      output.finalLocation,
    );
    const finalOwnershipLocation = joinLocation(
      output.finalLocation,
      OWNERSHIP_FILE_NAME,
    );
    const sidecars = this.ownedSidecars.get(scope.scopeId);
    if (output.ownershipLocation && sidecars?.delete(output.ownershipLocation))
      sidecars.add(finalOwnershipLocation);
    this.ownedStaging.get(scope.scopeId)?.delete(output.temporaryLocation);
    this.draftLimits.delete(output.temporaryLocation);
    this.verifiedDrafts.delete(output.temporaryLocation);
    scope.temporaryLocations = scope.temporaryLocations
      .filter((location) => location !== output.temporaryLocation)
      .map((location) =>
        location === output.ownershipLocation
          ? finalOwnershipLocation
          : location,
      );
    return {
      location: output.finalLocation,
      artifacts: output.artifacts.map((artifact) => ({ ...artifact })),
    };
  }

  async cleanup(scope: ExecutionScope): Promise<void> {
    const locations = this.ownedStaging.get(scope.scopeId);
    const sidecars = this.ownedSidecars.get(scope.scopeId);
    if (!locations && !sidecars) return;
    const errors: string[] = [];
    for (const location of [...(locations ?? [])]) {
      try {
        const markerLocation = joinLocation(location, OWNERSHIP_FILE_NAME);
        if (!(await this.markerMatchesScope(scope, markerLocation, location))) {
          throw new Error(`无法证明暂存目录属于当前执行：${location}`);
        }
        await this.options.storage.removeDirectory(location);
        locations?.delete(location);
        this.draftLimits.delete(location);
        this.verifiedDrafts.delete(location);
        scope.temporaryLocations = scope.temporaryLocations.filter(
          (candidate) => candidate !== location,
        );
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : `无法清理 ${location}`,
        );
      }
    }
    for (const location of [...(sidecars ?? [])]) {
      try {
        if (await this.options.storage.exists(location)) {
          const marker = JSON.parse(
            new TextDecoder().decode(
              await this.options.storage.readFile(location),
            ),
          ) as OwnershipMarker;
          if (
            marker.schemaVersion !== 1 ||
            marker.owner !== "psd-piece-print-batch" ||
            marker.runId !== scope.runId ||
            marker.taskFingerprint !== scope.taskFingerprint ||
            marker.attemptId !== scope.attemptId
          ) {
            throw new Error(`无法证明所有权标记属于当前执行：${location}`);
          }
        }
        await this.options.storage.removeFile(location);
        sidecars?.delete(location);
        scope.temporaryLocations = scope.temporaryLocations.filter(
          (candidate) => candidate !== location,
        );
      } catch (error) {
        errors.push(
          error instanceof Error ? error.message : `无法清理 ${location}`,
        );
      }
    }
    if (!locations || locations.size === 0)
      this.ownedStaging.delete(scope.scopeId);
    if (!sidecars || sidecars.size === 0)
      this.ownedSidecars.delete(scope.scopeId);
    if (errors.length > 0)
      throw new Error(`输出暂存清理失败：${errors.join("；")}`);
  }

  async reconcileCommittedOutput(input: {
    runId: string;
    groupName: string;
    taskFingerprint: string;
  }): Promise<CommitReconciliation> {
    assertSafeSegment(input.runId, "运行编号");
    assertSafeSegment(input.groupName, "素材组名称");
    const finalLocation = joinLocation(
      joinLocation(this.options.outputRoot, input.runId),
      input.groupName,
    );
    if (!(await this.options.storage.exists(finalLocation)))
      return { status: "missing" };
    const reportLocation = joinLocation(finalLocation, "result.json");
    if (!(await this.options.storage.exists(reportLocation))) {
      return {
        status: "conflict",
        message: "最终输出目录存在，但缺少 result.json",
      };
    }
    try {
      const report = JSON.parse(
        new TextDecoder().decode(
          await this.options.storage.readFile(reportLocation),
        ),
      ) as {
        status?: unknown;
        runId?: unknown;
        groupName?: unknown;
        taskFingerprint?: unknown;
        outputs?: Array<{ artifact?: OutputArtifact }>;
      };
      if (
        report.status !== "verified" ||
        report.runId !== input.runId ||
        report.groupName !== input.groupName ||
        report.taskFingerprint !== input.taskFingerprint ||
        !Array.isArray(report.outputs) ||
        report.outputs.some((item) => !item.artifact)
      ) {
        return {
          status: "conflict",
          message: "最终输出质量报告与中断任务不匹配",
        };
      }
      const artifacts = report.outputs.map((item) => ({
        ...(item.artifact as OutputArtifact),
      }));
      if (
        artifacts.some(
          (artifact) =>
            typeof artifact.name !== "string" ||
            typeof artifact.kind !== "string" ||
            typeof artifact.fingerprint !== "string" ||
            !Number.isSafeInteger(artifact.byteLength) ||
            artifact.byteLength < 0,
        )
      ) {
        return {
          status: "conflict",
          message: "最终输出质量报告中的文件记录无效",
        };
      }
      for (const artifact of artifacts)
        assertSafeSegment(artifact.name, "质量报告文件名");
      const finalNames = (
        await this.options.storage.listFiles(finalLocation)
      ).filter((name) => name.toLowerCase() !== OWNERSHIP_FILE_NAME);
      if (
        !sameNames(finalNames, [
          ...artifacts.map((item) => item.name),
          "result.json",
        ])
      ) {
        return {
          status: "conflict",
          message: "最终输出文件清单与质量报告不一致",
        };
      }
      for (const artifact of artifacts) {
        const bytes = await this.options.storage.readFile(
          joinLocation(finalLocation, artifact.name),
        );
        if (
          bytes.byteLength !== artifact.byteLength ||
          fingerprintBytes(bytes) !== artifact.fingerprint
        ) {
          return {
            status: "conflict",
            message: `最终输出文件与质量报告不一致：${artifact.name}`,
          };
        }
      }
      const reportBytes = await this.options.storage.readFile(reportLocation);
      artifacts.push({
        name: "result.json",
        kind: "report",
        fingerprint: fingerprintBytes(reportBytes),
        byteLength: reportBytes.byteLength,
      });
      return {
        status: "completed",
        output: { location: finalLocation, artifacts },
      };
    } catch (error) {
      return {
        status: "conflict",
        message:
          error instanceof Error
            ? `最终输出质量报告无法读取：${error.message}`
            : "最终输出质量报告无法读取",
      };
    }
  }

  async cleanupOwnedTemporary(input: {
    runId: string;
    groupName: string;
    taskFingerprint: string;
    attemptId: string;
  }): Promise<"cleaned" | "missing" | "preserved"> {
    assertSafeSegment(input.runId, "运行编号");
    assertSafeSegment(input.groupName, "素材组名称");
    const runLocation = joinLocation(this.options.outputRoot, input.runId);
    const stagingLocation = joinLocation(
      runLocation,
      `.staging-${fingerprintValue({
        runId: input.runId,
        groupName: input.groupName,
        attemptId: input.attemptId,
      }).slice(0, 16)}`,
    );
    const stagingOwnershipLocation = joinLocation(
      stagingLocation,
      OWNERSHIP_FILE_NAME,
    );
    const finalOwnershipLocation = joinLocation(
      joinLocation(runLocation, input.groupName),
      OWNERSHIP_FILE_NAME,
    );
    const stagingExists = await this.options.storage.exists(stagingLocation);
    const stagingMarkerExists = await this.options.storage.exists(
      stagingOwnershipLocation,
    );
    const finalMarkerExists = await this.options.storage.exists(
      finalOwnershipLocation,
    );
    if (
      (stagingExists && !stagingMarkerExists) ||
      (stagingMarkerExists && finalMarkerExists)
    )
      return "preserved";
    const markerLocation = stagingMarkerExists
      ? stagingOwnershipLocation
      : finalMarkerExists
        ? finalOwnershipLocation
        : undefined;
    if (!markerLocation) return stagingExists ? "preserved" : "missing";
    let markerMatches = false;
    try {
      const marker = JSON.parse(
        new TextDecoder().decode(
          await this.options.storage.readFile(markerLocation),
        ),
      ) as OwnershipMarker;
      markerMatches =
        (marker.schemaVersion !== 1 ||
          marker.owner !== "psd-piece-print-batch" ||
          marker.runId !== input.runId ||
          marker.groupName !== input.groupName ||
          marker.taskFingerprint !== input.taskFingerprint ||
          marker.attemptId !== input.attemptId ||
          marker.stagingLocation !== stagingLocation) === false;
    } catch {
      return "preserved";
    }
    if (!markerMatches) return "preserved";
    if (markerLocation === stagingOwnershipLocation) {
      if (!stagingExists) return "preserved";
      await this.options.storage.removeDirectory(stagingLocation);
    } else {
      await this.options.storage.removeFile(finalOwnershipLocation);
    }
    return "cleaned";
  }
}
