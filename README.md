# PSD 裁片印花批量套图

面向 Windows Photoshop 的 UXP 插件，用已登记的成品 PSD 母版批量替换印花并导出固定裁片结果。

当前 `0.1.0` 是诊断预发布。真实 Photoshop、PSD 与工厂输出组合尚未通过 M0 验证，**不能标记为生产可用**。

开发和测试环境需要 Node.js 20.19.x、22.12 或更高的 22.x，或 24 及以上版本。为了让 ZIP 字节可重复，`0.1.0` 诊断归档只允许在已验证的 Windows + Node.js `v24.14.0` 组合和干净 Git 工作区生成。

## 开发命令

```powershell
npm ci
npm run check
```

`npm run build` 将符合 Manifest v5 目录结构的候选插件生成到 `dist`。可在 UXP Developer Tool 中添加 `dist/manifest.json` 尝试本机加载；真实加载证据仍由 Issue #11 验收。

`npm run release:build` 会先完成格式检查、类型检查、全量测试和生产构建，再生成：

- `release/psd-piece-print-batch-v0.1.0-diagnostic/`
- `release/psd-piece-print-batch-v0.1.0-diagnostic.zip`

解压 ZIP 后，可在 UXP Developer Tool 中选择根目录的 `manifest.json` 进行待验收加载。构建或加载成功不代表真实生产能力已验证。

## 工作流

1. 登记并验证母版。
2. 选择并预检素材组。
3. 先试套一组。
4. 串行运行批次。
5. 查看结果并重试失败组。

## 文档

- [操作与恢复手册](docs/OPERATOR_GUIDE.md)
- [兼容性与证据](docs/COMPATIBILITY.md)
- [诊断预发布状态](docs/RELEASE_STATUS.md)
- [模板配置示例](examples/template-config.example.json)

## 自动化证据

`tests/stability.test.ts` 覆盖 20 组连续串行运行、A/B/C 后单独 A、替换阶段故障注入和无串图验证。其他测试覆盖输入读取、预检、Photoshop 适配器边界、输出提交、批次恢复和五阶段 UI。

项目规格和任务通过 GitHub Issues 管理。生产能力必须以真实 Photoshop、真实 PSD、工厂文件检查和实物打样证据为准。
