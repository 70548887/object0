# Yuncang (云仓)

[简体中文](README.md) | **English**

**A desktop workspace for managing multiple cloud-storage accounts.**

Yuncang brings compatible S3 and Cloudflare R2 accounts into one desktop application. It is a customized fork of [sayedhfatimi/object0](https://github.com/sayedhfatimi/object0); the original MIT license and copyright notices are preserved.

## Download

Get the Windows x64 installer or portable ZIP from [GitHub Releases](https://github.com/70548887/object0/releases).

- **Installer:** a guided Windows installation with an uninstall entry.
- **Portable ZIP:** extract the entire archive to a writable local directory and run `object0.exe`. Keep the adjacent `WebView2Runtime` folder. No separate WebView2 installation is required.
- Verify downloads against `SHA256SUMS.txt` on the same release page.

Previously published v1.6.0 packages still carry the historical **object0** name and Chinese-only UI. The rename and runtime language switch described here are in the latest source; published release files are not silently replaced. Internal executable names, repository URLs and data identifiers remain unchanged for compatibility.

## Language

The interface defaults to **Simplified Chinese**. Choose **Settings → Language → English** to switch immediately. A language selector is also available before unlocking the vault. Your choice is saved locally and restored on restart.

Switching language does not translate account names, bucket names, file names, object keys, URLs or credentials. Existing forms and transfer state are retained.

## Features

- Multiple AWS S3, Cloudflare R2 and S3-compatible accounts.
- File browsing, upload, download, copy, move and folder operations.
- An encrypted local credential vault, account details and connection testing.
- Transfer queues, folder synchronization and conflict handling.
- Expiring share links and QR codes; validity up to 7 days.
- Bucket usage and object counts through bounded S3 scans, with optional official R2 analytics.
- Light and dark themes, keyboard controls and responsive desktop dialogs.

## Getting started

1. Launch the app and create or unlock your local vault.
2. Add a storage account and enter its provider, endpoint and access credentials.
3. For R2, use `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` and region `auto`; specify the default bucket if credentials are bucket-scoped.
4. Test the connection, save the account and select a bucket.

Connection success and available operations depend on the permissions granted by your provider. Failed reads are shown as errors, not as zero usage.

## Data and compatibility

- Existing encrypted accounts remain in `%USERPROFILE%\.config\object0` on Windows.
- The application identifier, OS keychain service and browser preference keys retain their historical IDs to preserve existing data.
- Portable means the program does not need installation; credentials are not stored beside the EXE or carried in the ZIP.
- Run only one installed or portable instance at a time. Finish transfers and exit the old version before updating.
- The app's upstream automatic updater is disabled by default. Download customized updates from this repository.
- Current release packages are unsigned; Windows may show an unknown publisher. Check the repository source and SHA256 without disabling system protection.

R2's **10 GB-month** Standard-storage allowance is an account-wide billing allowance, not a per-bucket capacity limit. Scanning objects may incur list-request charges; official analytics can lag behind changes.

## Development

The application uses **Tauri 2 + Rust + React + TypeScript + Tailwind CSS**. Use **Bun**, not npm, pnpm or yarn.

```sh
bun install --frozen-lockfile
bun run build
bun run tauri dev
bun test tests/share-expiration.test.ts tests/share-expiration-i18n.test.ts tests/i18n.test.ts
```

Windows distribution also requires the pinned fixed WebView2 runtime described by `packaging/windows-runtime.json`. See [Windows distribution notes](docs/PORTABLE_ZH.md) and [development conventions](CLAUDE.md).

## Verification and limitations

UI language switching is tested with local sample data. Real S3/R2 operations require your own valid credentials; no user secrets are included in the repository or release archives. Detailed verification and platform coverage are recorded in each release's notes.

## License and attribution

[MIT](LICENSE). Based on **object0** by its original authors and contributors. Microsoft WebView2 is redistributed under its own terms, included with the Windows packages. The fork does not claim original authorship of upstream code.
