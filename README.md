# PSD 裁片印花批量套图

面向 Windows Photoshop 的 UXP 插件，用已登记的成品 PSD 母版批量替换印花并导出固定裁片结果。

当前版本是诊断构建。真实 Photoshop、PSD 与工厂输出组合尚未通过 M0 验证，不能标记为生产可用。

开发环境需要 Node.js 20.19.x、22.12 或更高的 22.x，或 24 及以上版本。

## 开发命令

```powershell
npm install
npm run check
```

`npm run build` 将可加载插件生成到 `dist`。在 UXP Developer Tool 中添加 `dist/manifest.json` 进行本机加载。

## 工作流

1. 登记并验证母版。
2. 选择并预检素材组。
3. 先试套一组。
4. 串行运行批次。
5. 查看结果并重试失败组。

项目规格和任务通过 GitHub Issues 管理。生产能力必须以真实 Photoshop、真实 PSD、工厂文件检查和实物打样证据为准。
