import { describe, expect, it, vi } from "vitest";

import {
  PhotoshopBatchAdapter,
  PhotoshopCapabilityError,
  assertBatchPlayResults,
  calculateFitTransform,
} from "../src/adapters/photoshop-batch-adapter";
import { samplePreflightPayload } from "../src/domain/sample";
import { runSingleGroup } from "../src/workflow/run-group";
import type { PhotoshopOutputPort } from "../src/adapters/photoshop-batch-adapter";

function singleEntryFixture() {
  const template = structuredClone(samplePreflightPayload.template);
  template.garmentPieces = [template.garmentPieces[0]];
  template.artworkEntries = [template.artworkEntries[0]];
  template.instances = [template.instances[0]];
  const group = structuredClone(samplePreflightPayload.groups[0]);
  group.files = [group.files[0]];
  return { template, group };
}

function outputPort(): PhotoshopOutputPort & { committed: number } {
  return {
    committed: 0,
    async exportPreview(scope) {
      const temporaryLocation = `temp/${scope.scopeId}`;
      scope.temporaryLocations.push(temporaryLocation);
      return {
        temporaryLocation,
        artifacts: [{ name: "预览.png", kind: "preview", fingerprint: "preview-fingerprint" }],
      };
    },
    async verifyOutput() {},
    async commitResult(_scope, output) {
      this.committed += 1;
      return { location: "runs/result", artifacts: output.artifacts };
    },
    async cleanup(scope) {
      scope.temporaryLocations.length = 0;
    },
  };
}

function createFakeRuntime(linked = false, contentExtras: Array<Record<string, any>> = []) {
  const registered: number[] = [];
  const modalCommands: string[] = [];
  const documents: Array<Record<string, any>> = [];
  const userDocument = {
    id: 99,
    name: "用户文档.psd",
    layers: [],
    closeWithoutSaving: vi.fn(),
  };
  documents.push(userDocument);

  const removeDocument = (document: Record<string, any>) => {
    const index = documents.indexOf(document);
    if (index >= 0) documents.splice(index, 1);
  };

  const smartLayer = {
    id: 10,
    name: "ART｜印花智能对象实例",
    kind: "smartObject",
  };
  const workLayers = [
    {
      id: 11,
      name: "PRINT｜生产内容",
      layers: [{ id: 12, name: "前片", layers: [smartLayer] }],
    },
  ];
  const oldReplacement = {
    id: 30,
    name: "REPLACE_ART",
    delete: vi.fn(async () => {
      const index = contentDocument.layers.indexOf(oldReplacement);
      if (index >= 0) contentDocument.layers.splice(index, 1);
    }),
  };
  const placedLayer = {
    id: 31,
    name: "placed",
    boundsNoEffects: { left: 0, top: 0, right: 2400, bottom: 3200 },
    scale: vi.fn(async () => {}),
    translate: vi.fn(async () => {}),
    move: vi.fn(async (relative: Record<string, unknown>) => {
      const currentIndex = contentDocument.layers.indexOf(placedLayer);
      if (currentIndex >= 0) contentDocument.layers.splice(currentIndex, 1);
      const targetIndex = contentDocument.layers.indexOf(relative);
      contentDocument.layers.splice(targetIndex, 0, placedLayer);
    }),
  };
  const contentDocument: Record<string, any> = {
    id: 3,
    name: "智能对象内容.psb",
    width: 2400,
    height: 3200,
    layers: [oldReplacement] as Array<Record<string, any>>,
    save: vi.fn(async () => {}),
    closeWithoutSaving: vi.fn(async () => removeDocument(contentDocument)),
  };
  const workDocument = {
    id: 2,
    name: "工作副本.psd",
    layers: workLayers,
    closeWithoutSaving: vi.fn(async () => removeDocument(workDocument)),
  };
  const masterDocument = {
    id: 1,
    name: "成品母版.psd",
    layers: workLayers,
    duplicate: vi.fn(async () => {
      documents.push(workDocument);
      return workDocument;
    }),
    closeWithoutSaving: vi.fn(async () => removeDocument(masterDocument)),
  };

  const runtime = {
    hostVersion: "25.0.0",
    app: {
      documents,
      activeDocument: undefined,
      open: vi.fn(async () => {
        documents.push(masterDocument);
        return masterDocument;
      }),
    },
    core: {
      executeAsModal: vi.fn(async (operation: (context: any) => Promise<unknown>, options: any) => {
        modalCommands.push(options.commandName);
        const automatic = new Set<number>();
        try {
          return await operation({
            isCancelled: false,
            hostControl: {
              registerAutoCloseDocument: async (id: number) => {
                registered.push(id);
                automatic.add(id);
              },
              unregisterAutoCloseDocument: async (id: number) => {
                automatic.delete(id);
              },
            },
          });
        } finally {
          for (const id of automatic) {
            const document = documents.find((candidate) => candidate.id === id);
            if (document?.closeWithoutSaving) await document.closeWithoutSaving();
          }
        }
      }),
    },
    action: {
      batchPlay: vi.fn(async (commands: Array<Record<string, unknown>>) => {
        const command = commands[0];
        if (command._obj === "get") {
          return [{ smartObject: { linked }, smartObjectMore: { ID: "embedded-front" } }];
        }
        if (command._obj === "placedLayerEditContents") {
          contentDocument.layers = [oldReplacement, ...contentExtras];
          documents.push(contentDocument);
          return [{}];
        }
        if (command._obj === "placeEvent") {
          contentDocument.layers.push(placedLayer);
          return [{}];
        }
        return [{}];
      }),
    },
    constants: {
      LayerKind: { SMARTOBJECT: "smartObject" },
      ElementPlacement: { PLACEBEFORE: "placeBefore" },
    },
    localFileSystem: { createSessionToken: vi.fn(() => "session-token") },
  };

  return {
    runtime,
    registered,
    modalCommands,
    documents,
    userDocument,
    oldReplacement,
    placedLayer,
    contentDocument,
    workDocument,
  };
}

