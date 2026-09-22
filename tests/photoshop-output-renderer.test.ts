import { describe, expect, it, vi } from "vitest";

import {
  PhotoshopFixedRegionRenderer,
  type PhotoshopRenderRuntime,
} from "../src/adapters/photoshop-fixed-region-renderer";
import type { UxpOutputStorage } from "../src/adapters/uxp-output-storage";
import { samplePreflightPayload } from "../src/domain/sample";
import type {
  ModalDocumentControl,
  OutputArtifactMetadata,
} from "../src/workflow/types";

function layer(
  id: number,
  name: string,
  nested: Array<Record<string, any>> = [],
) {
  return { id, name, visible: true, layers: nested };
}

function document(id: number, name: string) {
  return {
    id,
    name,
    width: 6000,
    height: 6000,
    resolution: 150,
    mode: "RGBColorMode",
    bitsPerChannel: "EIGHT",
    colorProfileName: "None",
    layers: [
      layer(1, "PREVIEW｜预览内容", [layer(2, "效果图")]),
      layer(3, "PRINT｜生产内容", [layer(4, "前片")]),
    ],
    activeLayers: [] as Array<Record<string, any>>,
    guides: [{ delete: vi.fn(async () => {}) }],
    duplicate: vi.fn(),
    crop: vi.fn(async function (
      this: { width: number; height: number },
      bounds,
    ) {
      this.width = bounds.right - bounds.left;
      this.height = bounds.bottom - bounds.top;
    }),
    resizeImage: vi.fn(async function (
      this: { resolution: number },
      _width,
      _height,
      resolution,
    ) {
      this.resolution = resolution;
    }),
    flatten: vi.fn(async () => {}),
    closeWithoutSaving: vi.fn(async () => {}),
    saveAs: {
      png: vi.fn(async () => {}),
      jpg: vi.fn(async () => {}),
      psd: vi.fn(async () => {}),
      psb: vi.fn(async () => {}),
    },
  };
}

function control(): ModalDocumentControl & {
  registered: number[];
  unregistered: number[];
} {
  return {
    registered: [],
    unregistered: [],
    async registerAutoCloseDocument(documentId) {
      this.registered.push(documentId);
    },
    async unregisterAutoCloseDocument(documentId) {
      this.unregistered.push(documentId);
    },
  };
}

