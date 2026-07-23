# Windows 发布检查清单

本文档用于在任意开发设备上复现构建、下载产物并完成 Windows
安装验收。E1 只建立 CI、安装包构建和验收流程，不发布 GitHub
Release。

## 1. 构建基线

要求：

- Windows 10/11 x64
- Node.js 22
- pnpm 10.13.1
- Rust stable `x86_64-pc-windows-msvc`
- Visual Studio C++ Build Tools
- MSI 构建所需的 Windows VBSCRIPT 可选功能

从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @screenshot/cloud exec vitest run --maxWorkers=1 --minWorkers=1
pnpm --filter @screenshot/desktop exec vitest run --maxWorkers=1 --minWorkers=1
pnpm typecheck
pnpm build
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
```

本地构建未签名调试安装包：

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --bundles msi,nsis --no-sign
```

预期路径：

```text
apps/desktop/src-tauri/target/debug/bundle/msi/*.msi
apps/desktop/src-tauri/target/debug/bundle/nsis/*-setup.exe
```

基础 Tauri 配置继续使用 `bundle.targets: "all"`，避免破坏后续
macOS/Linux 打包；Windows workflow 通过
`--bundles msi,nsis` 只生成 MSI 和 NSIS。

## 2. 图标和安装器配置

Tauri bundle 显式使用现有图标：

```text
icons/32x32.png
icons/128x128.png
icons/128x128@2x.png
icons/icon.icns
icons/icon.ico
```

`src-tauri/icons` 还保留完整的 Windows Store/Square 图标集合。
Windows 安装器禁止降级，并使用静默
`downloadBootstrapper` WebView2 安装模式。该模式在目标机器没有
WebView2 时需要联网下载运行时。

## 3. GitHub Actions

### CI

`.github/workflows/ci.yml` 在以下情况运行：

- 向任意分支发起或更新 pull request
- 推送到 `main`

CI 在 `windows-latest` 上依次执行完整 cloud/desktop 测试、类型检查、
两个 workspace 构建、Rust 格式检查、测试和 Clippy。新提交会取消同一
分支上尚未结束的旧 CI。

### Windows 产物

`.github/workflows/windows-release.yml` 在以下情况运行：

- 手动 `workflow_dispatch`
- 推送 `v*` tag

每次运行都使用 Tauri `--no-sign` 生成：

| Artifact | 内容 | 保留时间 |
| --- | --- | --- |
| `windows-unsigned-debug` | 未签名 debug MSI、NSIS | 14 天 |
| `windows-signed-release` | 已签名 release MSI、NSIS | 30 天 |

只有三个签名 secrets 都非空时才会创建
`windows-signed-release`。缺少任意一个 secret 时，签名 job 被跳过，
unsigned job 仍应成功；不得把未签名文件命名为 signed artifact。

## 4. Authenticode secrets

在 GitHub 仓库的 Actions secrets 中配置：

| Secret | 内容 |
| --- | --- |
| `WINDOWS_CERTIFICATE` | PFX 的 Base64 文本 |
| `WINDOWS_CERTIFICATE_PASSWORD` | PFX 导出密码 |
| `WINDOWS_CERTIFICATE_THUMBPRINT` | 证书指纹，空格可保留 |

无需仓库变量。不要提交 PFX、密码、指纹或生成后的签名配置。

可在本机生成 Base64 文件：

```powershell
certutil -encode .\windows-signing.pfx .\windows-signing.base64.txt
```

workflow 仅在签名分支中把 PFX 导入当前用户证书存储，运行时生成
Tauri 配置，使用 SHA-256 和 DigiCert 时间戳服务器。无论构建是否
成功，最后一步都会删除 PFX、临时配置和本次导入的证书。

## 5. 签名检查

下载并解压 artifact 后执行：

```powershell
Get-AuthenticodeSignature .\path\to\installer.msi |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate

Get-AuthenticodeSignature .\path\to\installer-setup.exe |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

期望：

- `windows-signed-release` 中两个文件的 `Status` 都是 `Valid`
- `SignerCertificate.Thumbprint` 与仓库 secret 一致
- `TimeStamperCertificate` 非空
- `windows-unsigned-debug` 显示 `NotSigned`

## 6. 本次自动验证记录（2026-07-23）

本机执行组合命令：

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --bundles msi,nsis --no-sign
```

编译和前端构建成功，但 WiX 在生成 MSI 时退出，因此组合命令没有继续
生成 NSIS。完整的非敏感阻塞信息是：