describe("Photoshop adapter", () => {
  it("keeps real document mutation locked before M0", async () => {
    const { template } = singleEntryFixture();
    const port = outputPort();
    const adapter = new PhotoshopBatchAdapter({
      masterResolver: { resolve: async () => ({}) },
      outputPort: port,
    });
    const scope = adapter.createScope("locked");

    await expect(
      adapter.createWorkCopy(scope, template, { isCancellationRequested: false }),
    ).rejects.toBeInstanceOf(PhotoshopCapabilityError);
  });

  it("runs the guarded smart-object path inside modal execution and closes only owned documents", async () => {
    const { template, group } = singleEntryFixture();
    const fake = createFakeRuntime();
    const port = outputPort();
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: {
        resolve: async (sourceRef, fingerprint) => {
          expect(sourceRef).toBe(template.masterSourceRef);
          expect(fingerprint).toBe(template.masterFingerprint);
          return { name: "成品母版.psd" };
        },
      },
      artworkResolver: {
        resolve: async (sourceRef, fingerprint) => {
          expect(sourceRef).toBe(group.files[0].sourceRef);
          expect(fingerprint).toBe(group.files[0].fingerprint);
          return { name: "front.png" };
        },
      },
      outputPort: port,
      runtime: fake.runtime as never,
    });

    const result = await runSingleGroup(
      { runId: "photoshop-smoke", pluginVersion: "0.1.0", template, group },
      adapter,
    );

    expect(result.status).toBe("completed");
    expect(port.committed).toBe(1);
    expect(fake.modalCommands).toEqual(
      expect.arrayContaining([
        "创建母版工作副本",
        "重新解析模板结构",
        "替换 前片入口",
        "校验工作副本结构",
        "清理插件临时文档",
      ]),
    );
    expect(fake.registered).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(fake.userDocument.closeWithoutSaving).not.toHaveBeenCalled();
    expect(fake.documents).toEqual([fake.userDocument]);
    expect(fake.contentDocument.save).toHaveBeenCalledOnce();
    expect(fake.oldReplacement.delete).toHaveBeenCalledOnce();
    expect(fake.placedLayer.move).toHaveBeenCalledOnce();
    expect(fake.placedLayer.name).toBe("REPLACE_ART");
  });

  it("blocks linked smart objects before replacement", async () => {
    const { template, group } = singleEntryFixture();
    const fake = createFakeRuntime(true);
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: { resolve: async () => ({}) },
      artworkResolver: { resolve: async () => ({}) },
      outputPort: outputPort(),
      runtime: fake.runtime as never,
    });

    const result = await runSingleGroup(
      { runId: "linked", pluginVersion: "0.1.0", template, group },
      adapter,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("不支持外链智能对象");
    expect(fake.userDocument.closeWithoutSaving).not.toHaveBeenCalled();
    expect(fake.documents).toEqual([fake.userDocument]);
  });

  it("blocks unverified nested content before placing artwork", async () => {
    const { template, group } = singleEntryFixture();
    const fake = createFakeRuntime(false, [{ id: 55, name: "复杂组", layers: [{ id: 56, name: "嵌套层" }] }]);
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: { resolve: async () => ({}) },
      artworkResolver: { resolve: async () => ({}) },
      outputPort: outputPort(),
      runtime: fake.runtime as never,
    });

    const result = await runSingleGroup(
      { runId: "nested", pluginVersion: "0.1.0", template, group },
      adapter,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("未验证的嵌套图层组");
    expect(fake.oldReplacement.delete).not.toHaveBeenCalled();
  });

  it("keeps contain mode disabled until its background behavior passes M0", async () => {
    const { template, group } = singleEntryFixture();
    template.artworkEntries[0].fit = {
      mode: "contain",
      anchor: { kind: "center" },
      allowBlankArea: true,
      background: "#ffffff",
    };
    const fake = createFakeRuntime();
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: { resolve: async () => ({}) },
      artworkResolver: { resolve: async () => ({}) },
      outputPort: outputPort(),
      runtime: fake.runtime as never,
    });

    const result = await runSingleGroup(
      { runId: "contain", pluginVersion: "0.1.0", template, group },
      adapter,
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("背景渲染尚未通过 M0 验证");
  });

  it("fails closed when the host version differs from the exact M0 version", async () => {
    const { template } = singleEntryFixture();
    const fake = createFakeRuntime();
    fake.runtime.hostVersion = "25.1.0";
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: { resolve: async () => ({}) },
      outputPort: outputPort(),
      runtime: fake.runtime as never,
    });

    await expect(
      adapter.createWorkCopy(adapter.createScope("version"), template, { isCancellationRequested: false }),
    ).rejects.toThrow("当前 Photoshop 25.1.0 不在已验证版本 25.0.0 内");
  });

  it("continues closing owned documents after one close fails", async () => {
    const fake = createFakeRuntime();
    const adapter = new PhotoshopBatchAdapter({
      capability: {
        m0Validated: true,
        smartObjectEditingValidated: true,
        validatedPhotoshopVersion: "25.0.0",
      },
      masterResolver: { resolve: async () => ({}) },
      outputPort: outputPort(),
      runtime: fake.runtime as never,
    });
    const content = {
      id: 44,
      name: "待清理内容.psb",
      layers: [],
      closeWithoutSaving: vi.fn(async () => {
        const index = fake.documents.indexOf(content);
        if (index >= 0) fake.documents.splice(index, 1);
      }),
    };
    fake.documents.push(fake.workDocument, content);
    fake.workDocument.closeWithoutSaving = vi.fn(async () => {
      throw new Error("文档忙");
    });
    const scope = adapter.createScope("cleanup");
    scope.documents.workCopyDocumentId = fake.workDocument.id;
    scope.documents.contentDocumentIds.push(content.id);

    await expect(adapter.cleanup(scope)).rejects.toThrow("文档忙");

    expect(content.closeWithoutSaving).toHaveBeenCalledOnce();
    expect(fake.workDocument.closeWithoutSaving).toHaveBeenCalledOnce();
    expect(scope.documents.workCopyDocumentId).toBe(fake.workDocument.id);
    expect(scope.documents.contentDocumentIds).toEqual([]);
    expect(fake.userDocument.closeWithoutSaving).not.toHaveBeenCalled();
  });
});