describe("Photoshop fixed-region renderer", () => {
  it("duplicates, applies registered visibility and crop, saves, and closes the owned document", async () => {
    const source = document(10, "工作副本.psd");
    const output = document(11, "输出副本.psd");
    source.duplicate.mockResolvedValue(output);
    const file = { name: "预览.jpg", isFile: true };
    const storage = {
      fileEntry: vi.fn(async () => file),
    } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [source as never],
      open: vi.fn(),
      hasAlpha: vi.fn(async () => false),
      createSolidBackground: vi.fn(async () => {}),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);
    const currentControl = control();
    const target = structuredClone(
      samplePreflightPayload.template.output.preview,
    );

    await renderer.render(
      10,
      target,
      "preview",
      "C:/输出/run/staging/预览.jpg",
      currentControl,
    );

    expect(source.duplicate).toHaveBeenCalledWith(
      `批量输出-${target.id}`,
      false,
    );
    expect(output.layers[0].visible).toBe(true);
    expect(output.layers[0].layers[0].visible).toBe(true);
    expect(output.layers[1].visible).toBe(false);
    expect(output.crop).toHaveBeenCalledWith({
      left: 0,
      top: 0,
      right: 4800,
      bottom: 3600,
    });
    expect(output.resizeImage).toHaveBeenCalledWith(undefined, undefined, 72);
    expect(runtime.createSolidBackground).toHaveBeenCalledWith(
      output,
      "#ffffff",
    );
    expect(output.flatten).toHaveBeenCalledOnce();
    expect(output.saveAs.jpg).toHaveBeenCalledWith(
      file,
      { quality: 12, embedColorProfile: false },
      true,
    );
    expect(currentControl.registered).toEqual([11]);
    expect(currentControl.unregistered).toEqual([11]);
    expect(output.closeWithoutSaving).toHaveBeenCalledOnce();
  });

  it("opens exported files to verify decodability and document metadata", async () => {
    const inspected = document(20, "前片.png");
    inspected.width = 2400;
    inspected.height = 3200;
    inspected.guides = [];
    const file = { name: "前片.png", isFile: true };
    const storage = {
      fileEntry: vi.fn(async () => file),
    } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [],
      open: vi.fn(async () => inspected as never),
      hasAlpha: vi.fn(async () => true),
      createSolidBackground: vi.fn(),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);
    const currentControl = control();
    const expected: OutputArtifactMetadata = {
      format: "png",
      width: 2400,
      height: 3200,
      ppi: 150,
      colorMode: "rgb",
      bitDepth: 8,
      iccProfile: null,
      background: "transparent",
      includesGuides: false,
    };

    await expect(
      renderer.inspect(
        Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
        "前片.png",
        "C:/输出/run/staging/前片.png",
        expected,
        currentControl,
      ),
    ).resolves.toEqual(expected);
    expect(runtime.open).toHaveBeenCalledWith(file);
    expect(currentControl.registered).toEqual([20]);
    expect(currentControl.unregistered).toEqual([20]);
  });

  it("preserves the full layered document for an editable work-copy target", async () => {
    const source = document(30, "工作副本.psd");
    const output = document(31, "可编辑副本.psb");
    source.duplicate.mockResolvedValue(output);
    const file = { name: "工作副本.psb", isFile: true };
    const storage = {
      fileEntry: vi.fn(async () => file),
    } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [source as never],
      open: vi.fn(),
      hasAlpha: vi.fn(),
      createSolidBackground: vi.fn(),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);
    const target = {
      ...structuredClone(samplePreflightPayload.template.output.production[0]),
      id: "editable",
      productionKind: "editable-work-copy" as const,
      preserveAllLayers: true as const,
      fileName: "工作副本.psb",
      region: { x: 0, y: 0, width: 6000, height: 6000 },
      visibleLayerPaths: [],
      markLayerPaths: [],
      profile: {
        ...structuredClone(
          samplePreflightPayload.template.output.production[0].profile,
        ),
        format: "psb" as const,
        compression: "photoshop" as const,
        includeGuides: true,
        includeMarks: true,
      },
    };

    await renderer.render(
      30,
      target,
      "production",
      "C:/输出/run/staging/工作副本.psb",
      control(),
    );

    expect(output.crop).not.toHaveBeenCalled();
    expect(output.resizeImage).not.toHaveBeenCalled();
    expect(output.flatten).not.toHaveBeenCalled();
    expect(runtime.createSolidBackground).not.toHaveBeenCalled();
    expect(output.guides[0].delete).not.toHaveBeenCalled();
    expect(output.saveAs.psb).toHaveBeenCalledWith(
      file,
      { embedColorProfile: false, maximizeCompatibility: true },
      true,
    );
  });

  it("uses explicit mark paths only when the render profile includes process marks", async () => {
    const source = document(35, "工作副本.psd");
    const output = document(36, "生产副本.psd");
    const mark = layer(6, "前片");
    output.layers.push(layer(5, "MARKS｜工艺标记", [mark]));
    source.duplicate.mockResolvedValue(output);
    const storage = {
      fileEntry: vi.fn(async () => ({ name: "前片.png", isFile: true })),
    } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [source as never],
      open: vi.fn(),
      hasAlpha: vi.fn(),
      createSolidBackground: vi.fn(),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);
    const target = structuredClone(
      samplePreflightPayload.template.output.production[0],
    );
    target.profile.includeMarks = true;

    await renderer.render(
      35,
      target,
      "production",
      "C:/输出/run/staging/前片.png",
      control(),
    );

    expect(output.layers[2].visible).toBe(true);
    expect(mark.visible).toBe(true);
  });

  it("reports decoded container and alpha state instead of copying expected values", async () => {
    const inspected = document(40, "错误容器.jpg");
    inspected.width = 2400;
    inspected.height = 3200;
    inspected.guides = [];
    const storage = {
      fileEntry: vi.fn(async () => ({ name: "错误容器.jpg", isFile: true })),
    } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [],
      open: vi.fn(async () => inspected as never),
      hasAlpha: vi.fn(async () => false),
      createSolidBackground: vi.fn(),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);
    const expected: OutputArtifactMetadata = {
      format: "png",
      width: 2400,
      height: 3200,
      ppi: 150,
      colorMode: "rgb",
      bitDepth: 8,
      iccProfile: null,
      background: "transparent",
      includesGuides: false,
    };

    const actual = await renderer.inspect(
      Uint8Array.of(0xff, 0xd8),
      "前片.png",
      "C:/输出/run/staging/前片.png",
      expected,
      control(),
    );
    expect(actual.format).toBe("jpeg");
    expect(actual.background).toBe("opaque");
  });

  it("refuses real rendering outside protected modal document ownership", async () => {
    const storage = { fileEntry: vi.fn() } as unknown as UxpOutputStorage;
    const runtime: PhotoshopRenderRuntime = {
      documents: [document(10, "工作副本.psd") as never],
      open: vi.fn(),
      hasAlpha: vi.fn(),
      createSolidBackground: vi.fn(),
    };
    const renderer = new PhotoshopFixedRegionRenderer(storage, runtime);

    await expect(
      renderer.render(
        10,
        samplePreflightPayload.template.output.preview,
        "preview",
        "output.jpg",
      ),
    ).rejects.toThrow("自动关闭保护");
  });

  it("classifies Photoshop output save failures as batch-stopping I/O failures", async () => {
    const source = document(50, "工作副本.psd");
    const output = document(51, "输出副本.psd");
    output.saveAs.jpg.mockRejectedValue(new Error("disk full"));
    source.duplicate.mockResolvedValue(output);
    const storage = {
      fileEntry: vi.fn(async () => ({ name: "预览.jpg", isFile: true })),
    } as unknown as UxpOutputStorage;
    const renderer = new PhotoshopFixedRegionRenderer(storage, {
      documents: [source as never],
      open: vi.fn(),
      hasAlpha: vi.fn(),
      createSolidBackground: vi.fn(async () => {}),
    });

    await expect(
      renderer.render(
        source.id,
        samplePreflightPayload.template.output.preview,
        "preview",
        "C:/输出/run/staging/预览.jpg",
        control(),
      ),
    ).rejects.toMatchObject({
      code: "photoshop-output-save-failed",
      disposition: "batch",
    });
    expect(output.closeWithoutSaving).toHaveBeenCalledOnce();
  });
});
