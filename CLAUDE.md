# object0 — Development Guidelines

object0 is a FOSS desktop S3 bucket manager built with Tauri 2, Vite, React 19,
Tailwind v4, and shadcn/ui (Base UI variant). The UI lives under `src/mainview/`;
the Rust backend under `src-tauri/`.

## Package Manager

Use **`bun`** exclusively. Never run `npm`, `pnpm`, or `yarn`.

```fish
bun install                # install deps
bun add <pkg>              # runtime dep
bun add -d <pkg>           # dev dep
bun run <script>           # run a package.json script
bunx shadcn@latest add <c> # add a shadcn primitive
```

## Quality Checks

Run before every commit:

| Command | What it does |
|---|---|
| `bun run check` | Biome check (lint + format, no fix) |
| `bun run lint` | Biome lint |
| `bun run format` | Biome auto-fix (run instead of fighting Biome) |
| `bun run build` | `tsc && vite build` — typecheck + bundle |
| `cd src-tauri && cargo check` | Rust typecheck |
| `bun run check:all` | check + build + cargo check |

Biome: 2-space indent.

## Commit Convention

**Conventional Commits are required** — the release changelog is generated from
them by `scripts/release/generate-conventional-notes.mjs`. Prefixes:
`feat` (minor), `fix` (patch), `chore`, `refactor`, `docs`, `test`, `perf`,
`ci`, `style`. Breaking changes → major.

### Implementation vs. Bump Commits

Never mix implementation changes with version bumps.

1. Implementation lands as `feat`/`fix`/`refactor`/… commits.
2. A **separate** bump commit touches only the version files:
   `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
   (+ the root package version in `src-tauri/Cargo.lock`, and `bun.lock` if needed). Sync them from the target tag:

   ```fish
   bun run release:sync-version --version vX.Y.Z
   git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml bun.lock
   git commit -m "chore: bump to X.Y.Z"
   ```

3. Tag the bump commit and push:

   ```fish
   git tag vX.Y.Z
   git push && git push --tags
   ```

**The tag is the source of truth.** CI re-runs `sync-version.mjs` from the tag at
build time, so the bump commit and tag must agree — a mismatch ships the wrong
version.

## Build & Release (GitHub Actions)

This fork's `.github/workflows/release.yml` is explicitly dispatched with an
existing exact tag (`vX.Y.Z` or a preview such as `vX.Y.Z-preview.N`). A tag push
alone does not publish a release.

1. Checks out the tag and verifies versions, local regression tests and the pinned Microsoft runtime.
2. Builds a Windows x64 NSIS installer and portable ZIP, with an explicit asset allowlist and SHA256 checksums.
3. Uploads to a draft, verifies downloaded bytes, then publishes. Preview tags stay prereleases and do not replace the latest stable release.

Local release preparation follows the same source/version and package checks.
Do not claim macOS/Linux artifacts, code signing or updater manifests were built
by this Windows-only workflow. Upstream updater endpoints stay disabled.
Inspect the actual `origin` transport and authenticated account before publishing;
do not embed tokens in remotes or scripts, and never push this fork's work to `upstream`.

## Updater Manifest

`bun run updater:manifest` / `bun run updater:verify` maintain the static update feed.

## Conventions

- Failed CI runs and superseded tags stay as historical record — no force-push, no
  tag deletion.
- UI: shadcn/ui primitives under `src/mainview/components/ui/`; add new ones with
  `bunx shadcn@latest add <name>`. Icons: lucide-react. Theming: class-based
  (`.dark` on `<html>`), driven by `useThemeStore`.
