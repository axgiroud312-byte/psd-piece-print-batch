import { describe, expect, it, vi } from "vitest";

import {
  FixedRegionOutputPort,
  OUTPUT_IMPLEMENTATION_VERSION,
  OutputCapabilityError,
  type FixedRegionRenderer,
  type OutputCapabilityGate,
  type OutputStorage,
} from "../src/adapters/fixed-region-output-port";
import { samplePreflightPayload } from "../src/domain/sample";
import type { InputGroupSnapshot, OutputTarget, TemplateConfig } from "../src/domain/types";
import type { ExecutionScope, OutputArtifactMetadata } from "../src/workflow/types";
import { fingerprintValue } from "../src/workflow/fingerprint";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function parentOf(location: string): string {
  return location.slice(0, location.lastIndexOf("/"));
}

class MemoryOutputStorage implements OutputStorage {
  readonly directories = new Set<string>();
  readonly files = new Map<string, Uint8Array>();
  readonly writableChecks: string[] = [];
  promoteFailure = false;

  async exists(location: string): Promise<boolean> {
    return this.directories.has(location) || this.files.has(location);
  }

  async assertWritable(location: string): Promise<void> {
    this.writableChecks.push(location);
  }

  async ensureDirectory(location: string): Promise<void> {
    this.directories.add(location);
  }

  async createExclusiveDirectory(location: string): Promise<void> {
    if (await this.exists(location)) throw new Error(`目录已存在：${location}`);
    this.directories.add(location);
  }

  async writeFile(location: string, bytes: Uint8Array): Promise<void> {
    if (!this.directories.has(parentOf(location))) throw new Error(`父目录不存在：${location}`);
    this.files.set(location, Uint8Array.from(bytes));
  }

  async readFile(location: string): Promise<Uint8Array> {
    const bytes = this.files.get(location);
    if (!bytes) throw new Error(`文件不存在：${location}`);
    return Uint8Array.from(bytes);
  }

  async listFiles(location: string): Promise<string[]> {
    const prefix = `${location}/`;
    return [...this.files.keys()]
      .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
      .map((candidate) => candidate.slice(prefix.length));
  }

  async promoteDirectoryExclusive(temporaryLocation: string, finalLocation: string): Promise<void> {
    if (this.promoteFailure) throw new Error("原子提升失败");
    if (await this.exists(finalLocation)) throw new Error(`目标已存在：${finalLocation}`);
    if (!this.directories.has(temporaryLocation)) throw new Error("暂存目录不存在");
    this.directories.add(finalLocation);
    const prefix = `${temporaryLocation}/`;
    for (const [location, bytes] of [...this.files]) {
      if (!location.startsWith(prefix)) continue;
      this.files.set(`${finalLocation}/${location.slice(prefix.length)}`, bytes);
      this.files.delete(location);
    }
    this.directories.delete(temporaryLocation);
  }

  async removeDirectory(location: string): Promise<void> {
    const prefix = `${location}/`;
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) this.files.delete(file);
    }
    this.directories.delete(location);
  }
}

