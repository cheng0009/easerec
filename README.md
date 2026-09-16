<p align="center">
  <img src="src/assets/banner.png" alt="简录 EaseRec" width="720" />
</p>

<h1 align="center">简录 EaseRec</h1>

<p align="center">
  <b>让知识输出回归纯粹。</b><br/>
  科技博主的实时录屏导播台 —— <b>录屏即成片</b>。
</p>

<p align="center">
  <img alt="Electron" src="https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white" />
  <img alt="React" src="https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=white" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-6-646CFF?logo=vite&logoColor=white" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white" />
  <img alt="Platform" src="https://img.shields.io/badge/Platform-Windows-0078D4?logo=windows&logoColor=white" />
</p>

> EaseRec is a desktop screen-recording studio for knowledge creators. Record at native quality, mark edits live, and export a finished MP4 in one click — smart camera tracking, privacy masks, subtitles, and a branded outro included.

---

## 简介

简录 EaseRec 是一款面向**知识输出创作者**的 Windows 录屏导播工具。它的理念是「**录屏即成片**」：

- **录制时**只记录 1:1 原始画面与编辑意图（鼠标轨迹、隐私标记、快进/暂停区间），几乎不占用 CPU，长时间录制不卡顿；
- **导出时**再统一重放与剪辑，用离线相机与 ffmpeg 逐帧渲染出平滑的镜头跟随、隐私遮挡、字幕与品牌片尾。

所有数据与录像都保存在本地（`~/DirectorCam/`），不上传云端。

## 核心特性

- **🎬 Focus Mode（纯净舞台，F1）**：一键隐藏桌面图标并铺底纯色背景，画面干净专业。
- **🎥 智能跟焦**：录制时仅记录鼠标轨迹，导出时用同一套弹簧相机 + 智能缩放算法逐帧渲染平滑推近/跟焦；预览区虚线框所见即导出。竖版 9:16 自动取景。
- **✂️ 标记式剪辑**：录制中随手打标记，导出时统一生效——
  - `F10` 暂停 / 恢复（暂停段自动剪除）
  - `F6` 隐私遮挡（框选区域，自动回溯定位内容首次出现时刻）
  - `Shift+F6` 隐私整段剪除（口误 / 私密操作）
  - `F4` 快进（导出时强制压缩为 3–5 秒 + 嗖嗖音效）
- **🖍 实时标注特效**：放大镜、步骤序号、荧光笔、点击涟漪——渲染在全屏透明覆盖层上，随屏幕一起被录进视频。
- **🎥 摄像头画中画**：位置、大小、正圆/圆角、边框可配置。
- **📦 一键导出 MP4**：H.264 + AAC，兼容 B 站 / YouTube 直接上传；支持 EBU R128 响度归一、竖版 9:16。
- **💬 烧录字幕**：本地 whisper 离线识别 + 可选 LLM 在线校正（只改错字、不动时间戳），支持自定义字体/字号/颜色/描边/位置与热词表。
- **🏷 品牌片尾**：成片结尾自动附加 2.8 秒「简录 EaseRec」动画（跟随界面语言，含内置 Logo）。
- **🗂 成片库**：所有录像以卡片归档，支持回放、导出、定位目录与未完成录像恢复。
- **🌐 双语界面**：简体中文 / English 实时切换。
- **🛡 崩溃可恢复**：录像实时落盘，意外退出后下次启动可恢复已录内容。

## 技术栈

| 层 | 技术 |
|----|------|
| 桌面外壳 | Electron 44（主进程：窗口管理 / 全局快捷键 / koffi 全局输入钩子 / ffmpeg 导出子进程） |
| 界面 | React 18 + TypeScript + Vite 6，zustand 状态管理，i18next 国际化 |
| 录制引擎 | `getDisplayMedia` + `getUserMedia` + `MediaRecorder`（默认 4K/60fps VP9 WebM） |
| 覆盖层 | 独立透明置顶窗口，`setIgnoreMouseEvents` 点击穿透 |
| 导出 | 打包的 `ffmpeg.exe`（libopenh264 H.264 + AAC，`+faststart`） |
| 字幕 | 本地 `whisper-cli`（GGML 模型）+ 可选 LLM 校正 |

## 快速开始

### 环境要求

- Windows 10 21H2+（推荐 Windows 11）
- Node.js 18+
- 内存 8 GB（推荐 16 GB），磁盘 1 GB+ 可用
- 普通用户权限即可，**无需管理员**

### 安装与运行

```powershell
# 1. 安装依赖
npm install

# 2. 下载运行所需的二进制（未纳入版本库，见下）
powershell -File scripts/download-ffmpeg.ps1     # 导出依赖 ffmpeg.exe
powershell -File scripts/download-whisper.ps1    # 字幕依赖 whisper-cli + 模型（可选）

# 3. 开发模式（构建主进程 + Vite 热更新 + 拉起 Electron）
npm run dev
```

### 构建 / 运行生产产物

```powershell
npm run build            # 构建渲染进程 (dist/)
npm run build:electron   # 构建主进程 (dist-electron/)
npm start                # 运行生产产物
npm run dist:win         # 打包 Windows 安装包 (NSIS)
```

### 关于被排除的二进制

为控制仓库体积，以下文件**未提交**到版本库，首次运行前请用脚本获取：

| 文件 | 用途 | 获取方式 |
|------|------|----------|
| `src-tauri/ffmpeg.exe` / `ffprobe.exe` | 视频导出 | `scripts/download-ffmpeg.ps1` |
| `src-tauri/whisper/`（`whisper-cli.exe` + `ggml-base.bin` 等） | 字幕识别 | `scripts/download-whisper.ps1` |

## 项目结构

```
.
├─ electron/            # Electron 主进程（窗口 / IPC / 导出管线 / 字幕）
├─ src/                 # 渲染进程（React UI + 录制引擎 + 覆盖层）
│  ├─ components/       # UI 组件
│  ├─ recording/        # 录制引擎、弹簧相机、智能缩放
│  ├─ bridge/           # Tauri 风格 API 的 Electron 兼容垫片
│  └─ styles/           # 主题与全局样式
├─ public/              # 静态资源（overlay.html / mini.html 等）
├─ src-tauri/           # 旧 Tauri 实现（已弃用，保留参考）+ 内置二进制
├─ scripts/             # 开发 / 构建 / 依赖下载脚本
└─ docs/                # 用户手册、架构、路线图
```

## 测试与质量

```powershell
npm run typecheck   # TypeScript 类型检查
npm test            # Vitest 单元 / 集成测试
```

## 文档

- [用户使用手册](docs/USER_GUIDE.md)
- [技术架构](docs/ARCHITECTURE.md)
- [路线图](docs/ROADMAP.md)

## 数据与隐私

所有设置与录像均保存在本地：

| 路径 | 内容 |
|------|------|
| `~/DirectorCam/settings.json` | 应用设置 |
| `~/DirectorCam/recordings/` | 录像文件 |

应用不主动上传任何内容（仅在启用 LLM 字幕校正时，才会将识别文本发送至所配置的服务）。

## 许可证

本项目暂未指定开源许可证（All rights reserved）。
