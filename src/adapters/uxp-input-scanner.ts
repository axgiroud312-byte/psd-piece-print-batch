import type { InputFileSnapshot, InputGroupSnapshot } from "../domain/types";
import { fingerprintBytes } from "../workflow/fingerprint";
import { BatchStoppingError, GroupOperationError } from "../workflow/failures";

interface UxpEntry {
  name: string;
  isFile: boolean;
  isFolder: boolean;
}

interface UxpFile extends UxpEntry {
  read(options: { format: string }): Promise<ArrayBuffer | string>;
}

interface UxpFolder extends UxpEntry {
  getEntries(): Promise<UxpEntry[]>;
}

interface UxpFileSystem {
  getFolder(): Promise<UxpFolder | null>;
  getFileForOpening(options: { types: string[] }): Promise<UxpFile | UxpFile[] | null>;
}

interface UxpStorage {
  localFileSystem: UxpFileSystem;
  formats: { binary: string; utf8: string };
}

const scannedSources = new Map<string, { file: UxpFile; fingerprint: string; binaryFormat: string }>();
let scanSequence = 0;

function extensionOf(name: string): string {
  const separator = name.lastIndexOf(".");
  return separator < 0 ? "" : name.slice(separator + 1).toLowerCase();
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || signature.some((value, index) => bytes[index] !== value)) {
    throw new Error("PNG 文件头无效");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let hasImageData = false;
  let hasEnd = false;
  let firstChunk = true;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error("PNG 块被截断");
    const length = readUint32(bytes, offset);
    const typeOffset = offset + 4;
    const dataOffset = offset + 8;
    const dataEnd = dataOffset + length;
    const crcOffset = dataEnd;
    if (crcOffset + 4 > bytes.length) throw new Error("PNG 块长度超出文件范围");
    const chunkType = String.fromCharCode(
      bytes[typeOffset],
      bytes[typeOffset + 1],
      bytes[typeOffset + 2],
      bytes[typeOffset + 3],
    );
    if (readUint32(bytes, crcOffset) !== crc32(bytes, typeOffset, dataEnd)) {
      throw new Error(`PNG ${chunkType} 块校验失败`);
    }
    if (firstChunk) {
      if (chunkType !== "IHDR" || length !== 13) throw new Error("PNG 缺少有效的 IHDR 块");
      width = readUint32(bytes, dataOffset);
      height = readUint32(bytes, dataOffset + 4);
      firstChunk = false;
    } else if (chunkType === "IDAT") {
      if (length > 0) hasImageData = true;
    } else if (chunkType === "IEND") {
      if (length !== 0) throw new Error("PNG IEND 块无效");
      hasEnd = true;
      offset = crcOffset + 4;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!hasImageData || !hasEnd || offset !== bytes.length) throw new Error("PNG 文件不完整");
  if (width <= 0 || height <= 0) throw new Error("PNG 像素尺寸无效");
  return { width, height };
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("JPEG 文件头无效");
  }
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let hasScan = false;
  while (offset + 8 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd8 || marker === 0x01) continue;
    if (marker === 0xd9 || offset + 1 >= bytes.length) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new Error("JPEG 段长度无效");
    if (marker === 0xda) {
      hasScan = true;
      break;
    }
    if (startOfFrameMarkers.has(marker)) {
      const height = bytes[offset + 3] * 256 + bytes[offset + 4];
      const width = bytes[offset + 5] * 256 + bytes[offset + 6];
      if (width <= 0 || height <= 0) throw new Error("JPEG 像素尺寸无效");
      dimensions = { width, height };
    }
    offset += length;
  }
  const hasEnd = bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9;
  if (!dimensions) throw new Error("JPEG 中没有可用的尺寸段");
  if (!hasScan || !hasEnd) throw new Error("JPEG 文件不完整");
  return dimensions;
}

export function readImageDimensions(
  data: ArrayBuffer,
  extension: string,
): { width: number; height: number } {
  const bytes = new Uint8Array(data);
  if (extension === "png") return pngDimensions(bytes);
  if (extension === "jpg" || extension === "jpeg") return jpegDimensions(bytes);
  throw new Error(`不支持的素材格式：${extension || "无扩展名"}`);
}