describe("Photoshop operation guards", () => {
  it("surfaces resolved batchPlay error descriptors", () => {
    expect(() =>
      assertBatchPlayResults([{ _obj: "error", result: -25922, message: "命令不可用" }], "置入素材"),
    ).toThrow("置入素材失败：命令不可用");
    expect(() =>
      assertBatchPlayResults([{ _obj: "error", result: -128, message: "User cancelled" }], "置入素材"),
    ).toThrow("已由 Photoshop 取消");
  });

  it("calculates strict, cover, and contain transforms without stretching", () => {
    const bounds = { left: 0, top: 0, right: 100, bottom: 50 };
    expect(
      calculateFitTransform(bounds, { width: 200, height: 200 }, {
        mode: "cover",
        anchor: { kind: "offset", x: 10, y: -5 },
      }),
    ).toEqual({ scalePercent: 400, targetCenterX: 110, targetCenterY: 95 });
    expect(
      calculateFitTransform(bounds, { width: 200, height: 200 }, {
        mode: "contain",
        anchor: { kind: "center" },
        allowBlankArea: true,
        background: "#fff",
      }),
    ).toEqual({ scalePercent: 200, targetCenterX: 100, targetCenterY: 100 });
    expect(() =>
      calculateFitTransform(bounds, { width: 200, height: 200 }, {
        mode: "strict",
        anchor: { kind: "center" },
      }),
    ).toThrow("比例与智能对象画布不一致");
  });
});
