# Yuncang (云仓)

[简体中文](README.md) | **English**

**One desktop workspace for multiple cloud-storage accounts and buckets.**

Yuncang puts Qiniu Kodo, Cloudflare R2, Amazon S3 and compatible connections in one window: select an account, switch buckets, browse files, upload/download, inspect transfer destinations and create sharing links.

Based on [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0), with the upstream MIT license and copyright notices preserved.

[Download preview](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.2) · [Release notes](docs/RELEASE_v1.7.0-preview.2.md) · [MIT license](LICENSE)

> **Preview status:** several Qiniu application workflows are connected, but this is not a complete Kodo console or proof of compatibility with every public/private deployment. Back up important data and validate permissions and operations in a dedicated test bucket first.
>
> **Local credential warning:** this version saves AK/SK **in plaintext on this computer** in `accounts.local.json`. Normal use does not require a Yuncang passphrase or recovery key. Any program that can read the file can read its credentials. Do not share it, commit it or include it in a release package.

## Fixes in this preview

- Queued copy/move jobs bind both account revisions and providers. Archive downloads and queued deletes receive equivalent protection; editing an account rejects stale jobs instead of silently retargeting them.
- Entering or returning from a folder immediately clears old rows, selection and operation targets, preventing actions on former-folder files while the new listing loads.
- The object browser owns automatic listing for folder, breadcrumb, back, tab and page-size changes, avoiding duplicate requests while preserving manual refresh and pagination.

## Supported storage services

Adding an account starts with a provider choice, not a mandatory Qiniu form. Each account has its own bucket list and connection settings.

| Provider | Connection and bucket handling |
|---|---|
| **Qiniu Kodo** | Native APIs for public cloud, account bucket discovery and per-bucket region resolution; explicit private/restricted-identity paths with the limitations below. |
| **Cloudflare R2** | S3-compatible API, multiple accounts and buckets; region is normally `auto`. Bucket-scoped credentials can specify a default bucket. |
| **Amazon S3** | AWS S3 API with the corresponding region and access credentials. |
| **DigitalOcean Spaces** | The region's S3-compatible Endpoint. |
| **MinIO** | Your own MinIO S3 service. |
| **Google Cloud Storage** | Enabled **S3/XML interoperability with HMAC credentials**, not Google OAuth or the native JSON API. |
| **Backblaze B2** | The region's S3-compatible API. |
| **Custom S3-compatible storage** | An explicit Endpoint, Region and credentials; operations depend on the service implementation. |

A supported connection type does not imply identical features across providers. Bucket listing, object access and link signing depend on the actual credentials, region and server policies.

## Product features

### Multiple accounts and buckets

- Switch accounts in the sidebar and browse each account's spaces/buckets.
- Open several bucket tabs and browse folders with the existing search, details, sorting and pagination interface.
- Qiniu bucket rows include region and permission hints. Native names and S3 identifiers remain distinct rather than treating a display name as an API identifier.

### Transfers and destination tracking

- Choose files with Upload, or **drag multiple computer files directly onto the bucket content area or its blank space** to upload to the current folder.
- The drag overlay shows the destination bucket/folder. Changing accounts, buckets or folders does not silently retarget an existing gesture.
- Use Upload Folder for directories, subject to the provider's implemented capabilities. A dropped directory is not disguised as a regular file upload.
- Job rows retain the **account name, provider, bucket and full object path captured when the job was created**, with Copy location. Switching or renaming accounts later does not rewrite that snapshot.
- Old jobs explicitly show missing historical account/location information; the current page is never used to guess it.
- S3 connections retain existing copy, move, delete and synchronization workflows. Unfinished Qiniu operations are explicitly disabled as described below.

### Sharing and usage

- Single-file links, copying and QR codes. S3 signed links have an application limit of seven days and remain subject to server and credential expiry.
- Qiniu origin, CDN and test domains can be selected per bucket; the first available entry is selected by default. HTTP displays a plaintext-transport warning and is never an automatic downgrade from HTTPS.
- Confirmed public, unprotected Qiniu resources use public URLs: **the client cannot enforce an expiry on public access**. Private/protected resources use expiring signatures. The native 30-day signing cap is application policy, not an availability guarantee.
- The status bar shows usage, object count, source and refresh state. Incomplete official statistics remain partial or fall back to an explicitly identified bounded scan; failed reads are not reported as zero.
- Light/dark themes, instant Chinese/English switching, keyboard operation and narrow-window layouts.

## Current Qiniu Kodo scope

This preview keeps Yuncang's Tauri/Rust architecture and references [Qiniu Kodo Browser](https://github.com/qiniu/kodo-browser) for workflows and protocol behavior. It **does not embed its Electron client**.

Connected workflows:

