# 截图工具

Windows 优先的轻量截图、标注、OCR 与中英翻译工具。当前阶段包含可在浏览器运行和测试的截图覆盖层、选区、统一图标工具栏、标注领域模型、Canvas 渲染与 Tauri 2 桌面壳配置。

## 本地开发

需要 Node.js 22 和 pnpm 10：

```bash
pnpm install
pnpm --filter @screenshot/desktop dev
```

浏览器开发模式使用渐变背景代替真实桌面截图。真实屏幕捕获、系统剪贴板、托盘和全局快捷键将在 Windows 原生集成阶段接入。

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
pnpm --filter @screenshot/desktop tauri:build -- --debug
```

当前 Tauri 窗口被配置为隐藏、全屏、透明、无边框、始终置顶且不显示在任务栏中。后续原生层捕获桌面后再显示该覆盖层。
