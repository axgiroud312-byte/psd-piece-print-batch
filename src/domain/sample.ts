import type { PreflightPayload } from "./types";

export const samplePreflightPayload: PreflightPayload = {
  template: {
    schemaVersion: 1,
    templateId: "shirt-demo-one-size",
    version: "0.1.0-draft",
    masterFingerprint: "UNVERIFIED-DEMO-FINGERPRINT",
    garmentPieces: [
      { id: "piece-front", name: "前片" },
      { id: "piece-back", name: "后片" },
      { id: "piece-left-sleeve", name: "左袖" },
      { id: "piece-right-sleeve", name: "右袖" },
    ],
    artworkEntries: [
      {
        id: "entry-front",
        name: "前片入口",
        inputKey: "front",
        contentSourceId: "source-front",
        required: true,
        canvas: { width: 2400, height: 3200 },
        fit: { mode: "strict", anchor: { kind: "center" } },
      },
      {
        id: "entry-back",
        name: "后片入口",
        inputKey: "back",
        contentSourceId: "source-back",
        required: true,
        canvas: { width: 2400, height: 3200 },
        fit: { mode: "cover", anchor: { kind: "center" } },
      },
      {
        id: "entry-sleeves",
        name: "袖片共享入口",
        inputKey: "sleeves",
        contentSourceId: "source-sleeves",
        required: true,
        canvas: { width: 1800, height: 2400 },
        fit: { mode: "cover", anchor: { kind: "offset", x: 0, y: -24 } },
      },
    ],
    instances: [
      {
        id: "instance-front",
        garmentPieceId: "piece-front",
        artworkEntryId: "entry-front",
        layerPath: ["PRINT｜生产内容", "前片", "ART｜印花智能对象实例"],
      },
      {
        id: "instance-back",
        garmentPieceId: "piece-back",
        artworkEntryId: "entry-back",
        layerPath: ["PRINT｜生产内容", "后片", "ART｜印花智能对象实例"],
      },
      {
        id: "instance-left-sleeve",
        garmentPieceId: "piece-left-sleeve",
        artworkEntryId: "entry-sleeves",
        layerPath: ["PRINT｜生产内容", "左袖", "ART｜印花智能对象实例"],
      },
      {
        id: "instance-right-sleeve",
        garmentPieceId: "piece-right-sleeve",
        artworkEntryId: "entry-sleeves",
        layerPath: ["PRINT｜生产内容", "右袖", "ART｜印花智能对象实例"],
      },
    ],
  },
  groups: [
    {
      name: "款式001-蓝花",
      files: [
        { name: "front.png", width: 2400, height: 3200, ppi: 72, sourceRef: "款式001-蓝花/front.png", fingerprint: "demo-front-blue" },
        { name: "back.jpg", width: 3000, height: 3000, ppi: 300, sourceRef: "款式001-蓝花/back.jpg", fingerprint: "demo-back-blue" },
        { name: "sleeves.png", width: 1800, height: 2600, ppi: 150, sourceRef: "款式001-蓝花/sleeves.png", fingerprint: "demo-sleeves-blue" },
      ],
    },
    {
      name: "款式 002（待补图）",
      files: [
        { name: "front.png", width: 2400, height: 3200, ppi: 300, sourceRef: "款式002/front.png", fingerprint: "demo-front-pending" },
        { name: "sleeves.jpg", width: 1800, height: 2400, ppi: 72, sourceRef: "款式002/sleeves.jpg", fingerprint: "demo-sleeves-pending" },
        { name: "说明.txt" },
      ],
    },
  ],
};
