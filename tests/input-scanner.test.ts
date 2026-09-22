import { describe, expect, it } from "vitest";
import { deflateSync } from "node:zlib";

import {
  readImageDimensions,
  resolveScannedInputFile,
  scanInputFolder,
  selectTemplateConfigJson,
} from "../src/adapters/uxp-input-scanner";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Uint8Array.from(type, (character) => character.charCodeAt(0));
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcInput = new Uint8Array(typeBytes.length + data.length);
  crcInput.set(typeBytes);
  crcInput.set(data, typeBytes.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return chunk;
}

function joinBytes(parts: Uint8Array[]): ArrayBuffer {
  const result = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result.buffer;
}

function png(width: number, height: number): ArrayBuffer {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = new Uint8Array(height * (1 + width * 4));
  const compressed = new Uint8Array(deflateSync(rows));
  return joinBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array()),
  ]);
}

function jpeg(width: number, height: number): ArrayBuffer {
  const bytes = new Uint8Array(28);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08]);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  bytes.set([0x01, 0x01, 0x11, 0x00], 11);
  bytes.set([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x00, 0xff, 0xd9], 15);
  return bytes.buffer;
}

describe("image metadata reader", () => {
  it("reads PNG and JPEG pixel dimensions from file headers", () => {
    expect(readImageDimensions(png(24, 32), "png")).toEqual({ width: 24, height: 32 });
    expect(readImageDimensions(jpeg(18, 24), "jpg")).toEqual({ width: 18, height: 24 });
  });

  it("rejects corrupt and unsupported files", () => {
    expect(() => readImageDimensions(new ArrayBuffer(8), "png")).toThrow("PNG 文件头无效");
    const signatureOnly = new Uint8Array(24);
    signatureOnly.set([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(() => readImageDimensions(signatureOnly.buffer, "png")).toThrow();
    expect(() => readImageDimensions(new ArrayBuffer(8), "tif")).toThrow("不支持的素材格式");
  });
});

describe("UXP input scanner", () => {
  it("scans child folders and records unreadable image metadata", async () => {
    const goodFile = {
      name: "前片.png",
      isFile: true,
      isFolder: false,
      read: async () => png(24, 32),
    };
    const badFile = {
      name: "损坏.jpg",
      isFile: true,
      isFolder: false,
      read: async () => new ArrayBuffer(4),
    };
    const noteFile = {
      name: "说明.txt",
      isFile: true,
      isFolder: false,
      read: async () => new ArrayBuffer(0),
    };
    const group = {
      name: "款式001",
      isFile: false,
      isFolder: true,
      getEntries: async () => [noteFile, badFile, goodFile],
    };
    const root = {
      name: "输入",
      isFile: false,
      isFolder: true,
      getEntries: async () => [group],
    };

    const groups = await scanInputFolder(root as never, "binary");

    expect(groups).toHaveLength(1);
    const scanned = groups[0].files.find((file) => file.name === "前片.png");
    expect(scanned).toEqual(
      expect.objectContaining({
        name: "前片.png",
        width: 24,
        height: 32,
        sourceRef: expect.any(String),
        fingerprint: expect.any(String),
      }),
    );
    expect(resolveScannedInputFile(scanned!.sourceRef!, scanned!.fingerprint!)).toBe(goodFile);
    expect(groups[0].files.find((file) => file.name === "损坏.jpg")?.metadataError).toBeTruthy();
    expect(groups[0].files).toContainEqual({ name: "说明.txt" });
  });

  it("reads production images sequentially", async () => {
    let activeReads = 0;
    let peakReads = 0;
    const file = (name: string) => ({
      name,
      isFile: true,
      isFolder: false,
      read: async () => {
        activeReads += 1;
        peakReads = Math.max(peakReads, activeReads);
        await Promise.resolve();
        activeReads -= 1;
        return png(100, 100);
      },
    });
    const group = {
      name: "大图组",
      isFile: false,
      isFolder: true,
      getEntries: async () => [file("a.png"), file("b.png"), file("c.png")],
    };
    const root = {
      name: "输入",
      isFile: false,
      isFolder: true,
      getEntries: async () => [group],
    };

    await scanInputFolder(root as never, "binary");

    expect(peakReads).toBe(1);
  });

  it("rejects loose root files and missing group folders", async () => {
    const looseRoot = {
      name: "输入",
      isFile: false,
      isFolder: true,
      getEntries: async () => [{ name: "all.png", isFile: true, isFolder: false }],
    };
    const emptyRoot = {
      name: "输入",
      isFile: false,
      isFolder: true,
      getEntries: async () => [],
    };

    await expect(scanInputFolder(looseRoot as never, "binary")).rejects.toThrow("根目录不能直接放文件");
    await expect(scanInputFolder(emptyRoot as never, "binary")).rejects.toThrow("没有分组子文件夹");
  });

  it("loads an independently selected template JSON file", async () => {
    const storage = {
      formats: { binary: "binary", utf8: "utf8" },
      localFileSystem: {
        getFolder: async () => null,
        getFileForOpening: async () => ({
          name: "template.json",
          isFile: true,
          isFolder: false,
          read: async () => '{"schemaVersion":1}',
        }),
      },
    };

    await expect(selectTemplateConfigJson(storage as never)).resolves.toBe('{"schemaVersion":1}');
  });

  it("never rebinds an old source reference after scanning an identically named root", async () => {
    const makeRoot = (file: object) => ({
      name: "输入",
      isFile: false,
      isFolder: true,
      getEntries: async () => [
        {
          name: "款式001",
          isFile: false,
          isFolder: true,
          getEntries: async () => [file],
        },
      ],
    });
    const firstFile = {
      name: "front.png",
      isFile: true,
      isFolder: false,
      read: async () => png(10, 10),
    };
    const secondFile = {
      name: "front.png",
      isFile: true,
      isFolder: false,
      read: async () => png(20, 20),
    };

    const first = (await scanInputFolder(makeRoot(firstFile) as never, "binary"))[0].files[0];
    const second = (await scanInputFolder(makeRoot(secondFile) as never, "binary"))[0].files[0];

    expect(() => resolveScannedInputFile(first.sourceRef!, first.fingerprint!)).toThrow("来源引用已失效");
    expect(resolveScannedInputFile(second.sourceRef!, second.fingerprint!)).toBe(secondFile);
  });
});