function metadataFor(target: OutputTarget): OutputArtifactMetadata {
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

function capability(): OutputCapabilityGate {
  return {
    m0Validated: true,
    atomicPromotionValidated: true,
    profileId: samplePreflightPayload.template.output.capabilityProfileId,
    pluginVersion: "0.1.0",
    implementationVersion: OUTPUT_IMPLEMENTATION_VERSION,
    storageScopeId: "memory-output",
    documentSpecFingerprint: fingerprintValue(samplePreflightPayload.template.document),
    outputConfigFingerprint: fingerprintValue(samplePreflightPayload.template.output),
    masterFingerprints: [samplePreflightPayload.template.masterFingerprint],
    validatedSourceSetFingerprints: [sampleSourceSetFingerprint()],
    combinations: [
      {
        profile: structuredClone(samplePreflightPayload.template.output.preview.profile),
        maxWidth: 6000,
        maxHeight: 6000,
        maxEstimatedBytes: 200_000_000,
        maxFileBytes: 200_000_000,
      },
      {
        profile: structuredClone(samplePreflightPayload.template.output.production[0].profile),
        maxWidth: 6000,
        maxHeight: 6000,
        maxEstimatedBytes: 200_000_000,
        maxFileBytes: 200_000_000,
      },
    ],
  };
}

function sampleSourceSetFingerprint(): string {
  return fingerprintValue(
    samplePreflightPayload.groups[0].files
      .map((file) => ({ name: file.name, fingerprint: file.fingerprint as string }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function scope(): ExecutionScope {
  return {
    scopeId: "scope-001",
    runId: "run-001",
    documents: { contentDocumentIds: [] },
    temporaryLocations: [],
  };
}

function exportOutputs(
  port: FixedRegionOutputPort,
  currentScope: ExecutionScope,
  template: TemplateConfig = samplePreflightPayload.template,
  group: InputGroupSnapshot = samplePreflightPayload.groups[0],
) {
  return port.exportOutputs(currentScope, template, group, 42, "0.1.0", "25.0.0");
}

function setup() {
  const storage = new MemoryOutputStorage();
  const metadataOverrides = new Map<string, Partial<OutputArtifactMetadata>>();
  const render = vi.fn(async (_documentId: number, target: OutputTarget, _kind: string, destination: string) => {
    const metadata = { ...metadataFor(target), ...metadataOverrides.get(target.fileName) };
    await storage.writeFile(destination, encoder.encode(JSON.stringify(metadata)));
  });
  const renderer: FixedRegionRenderer = {
    render,
    inspect: async (bytes) => JSON.parse(decoder.decode(bytes)) as OutputArtifactMetadata,
  };
  const port = new FixedRegionOutputPort({
    outputRoot: "C:/输出",
    storageScopeId: "memory-output",
    storage,
    renderer,
    capability: capability(),
    now: () => "2026-09-22T09:00:00.000Z",
  });
  return { storage, renderer, render, metadataOverrides, port };
}

describe("fixed-region output transaction", () => {
  it("renders separate fixed preview and production targets, rereads them, and atomically publishes the report", async () => {
    const { storage, render, port } = setup();
    const currentScope = scope();
    const template = structuredClone(samplePreflightPayload.template);
    const group = structuredClone(samplePreflightPayload.groups[0]);

    const draft = await exportOutputs(port, currentScope, template, group);
    expect(storage.writableChecks[0]).toContain("/.staging-");
    const verified = await port.verifyOutput(currentScope, draft, "task-fingerprint");
    const committed = await port.commitResult(currentScope, verified);
    await port.cleanup(currentScope);

    expect(render).toHaveBeenCalledTimes(5);
    expect(render.mock.calls[0][1]).toEqual(template.output.preview);
    expect(render.mock.calls[0][2]).toBe("preview");
    expect(render.mock.calls[1][1]).toEqual(template.output.production[0]);
    expect(render.mock.calls[1][2]).toBe("production");
    expect(template.output.preview.profile).not.toEqual(template.output.production[0].profile);
    expect(verified.artifacts).toHaveLength(6);
    expect(verified.artifacts[verified.artifacts.length - 1].name).toBe("result.json");
    expect(committed.location).toBe("C:/输出/run-001/款式001-蓝花");
    expect(await storage.exists(committed.location)).toBe(true);
    expect(await storage.exists(draft.temporaryLocation)).toBe(false);
    expect(await storage.listFiles(committed.location)).toHaveLength(6);
    const report = JSON.parse(decoder.decode(await storage.readFile(`${committed.location}/result.json`)));
    expect(report).toMatchObject({ status: "verified", taskFingerprint: "task-fingerprint" });
    expect(report.audit).toMatchObject({
      templateId: template.templateId,
      masterFingerprint: template.masterFingerprint,
    });
    expect(report.outputs[0]).toMatchObject({
      fixedRegion: template.output.preview.region,
      visibleLayerPaths: template.output.preview.visibleLayerPaths,
    });
  });

  it("fails closed before writes when output capability is unverified", async () => {
    const { storage, renderer } = setup();
    const port = new FixedRegionOutputPort({ outputRoot: "C:/输出", storageScopeId: "memory-output", storage, renderer });

    await expect(
      exportOutputs(port, scope()),
    ).rejects.toBeInstanceOf(OutputCapabilityError);
    expect(storage.directories.size).toBe(0);
  });

  it("invalidates M0 evidence when the plugin or output implementation version changes", async () => {
    const { storage, renderer } = setup();
    const oldPluginPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: capability(),
    });
    await expect(
      oldPluginPort.preflight("run-001", samplePreflightPayload.template, samplePreflightPayload.groups[0], "0.2.0"),
    ).rejects.toThrow("插件或输出实现版本");

    const oldImplementation = capability();
    oldImplementation.implementationVersion = "fixed-region-output-v0";
    const oldImplementationPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: oldImplementation,
    });
    await expect(
      oldImplementationPort.preflight(
        "run-001",
        samplePreflightPayload.template,
        samplePreflightPayload.groups[0],
        "0.1.0",
      ),
    ).rejects.toThrow("插件或输出实现版本");
    expect(storage.directories.size).toBe(0);
  });

  it("blocks changed raster source content before writing until that exact set passes M0", async () => {
    const { storage, render, port } = setup();
    const changedGroup = structuredClone(samplePreflightPayload.groups[0]);
    changedGroup.files[0].fingerprint = "new-unvalidated-raster-content";

    await expect(port.preflight("run-001", samplePreflightPayload.template, changedGroup, "0.1.0")).rejects.toThrow(
      "当前素材集合未通过",
    );
    expect(render).not.toHaveBeenCalled();
    expect(storage.directories.size).toBe(0);
  });

  it("fails closed on malformed capability limits and stale deterministic staging", async () => {
    const { storage, renderer, render } = setup();
    const invalid = capability();
    invalid.combinations[0].maxFileBytes = Number.NaN;
    const invalidPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: invalid,
    });
    await expect(
      invalidPort.preflight("run-001", samplePreflightPayload.template, samplePreflightPayload.groups[0], "0.1.0"),
    ).rejects.toThrow("无效或无限制");

    const staging = `C:/输出/run-001/.staging-${fingerprintValue({
      runId: "run-001",
      groupName: samplePreflightPayload.groups[0].name,
    }).slice(0, 16)}`;
    storage.directories.add(staging);
    const currentPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: capability(),
    });
    await expect(
      currentPort.preflight("run-001", samplePreflightPayload.template, samplePreflightPayload.groups[0], "0.1.0"),
    ).rejects.toThrow("暂存目录冲突");
    expect(render).not.toHaveBeenCalled();
  });

  it("blocks an editable layered target whose declared limit is below its composite floor", async () => {
    const { storage, renderer, render } = setup();
    const template = structuredClone(samplePreflightPayload.template);
    const editable = {
      ...structuredClone(template.output.production[0]),
      id: "editable",
      productionKind: "editable-work-copy" as const,
      preserveAllLayers: true as const,
      fileName: "工作副本.psb",
      region: { x: 0, y: 0, width: 6000, height: 6000 },
      visibleLayerPaths: [],
      markLayerPaths: [],
      maximumFileBytes: 100_000_000,
      profile: {
        ...structuredClone(template.output.production[0].profile),
        format: "psb" as const,
        compression: "photoshop" as const,
        includeGuides: true,
        includeMarks: true,
      },
    };
    template.output.production.push(editable);
    const currentCapability = capability();
    currentCapability.outputConfigFingerprint = fingerprintValue(template.output);
    currentCapability.combinations.push({
      profile: structuredClone(editable.profile),
      maxWidth: 10_000,
      maxHeight: 10_000,
      maxEstimatedBytes: 500_000_000,
      maxFileBytes: 500_000_000,
    });
    const port = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: currentCapability,
    });

    await expect(port.preflight("run-001", template, samplePreflightPayload.groups[0], "0.1.0")).rejects.toThrow(
      "大文件限制",
    );
    expect(render).not.toHaveBeenCalled();
    expect(storage.directories.size).toBe(0);

    const changedGroup = structuredClone(samplePreflightPayload.groups[0]);
    changedGroup.files[0].fingerprint = "different-layered-source";
    template.output.production[template.output.production.length - 1].maximumFileBytes = 200_000_000;
    currentCapability.outputConfigFingerprint = fingerprintValue(template.output);
    const sourceLockedPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: currentCapability,
    });
    await expect(sourceLockedPort.preflight("run-001", template, changedGroup, "0.1.0")).rejects.toThrow(
      "当前素材集合未通过",
    );
  });

  it("blocks unsupported combinations and large outputs before creating a staging directory", async () => {
    const { storage, renderer } = setup();
    const unsupported = capability();
    unsupported.combinations = unsupported.combinations.filter((item) => item.profile.format !== "jpeg");
    const unsupportedPort = new FixedRegionOutputPort({ outputRoot: "C:/输出", storageScopeId: "memory-output", storage, renderer, capability: unsupported });
    await expect(
      exportOutputs(unsupportedPort, scope()),
    ).rejects.toThrow("输出组合未通过 M0");

    const changedProfile = structuredClone(samplePreflightPayload.template);
    changedProfile.output.preview.profile.ppi = 96;
    const exactCapability = capability();
    exactCapability.outputConfigFingerprint = fingerprintValue(changedProfile.output);
    const exactPort = new FixedRegionOutputPort({ outputRoot: "C:/输出", storageScopeId: "memory-output", storage, renderer, capability: exactCapability });
    await expect(exportOutputs(exactPort, scope(), changedProfile)).rejects.toThrow(
      "输出组合未通过 M0",
    );

    const tooLarge = structuredClone(samplePreflightPayload.template);
    tooLarge.output.preview.region.width = 6001;
    const largeCapability = capability();
    largeCapability.outputConfigFingerprint = fingerprintValue(tooLarge.output);
    const largePort = new FixedRegionOutputPort({ outputRoot: "C:/输出", storageScopeId: "memory-output", storage, renderer, capability: largeCapability });
    await expect(exportOutputs(largePort, scope(), tooLarge)).rejects.toThrow(
      "大文件限制",
    );
    expect(storage.directories.size).toBe(0);
  });

  it("blocks filename and existing-result collisions without writing", async () => {
    const { storage, renderer, render, port } = setup();
    const conflicting = structuredClone(samplePreflightPayload.template);
    conflicting.output.production[0].fileName = conflicting.output.preview.fileName;
    const collisionCapability = capability();
    collisionCapability.outputConfigFingerprint = fingerprintValue(conflicting.output);
    const collisionPort = new FixedRegionOutputPort({
      outputRoot: "C:/输出",
      storageScopeId: "memory-output",
      storage,
      renderer,
      capability: collisionCapability,
    });
    await expect(exportOutputs(collisionPort, scope(), conflicting)).rejects.toThrow(
      "输出文件名冲突",
    );

    storage.directories.add("C:/输出/run-001/款式001-蓝花");
    await expect(
      exportOutputs(port, scope()),
    ).rejects.toThrow("禁止覆盖");
    expect(render).not.toHaveBeenCalled();
  });

  it("rejects wrong metadata and never publishes a partial result", async () => {
    const { storage, metadataOverrides, port } = setup();
    metadataOverrides.set("前片.png", { width: 1 });
    const currentScope = scope();
    const draft = await exportOutputs(port, currentScope);

    await expect(port.verifyOutput(currentScope, draft, "task")).rejects.toThrow("width 应为 2400，实际为 1");
    expect(await storage.exists(draft.finalLocation)).toBe(false);
    await port.cleanup(currentScope);
    expect(await storage.exists(draft.temporaryLocation)).toBe(false);
  });

  it("rejects missing or non-finite decoded metadata", async () => {
    const { metadataOverrides, port } = setup();
    metadataOverrides.set("预览.jpg", { ppi: Number.NaN });
    const currentScope = scope();
    const draft = await exportOutputs(port, currentScope);
    await expect(port.verifyOutput(currentScope, draft, "task")).rejects.toThrow("必要元数据无效或缺失");
    await port.cleanup(currentScope);
  });

  it("rejects missing, extra, or undecodable files during reread verification", async () => {
    const { storage, port } = setup();
    const currentScope = scope();
    const draft = await exportOutputs(port, currentScope);
    await storage.writeFile(`${draft.temporaryLocation}/意外文件.png`, encoder.encode("extra"));
    await expect(port.verifyOutput(currentScope, draft, "task")).rejects.toThrow("数量或名称");
    storage.files.delete(`${draft.temporaryLocation}/意外文件.png`);
    await storage.writeFile(`${draft.temporaryLocation}/${draft.expectedArtifacts[0].name}`, encoder.encode("not-json"));
    await expect(port.verifyOutput(currentScope, draft, "task")).rejects.toThrow();
    await port.cleanup(currentScope);
  });

  it("preserves an existing result if a collision appears before commit", async () => {
    const { storage, port } = setup();
    const currentScope = scope();
    const draft = await exportOutputs(port, currentScope);
    const verified = await port.verifyOutput(currentScope, draft, "task");
    storage.directories.add(draft.finalLocation);
    await storage.writeFile(`${draft.finalLocation}/已有结果.txt`, encoder.encode("keep"));

    await expect(port.commitResult(currentScope, verified)).rejects.toThrow("禁止覆盖");
    expect(decoder.decode(await storage.readFile(`${draft.finalLocation}/已有结果.txt`))).toBe("keep");
    await port.cleanup(currentScope);
    expect(await storage.exists(draft.temporaryLocation)).toBe(false);
  });

  it("refuses commit if a verified staging file changes", async () => {
    const { storage, port } = setup();
    const currentScope = scope();
    const draft = await exportOutputs(port, currentScope);
    const verified = await port.verifyOutput(currentScope, draft, "task");
    await storage.writeFile(`${draft.temporaryLocation}/${verified.artifacts[0].name}`, encoder.encode("changed"));

    await expect(port.commitResult(currentScope, verified)).rejects.toThrow("验证后输出文件发生变化");
    expect(await storage.exists(draft.finalLocation)).toBe(false);
    await port.cleanup(currentScope);
  });

  it("keeps staging owned for cleanup when rendering or atomic promotion fails", async () => {
    const { storage, render, port } = setup();
    render.mockRejectedValueOnce(new Error("磁盘写入失败"));
    const failedScope = scope();
    await expect(
      exportOutputs(port, failedScope),
    ).rejects.toThrow("磁盘写入失败");
    expect(failedScope.temporaryLocations).toHaveLength(1);
    await port.cleanup(failedScope);
    expect(failedScope.temporaryLocations).toHaveLength(0);

    const next = setup();
    const nextScope = scope();
    const draft = await exportOutputs(next.port, nextScope);
    const verified = await next.port.verifyOutput(nextScope, draft, "task");
    next.storage.promoteFailure = true;
    await expect(next.port.commitResult(nextScope, verified)).rejects.toThrow("原子提升失败");
    expect(await next.storage.exists(draft.temporaryLocation)).toBe(true);
    expect(await next.storage.exists(draft.finalLocation)).toBe(false);
    await next.port.cleanup(nextScope);
  });
});
