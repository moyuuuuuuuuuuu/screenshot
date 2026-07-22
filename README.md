# 截图工具

Windows 优先的跨平台截图、标注、OCR 与翻译工具。当前桌面版提供微信 4.1.11 风格的图标工具栏、选区与标注、手动滚动长截图、贴图、分享，以及通过扣子（Coze）工作流完成的 OCR、翻译和隐私处理。

跨设备继续开发请从 [项目接力路线图](docs/superpowers/plans/2026-07-21-project-continuation-roadmap.md) 开始，其中包含当前进度、新设备环境准备、后续阶段、验收命令和可直接复制的恢复提示词。

## 本地开发

需要 Node.js 22 和 pnpm 10：

```bash
pnpm install
pnpm --filter @screenshot/desktop dev
```

浏览器开发模式使用渐变背景代替真实桌面截图；Windows Tauri 运行时使用真实屏幕捕获、系统剪贴板、托盘和全局快捷键。

## 使用

- 默认截图快捷键：`Alt+Shift+A`。
- 在托盘菜单中打开设置，可录制并保存新的全局快捷键；若快捷键被其他程序占用，应用会显示注册失败提示。
- 选择区域后点击滚动截图图标，保持目标窗口可见并由用户手动滚动；工具会自动识别移动、去重并拼接，支持编辑、保存、取消和完成。
- 工具栏全部使用统一尺寸的线性图标，悬停时仍会显示辅助提示。

## 扣子（Coze）配置

在设置中填写扣子 API 地址、访问令牌和工作流 ID。OCR、翻译与隐私处理会把当前选区图像提交给对应工作流；访问令牌仅保存在当前设备的本地配置中，不应提交进仓库。未配置凭据时，这些操作会给出明确提示，不影响本地截图和标注功能。

## 验证

```bash
pnpm test -- --run
pnpm typecheck
pnpm --filter @screenshot/desktop build
```

## Tauri 桌面构建

Windows 桌面构建还需要：

- Rust stable MSVC 工具链
- Microsoft C++ Build Tools
- WebView2 Runtime

安装后运行：

```bash
pnpm --filter @screenshot/desktop tauri dev
pnpm --filter @screenshot/desktop tauri:build --debug
```

Tauri 截图覆盖层为透明、无边框、始终置顶且不显示在任务栏中；捕获时会先隐藏覆盖层，避免把工具自身截入画面。