- **AK/SK one-click connection** for ordinary public accounts, with bucket/region discovery and basic file listings.
- Native file upload. Public native permanent-credential uploads above 5 MiB use durable multipart jobs with pause and manual resume.
- Downloads through configured or discovered download domains, with Range-based durable recovery for public native downloads.
- Single-file links and domain selection with explicit public/private behavior.
- Public read-only directory-share creation, extraction-code login, scoped browsing and single-file download.
- Six-category official usage/object statistics and an explicitly identified bounded-scan fallback.
- Explicit scoped S3 bucket bindings for restricted accounts and Session Tokens. Native names, S3 IDs, regions and Endpoints must be configured deliberately.

Remaining limitations:

- Private-cloud and restricted-identity paths primarily have local mock-contract coverage. **Target private deployments have not completed real-environment acceptance.** Uploads for binding mode, private cloud and temporary credentials remain unavailable.
- Private share creation, private/S3 durable transfer recovery, Qiniu cross-bucket/cross-cloud copy/move/sync, recursive directory management, rate limiting, full preview and controlled text editing are incomplete.
- Destructive mirror synchronization stays disabled. A disabled button is not an implemented capability; do not use this preview for production mirror cleanup.
- Domain binding, certificates, test-domain expiry, file-type restrictions and server access policies can still affect downloads and sharing. Generating a URL is not verification of its external availability.

Details: [Qiniu uploads](docs/QINIU_RESUMABLE_UPLOADS.md) · [Range downloads](docs/QINIU_RANGE_DOWNLOADS.md) · [Directory sharing](docs/QINIU_DIRECTORY_SHARING.md) · [File links](docs/QINIU_SHARE_LINK_FIXES.md) · [Usage](docs/QINIU_USAGE.md) · [Job locations](docs/JOB_LOCATION_SNAPSHOTS.md).

## Windows downloads and use

Preview: [**v1.7.0-preview.2**](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.2). It does not replace the existing stable [v1.6.0](https://github.com/70548887/object0/releases/tag/v1.6.0); older packages do not contain all features described here.

- [Windows x64 installer](https://github.com/70548887/object0/releases/download/v1.7.0-preview.2/object0_1.7.0-preview.2_windows_x64_setup.exe): follow the setup wizard; an uninstall entry is provided.
- [Windows x64 portable ZIP](https://github.com/70548887/object0/releases/download/v1.7.0-preview.2/object0_1.7.0-preview.2_windows_x64_portable.zip): **extract the entire archive** to a writable local folder, then run `object0.exe`. Keep the complete adjacent `WebView2Runtime` folder; no separate WebView2 installation is needed.
- [SHA256 checksums](https://github.com/70548887/object0/releases/download/v1.7.0-preview.2/SHA256SUMS.txt): compare each downloaded file.

Windows 10/11 x64. Packages are not commercially code-signed and Windows may show an unknown publisher. Check the repository source and SHA256 without disabling system protection. See the [Windows guide](docs/PORTABLE_EN.md).

### Quick start

1. Launch directly into local account management. An old encrypted vault can be imported once with its original Yuncang passphrase or skipped; the original file is retained and a recovery key is not mandatory.
2. Choose Add account, select Qiniu, R2, S3 or another provider, then enter its connection details. Ordinary public Qiniu needs only AK/SK and Connect; private/restricted identities use Qiniu advanced settings.
3. Select an account and bucket in the sidebar, open a folder and upload/download or drop computer files.
4. Inspect job status, errors and the captured account/bucket destination in the task panel.
5. Choose Chinese or English under Settings → Language. This README also has a language link at the top.

Language switching does not translate account names, bucket names, filenames, object keys, URLs or credentials.

## Data and upgrades

- Windows accounts are saved in `%USERPROFILE%\.config\object0\accounts.local.json`, in plaintext by default. Old `vault.enc` is retained only as an optional import source.
- Portable means no installation, not portable accounts. Release packages contain no preconfigured account, credentials, vault or user jobs.
- Installer and portable editions share application identity and local configuration. Run only one edition at a time; finish transfers and back up settings before upgrading.
- New versions can read jobs without location snapshots. Older versions may reject native checkpoints with new fields; do not delete account or task files to force a downgrade.
- The upstream automatic updater is disabled by default. Download updates manually from this repository.

## Development and verification

**Tauri 2 · Rust · React · TypeScript · Tailwind CSS**. Use **Bun**, not npm, pnpm or yarn.

```sh
bun install --frozen-lockfile
bun run test:frontend
bun run build
cargo test --manifest-path src-tauri/Cargo.toml --release --lib --locked
bun run tauri dev
```

Windows builds require the fixed WebView2 runtime in `packaging/windows-runtime.json`. The latest feature-stage local checks passed **433 Rust tests with one ignored**, and **284 frontend tests / 27 isolated regression groups**. These are local and mock-contract results, not acceptance of every real cloud or installer environment. Refer to the [version's release notes](docs/RELEASE_v1.7.0-preview.2.md) for verification scope.

## License and acknowledgements

[MIT](LICENSE). Thanks to the original **object0** author and contributors. This fork preserves upstream copyright notices and does not claim upstream code as original work. Qiniu references are recorded in [Qiniu sources](src-tauri/src/qiniu/SOURCES.md). Microsoft WebView2 is redistributed under separate terms included with Windows packages.