async function scanFile(
  file: UxpFile,
  binaryFormat: string,
  sourceRef: string,
): Promise<InputFileSnapshot> {
  const extension = extensionOf(file.name);
  if (!["png", "jpg", "jpeg"].includes(extension)) return { name: file.name };
  try {
    const data = await file.read({ format: binaryFormat });
    if (!(data instanceof ArrayBuffer)) throw new Error("二进制素材读取结果无效");
    const fingerprint = fingerprintBytes(new Uint8Array(data));
    scannedSources.set(sourceRef, { file, fingerprint, binaryFormat });
    return {
      name: file.name,
      ...readImageDimensions(data, extension),
      sourceRef,
      fingerprint,
    };
  } catch (error) {
    return {
      name: file.name,
      metadataError: error instanceof Error ? error.message : "无法读取文件头",
    };
  }
}

export async function scanInputFolder(
  root: UxpFolder,
  binaryFormat: string,
): Promise<InputGroupSnapshot[]> {
  scannedSources.clear();
  scanSequence += 1;
  const scanId = `scan-${scanSequence}`;
  const rootEntries = await root.getEntries();
  const looseFiles = rootEntries.filter((entry) => entry.isFile);
  if (looseFiles.length > 0) {
    throw new Error(`素材总文件夹根目录不能直接放文件：${looseFiles.map((file) => file.name).join("、")}`);
  }
  const folders = rootEntries.filter((entry) => entry.isFolder) as UxpFolder[];
  if (folders.length === 0) throw new Error("素材总文件夹中没有分组子文件夹");
  folders.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  const groups: InputGroupSnapshot[] = [];
  for (const folder of folders) {
    const entries = await folder.getEntries();
    const files = entries.filter((entry) => entry.isFile) as UxpFile[];
    files.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    const snapshots: InputFileSnapshot[] = [];
    for (const file of files) {
      const sourceRef = `${scanId}:${encodeURIComponent(folder.name)}/${encodeURIComponent(file.name)}`;
      snapshots.push(await scanFile(file, binaryFormat, sourceRef));
    }
    groups.push({
      name: folder.name,
      files: snapshots,
    });
  }
  return groups;
}

export async function resolveScannedInputFile(sourceRef: string, expectedFingerprint: string): Promise<unknown> {
  const source = scannedSources.get(sourceRef);
  if (!source) throw new BatchStoppingError("input-access-expired", "素材来源引用已失效，请重新扫描素材目录");
  if (source.fingerprint !== expectedFingerprint) {
    throw new GroupOperationError("input-snapshot-invalid", "素材内容指纹与扫描记录不一致");
  }
  let data: ArrayBuffer | string;
  try {
    data = await source.file.read({ format: source.binaryFormat });
  } catch (error) {
    throw new GroupOperationError(
      "input-file-read-failed",
      error instanceof Error ? `重新读取素材失败：${error.message}` : "重新读取素材失败",
    );
  }
  if (!(data instanceof ArrayBuffer)) {
    throw new GroupOperationError("input-file-read-failed", "重新读取素材时未获得二进制内容");
  }
  if (fingerprintBytes(new Uint8Array(data)) !== expectedFingerprint) {
    throw new GroupOperationError("input-content-changed", "素材在预检后发生变化，请重新扫描素材目录");
  }
  return source.file;
}

export async function selectAndScanInputRoot(storageOverride?: UxpStorage): Promise<InputGroupSnapshot[] | null> {
  const storage = storageOverride ?? (require("uxp").storage as UxpStorage);
  const root = await storage.localFileSystem.getFolder();
  if (!root) return null;
  return scanInputFolder(root, storage.formats.binary);
}

export async function selectTemplateConfigJson(storageOverride?: UxpStorage): Promise<string | null> {
  const storage = storageOverride ?? (require("uxp").storage as UxpStorage);
  const selected = await storage.localFileSystem.getFileForOpening({ types: ["json"] });
  const file = Array.isArray(selected) ? selected[0] : selected;
  if (!file) return null;
  const text = await file.read({ format: storage.formats.utf8 });
  if (typeof text !== "string") throw new Error("模板配置读取结果不是文本");
  return text;
}