```text
failed to bundle project: failed to run
C:\Users\Administrator\AppData\Local\tauri\WixTools314\light.exe
```

本机没有生成 MSI。继续验证前，应在“设置 > 应用 > 可选功能 >
更多 Windows 功能”中启用 VBSCRIPT，重启后重新运行组合命令；若仍
失败，再检查 WiX `light.exe` 的系统依赖和 Windows 事件日志。

为隔离 MSI 工具问题，随后执行：

```powershell
pnpm --filter @screenshot/desktop tauri:build --debug --bundles nsis --no-sign
```

NSIS 构建成功，精确产物为：

```text
apps/desktop/src-tauri/target/debug/bundle/nsis/截图工具_0.1.0_x64-setup.exe
```

该文件为预期的未签名内部测试包，大小 2,865,994 bytes，
`Get-AuthenticodeSignature` 返回 `NotSigned`。这只证明本机可以生成
NSIS 文件，不代表已经完成安装、升级、卸载或干净账户验收。

## 7. 干净账户安装验收

以下步骤必须在未安装过本工具的 Windows 测试账户中分别对 MSI 和
NSIS 执行。不要复用开发账户的配置或凭据。

1. 安装当前版本，记录安装器文件名、应用版本和 Windows 版本。
2. 启动应用，确认托盘图标出现且启动时没有残留黑色截图窗口。
3. 使用默认 `Alt+Shift+A` 截图，再保存并复制到 Paint。
4. 修改快捷键，退出并重启，确认新快捷键仍生效。
5. 断网后确认本地截图、涂鸦、马赛克、复制和保存仍可使用。
6. 断网调用 OCR/翻译，确认错误可恢复且选区/标注历史不丢失。
7. 首次联网调用 OCR/翻译，确认上传前显示隐私提示；取消时不上传。
8. 安装更高版本覆盖当前版本，确认设置和自定义快捷键保留。
9. 尝试安装更低版本，确认安装器拒绝降级。
10. 从“设置 > 应用”卸载，确认应用、托盘项和启动入口消失。

## 8. 手工验收矩阵

E1 编写阶段没有执行干净账户安装、升级或卸载测试。下表全部保留为
后续 E2 手工验收，不得仅凭构建成功勾选。

| ID | 验收项 | 预期 | 当前状态 |
| --- | --- | --- | --- |
| M01 | Windows 10，单屏，100% DPI | MSI 安装、启动、截图、卸载正常 | 未执行 |
| M02 | Windows 11，单屏，125%/150% DPI | 选区和输出像素位置正确 | 未执行 |
| M03 | 双屏，副屏在主屏左侧/上方 | 负坐标截图和保存正确 | 未执行 |
| M04 | 双屏混合 DPI | 跨屏选择、复制、保存正确 | 未执行 |
| M05 | 干净账户 MSI 安装/卸载 | 无残留进程、托盘项和启动入口 | 未执行 |
| M06 | 干净账户 NSIS 安装/卸载 | 无残留进程、托盘项和启动入口 | 未执行 |
| M07 | MSI/NSIS 升级 | 设置和快捷键保留 | 未执行 |
| M08 | 降级安装 | 被安装器拒绝 | 未执行 |
| M09 | WebView2 已有/缺失 | 已有时直接启动；缺失时 bootstrapper 安装 | 未执行 |
| M10 | 默认和自定义快捷键 | 启动、重启后均能唤起截图 | 未执行 |
| M11 | 剪贴板占用/保存目录拒绝访问 | 显示可恢复错误，不丢失编辑状态 | 未执行 |
| M12 | cloud 不可达 | 本地功能可用，OCR/翻译优雅失败 | 未执行 |
| M13 | 首次上传隐私提示 | 未确认前不上传；确认只持久化许可 | 未执行 |
| M14 | 日志隐私检查 | 日志不含截图像素、OCR 文本、token 或 PFX | 未执行 |
| M15 | Authenticode | signed MSI/NSIS 状态为 `Valid` 且有时间戳 | 未执行 |

## 9. 已知延期项

用户已确认长截图仍有未完全解决的拼接/生命周期问题，并要求先完成
主要功能和发布管线再返回处理。本次 E1 不修改长截图实现，也不把长
截图列为已通过验收。最终发布前必须单独复测手动滚动、自动拼接、
结束/取消、剪贴板输出及多屏蒙层行为。
