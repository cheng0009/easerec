# DirectorCam 技术架构

> 版本: v0.2 | 更新日期: 2026-09-05
> 本文档描述 **Tauri → Electron 迁移后** 的实际架构。旧版 Rust 实现保留在 `src-tauri/`（已弃用，仅作参考）。

---

## 一、总体结构

```
┌─────────────────────────────────────────────────────┐
│  Electron Main (electron/main.ts → dist-electron/)  │
│  窗口管理 / 全局快捷键 / koffi 全局输入钩子           │
│  ffmpeg 导出子进程 / 设置持久化 / IPC 路由           │
├─────────────────────────────────────────────────────┤
│  Renderer (React 18 + Vite, src/)                   │
│  ├─ UI 组件 (components/)  zustand 全局状态          │
│  ├─ 录制引擎 (recording/Recorder.ts)                │
│  │    getDisplayMedia + getUserMedia + MediaRecorder│
│  └─ Tauri API 兼容垫片 (bridge/*)                   │
├─────────────────────────────────────────────────────┤
│  Overlay 窗口 (dist/overlay.html)                   │
│  透明、置顶、点击穿透 —— 标注特效的单一渲染源         │
└─────────────────────────────────────────────────────┘
```

## 二、窗口体系

| 窗口 | 尺寸 | 特性 | 职责 |
|------|------|------|------|
| 主窗口 | 1280×800 (min 900×600) | 常规 | 控制面板 / 预览 / 时间轴 |
| 迷你窗 | 180×100 | 透明、置顶、无任务栏 | 录制时的悬浮控制条 |
| 覆盖层 | 全屏 | 透明、置顶、`setIgnoreMouseEvents` 点击穿透 | 渲染标注特效，随屏幕一起被录进视频 |

覆盖层的穿透状态由页面通过 `dc-overlay-shield` 消息控制：有特效正在绘制时吞掉鼠标，其余时候穿透。

## 三、Tauri 兼容垫片（迁移关键）

UI 代码保留了 Tauri 风格的 API 调用，由 Vite alias 在构建期路由到 Electron 实现：

| 导入路径 | 垫片 (src/bridge/) | Electron 实现 |
|----------|--------------------|---------------|
| `@tauri-apps/api/core` | invoke.ts | `ipcRenderer.invoke("dc-invoke")` |
| `@tauri-apps/api/event` | event.ts | `ipcRenderer` 事件转发 |
| `@tauri-apps/api/dialog` | dialog.ts | `dialog.showOpenDialog` 等 |
| `@tauri-apps/api/window` / `webviewWindow` | window.ts / webviewWindow.ts | BrowserWindow 操作（含迷你窗） |
| `@tauri-apps/plugin-shell` | shell.ts | `shell.openExternal` / `openPath` |
| `@tauri-apps/plugin-global-shortcut` | globalShortcut.ts | 主进程 GlobalShortcut 注册 |

## 四、录制管线（渲染进程，纯 Web 平台）

`src/recording/Recorder.ts`：

1. **画面源**: `getDisplayMedia`（主进程 `setDisplayMediaRequestHandler` 授权屏幕/窗口源）
2. **摄像头/麦克风**: `getUserMedia`
3. **系统声音**: 通过 display-media 请求带回的 loopback 音频轨
4. **合成**: GPU canvas 合成视频轨 + `SpringCamera`（弹簧相机跟随/防抖）+ `SmartZoom`（智能缩放）
5. **编码**: `MediaRecorder` → VP9 WebM（默认 4K/60fps/40 Mbps，音频 192 kbps）
6. **特效**: 桌面覆盖层是特效的单一来源（`desktopOverlayActive` 模式）——覆盖层是真实 OS 窗口，被屏幕采集自然录进去，合成 canvas 不重复绘制

## 五、全局输入

- **全局快捷键**: Electron `globalShortcut`，注册失败自动重试（Electron 启动早期监听器未就绪）；仍失败的（如被其他应用占用的裸 F 键）回退到页面内 keydown。裸的可打印键（数字/字母）禁止注册为全局热键（会吞掉系统输入），由页面 keydown + koffi 钩子兜底。
- **koffi 全局钩子**: FFI 调用 `user32.dll!GetAsyncKeyState`，检测全局左键点击和 ESC——步骤序号模式"一次物理点击 = 一个标记"、ESC 退出标注模式在主窗口未聚焦时也能工作。koffi 缺失时功能优雅降级。
- **默认快捷键**（可在设置中自定义，存 `shortcuts.json`）:
  F9 录制开关 / F1 Focus Mode / F2、F3 倒带（**当前为占位，未实现**）/ Ctrl+1 放大镜 / Ctrl+2 步骤序号 / Ctrl+3 荧光笔 / Ctrl+R 涟漪 / Ctrl+4/5/6 缩放档位 / = 缩放循环

## 六、导出管线（主进程）

`electron/main.ts` 的 `runExport`：spawn 打包的 `ffmpeg.exe`（查找顺序: `src-tauri/ffmpeg.exe` → `resources/ffmpeg.exe` → `resources/bin/ffmpeg.exe`）。

当前能力：
- WebM → MP4（libopenh264 软编码 H.264 + AAC，`+faststart`）
- 可选静音裁剪（`silenceremove` 滤镜，阈值来自设置）

**尚未接入导出的**（UI 已有占位）: 字幕烧录、片头片尾拼接（IntroOutroPanel 目前仅存 localStorage）、快进/倒带/隐私标记剪辑 —— 见 `ROADMAP.md` 的剪辑决策列表。

## 七、持久化

| 文件/目录 | 位置 | 内容 |
|-----------|------|------|
| settings.json | `~/DirectorCam/` | 通用设置 + `shortcuts`（UI 保存后优先于 shortcuts.json） |
| shortcuts.json | `~/DirectorCam/` | 用户手编快捷键（settings.json 无 shortcuts 时生效） |
| recordings/ | `~/DirectorCam/recordings/` | 录像文件 |
| 录像元数据 | （规划）与录像同名的 `edits.json` | 剪辑决策列表，见 ROADMAP |

## 八、迁移缺口清单（Electron 版待补齐）

| 功能 | Tauri 版 | Electron 版现状 |
|------|----------|-----------------|
| 倒带 | Rust Ring Buffer + PTS 重置 | `Recorder.rewind()` 空实现（MediaRecorder 无法截断） |
| Studio Mode 桌面级功能 | Win32: 隐藏图标 / 16:9 排布 / 窗口外模糊 | 仅应用内 Focus Mode 视觉遮罩，IPC 为空操作 |
| 隐私护盾（自动检测 API Key/邮箱/密码） | 规划中 | 未实现 |
| 字幕（ASR + 烧录） | 规划中（faster-whisper） | 设置字段已预留（subtitleEnabled/modelPath），管线未实现 |
| 片头片尾导出拼接 | 规划中 | 仅 UI 配置，未接入 runExport |

补齐计划见 `ROADMAP.md`。
