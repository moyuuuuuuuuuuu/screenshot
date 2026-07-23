# 截图工具

Windows 优先的跨平台截图、标注、OCR 与翻译工具。当前桌面版提供微信 4.1.11 风格的图标工具栏、选区与标注、手动滚动长截图、贴图、分享，以及通过签名云 API 完成的 OCR 与翻译。

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

## 云服务配置

复制 `apps/desktop/.env.example` 为 `apps/desktop/.env.local`，配置云 API 地址与请求签名共享密钥。共享密钥仅用于提高滥用门槛，会嵌入桌面客户端，因此不是身份认证秘密，也不是 Coze PAT。Coze PAT 与工作流 ID 只应保留在云服务端，绝不能写入桌面设置、源码或提交记录。

OCR 或翻译会在首次使用时说明并征得同意，然后把所选截图发送到本服务及第三方 Coze。未配置云服务时，这些操作会显示安全错误，不影响本地截图、标注、复制、保存、贴图或分享。

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
