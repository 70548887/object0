## 中文 Windows 定制版

本仓库基于 [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0) 开发，保留原项目 MIT 许可与版权声明。

下载本仓库的 [正式发布版本](https://github.com/70548887/object0/releases)：

- `windows_x64_setup.exe`：简体中文安装包，安装与卸载入口。
- `windows_x64_portable.zip`：完整解压到本地磁盘后双击 `object0.exe`，无需安装应用或另外安装 WebView2。
- 两种格式均内置固定版本 WebView2。账号密码库保存在当前用户的 C 盘配置目录，安装包不包含开发者账号或密钥。
- 下载后可用同页的 `SHA256SUMS.txt` 校验完整性。安装包未配置商业代码签名；自动更新默认停用，请从本仓库手动更新。

详细说明见 [Windows 安装与便携版说明](docs/PORTABLE_ZH.md)。以下保留上游功能与开发文档；本仓库当前正式分发 Windows x64。

<div align="center">

# object0

<img src="public/logo.png" alt="object0 logo" width="192" />

**A free and open-source desktop S3 bucket manager.**

Manage objects across AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2, Google Cloud Storage, and any S3-compatible provider from a single, fast, cross-platform desktop app.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/70548887/object0)](https://github.com/70548887/object0/releases)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey.svg)](#installation)

Built with [Tauri](https://tauri.app) · [Rust](https://www.rust-lang.org) · [Bun](https://bun.sh) · [React](https://react.dev) · [Tailwind CSS](https://tailwindcss.com) · [shadcn/ui](https://ui.shadcn.com) · [Zustand](https://zustand.docs.pmnd.rs)

</div>

---

> **📖 Just want to use the app?** Read the **[User Guide](docs/USER_GUIDE.md)** — a complete, screenshot-free walkthrough of connecting providers, browsing, transferring, syncing, sharing, and shortcuts. The rest of this README is aimed at developers and contributors.

## Highlights

- **Multi-provider**: One app for all your S3-compatible storage
- **Encrypted vault**: AES-256-GCM encryption; API keys never leave the native backend
- **Folder sync**: Bidirectional, Google Drive-style sync with conflict resolution
- **Cross-platform**: Native builds for macOS, Linux, and Windows via Tauri
- **Fast transfers**: Multipart uploads, concurrent job queue, live progress events

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Development](#development)
- [Architecture](#architecture)
- [Project Structure](#project-structure)
- [Scripts](#scripts)
- [License](#license)

## Features

<details>
<summary><strong>Storage & Profiles</strong></summary>

- Multi-provider profile support for AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, Backblaze B2, GCS, and generic S3-compatible endpoints
- Encrypted vault persistence with passphrase-based unlock
- OS keychain integration for optional remembered unlock
- Profile test/validation and default bucket support

</details>

<details>
<summary><strong>Object Browser</strong></summary>

- Table and grid views
- Breadcrumb navigation and folder traversal
- Multi-select, object metadata, rename, delete, create-folder
- Favorites and bucket tabs with state restoration

</details>

<details>
<summary><strong>Transfers & Jobs</strong></summary>

- Upload/download (single and folder)
- Copy/move/cross-bucket transfers
- Archive download support
- Concurrent queue with progress, speed, ETA, cancel, and persisted history

</details>

<details>
<summary><strong>Sync</strong></summary>

- Bucket-to-bucket sync preview + execute
- Folder sync rules with status/conflict/error events
- Tray-aware background lifecycle for long-running sync work

</details>

<details>
<summary><strong>Sharing & UX</strong></summary>

- Presigned share links with expiration options
- QR code generation and share history
- Theme toggle, command palette, keyboard shortcuts, and toast notifications

</details>

## Installation

Download this fork's Windows builds from the [Releases](https://github.com/70548887/object0/releases) page. See the Windows packaging notes above; other platform documentation below describes the upstream project.

| Platform | Architecture | Format |
|----------|-------------|--------|
| macOS | Apple Silicon, Intel | `.dmg` |
| Linux | x64 | `.AppImage` / `.deb` / `.rpm` |
| Windows | x64 | `.msi` / `NSIS .exe` |

### Arch Linux (AUR)

`object0` is also available on AUR as [`object0-bin`](https://aur.archlinux.org/packages/object0-bin).

Install with your AUR helper:

```bash
yay -S object0-bin
# or
paru -S object0-bin
```

Or build/install manually:

```bash
git clone https://aur.archlinux.org/object0-bin.git
cd object0-bin
makepkg -si
```

## Development

### Prerequisites

- [Bun](https://bun.sh)
- [Rust toolchain](https://www.rust-lang.org/tools/install)
- Tauri platform dependencies: https://v2.tauri.app/start/prerequisites/
- Linux only: a Secret Service provider (for example KWallet or GNOME Keyring) for OS keychain unlock

### Setup

```bash
git clone https://github.com/sayedhfatimi/object0.git
cd object0
bun install
```

### Run (Web only)

```bash
bun run dev
```

### Run (Desktop app)

```bash
bun run dev:app
```

### Build

```bash
# Frontend typecheck + production bundle
bun run build

# Native desktop bundles (Tauri)
bun run build:app
```

## Architecture

```
┌──────────────────────────────────────────────┐
│                 Tauri Runtime                │
│                                              │
│  ┌──────────────┐     ┌──────────────────┐   │
│  │ Rust Backend │◄───►│  React Webview   │   │
│  │ (src-tauri)  │ IPC │  (src/mainview)  │   │
│  │              │     │                  │   │
│  │ • Vault      │     │ • Zustand stores │   │
│  │ • S3 ops     │     │ • UI components  │   │
│  │ • Job queue  │     │ • Tailwind/shadcn│   │
│  │ • Sync logic │     │                  │   │
│  └──────────────┘     └──────────────────┘   │
└──────────────────────────────────────────────┘
```

- **Rust backend (`src-tauri`)**: vault, profiles, S3 operations, queueing, folder sync, tray lifecycle, updater hooks
- **React frontend (`src/mainview`)**: application shell, stores, and typed RPC calls/events
- **Shared contracts (`src/shared`)**: RPC schema and shared types

## Project Structure

```
src/
├── main.tsx                # Vite entry
├── mainview/               # React UI
│   ├── app/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   └── stores/
└── shared/                 # RPC/types shared with backend

src-tauri/
├── src/
│   ├── main.rs             # native entry
│   └── lib.rs              # RPC router + backend runtime
├── capabilities/
└── tauri.conf.json
```

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start Vite dev server |
| `bun run dev:app` | Start Tauri desktop app in dev mode |
| `bun run build` | Type-check and build frontend |
| `bun run build:app` | Build desktop bundles with Tauri |
| `bun run check` | Run Biome checks |
| `bun run check:all` | Biome + frontend build + `cargo check` |
| `bun run lint` | Run Biome linter |
| `bun run format` | Format code with Biome |
| `bun run updater:manifest -- ...` | Build/merge static updater manifest |
| `bun run updater:verify -- ...` | Verify hosted updater manifest + artifact URL |

## License

[MIT](LICENSE)
