# Yuncang for Windows

Version: **1.7.0-preview.3**. This is a preview of Qiniu integration and desktop workflows, not a compatibility guarantee for every real cloud environment. Existing v1.6.0 and preview.2 release assets are not replaced and do not contain all new features.

> **Credential warning: AK/SK are saved in plaintext in the local `accounts.local.json` by default. Any program that can read the file can read its keys. Never share, upload or distribute account configuration with a package.**

## Installer

Run `object0_1.7.0-preview.3_windows_x64_setup.exe` and follow the Chinese setup wizard. The application supports Chinese/English switching in Settings and provides an uninstall entry.

Finish transfers and exit the old application before installing or changing versions. Packages contain no preconfigured account, credentials, vault or user jobs, and installation does not intentionally delete existing settings.

## Portable ZIP

**Extract the entire** `object0_1.7.0-preview.3_windows_x64_portable.zip` into a writable local folder, then run its `object0.exe`. Exit the old application before overwriting or extracting a replacement.

- Keep the complete adjacent `WebView2Runtime` directory. The fixed Microsoft Edge WebView2 runtime is included; no separate installation is required.
- Do not run from an archive viewer or copy only the EXE.
- Windows 10/11 x64. The UI can open offline; cloud access requires network connectivity and valid permissions.
- Portable does not mean portable accounts. Configuration stays under the current Windows user's `%USERPROFILE%\.config\object0`, not in the ZIP.
- Installer and portable editions share configuration. Run only one instance at a time.

## Fixes in this preview

Since preview.2: a full-width title, compact sidebar and address above the action bar; favorites, recent items, transfers and share history in the main list. The blank-space context menu offers refresh and permitted folder/text creation. Text is limited to 1 MiB UTF-8 (`txt` / `md` / `markdown`). Qiniu text creation/editing is unavailable; S3 conditional creation never overwrites an existing name, and existing-text editing is R2-only with conditional saves and draft retention on conflicts. Folder creation depends on provider/identity permissions. Saving share history is off by default and requires opt-in; opening it never automatically deletes expired entries. Cleanup is manual and the top sharing Sheet remains.

The update UI shows the compiled version and stable/preview channels, but there is no dedicated updater signing configuration in this release: **automatic download/installation is disabled; upgrade manually**. Late ready events after cancellation must not restore the install button. Local tests are not full real-Windows upgrade acceptance.

This version binds queued copy/move identities, protects archive downloads and queued deletes from account changes, clears old file rows and action targets on folder navigation, and avoids duplicate automatic listings. If account settings change, reconfirm any rejected stale jobs; rejection is not successful completion.

## First use

1. Normal startup opens local plaintext account management without password setup or a recovery-key gate.
2. Add account first offers the provider choice: Qiniu Kodo, Cloudflare R2, Amazon S3 and other providers are directly available.
3. Ordinary public Qiniu needs AK/SK and Connect. Private deployments, restricted buckets and Session Tokens use Qiniu advanced settings; this does not mean all such deployments have completed acceptance testing.
4. Select a bucket in the sidebar and browse files, or drop computer files into the content area to upload to the current folder. Use Upload Folder for directories.
5. New job details preserve the captured account, provider, bucket and object path, with Copy location. Fields absent from old records are explicitly marked as not recorded.

Qiniu file sharing selects the first available download domain by default. HTTP shows an unencrypted-transport warning. Public resources use public URLs without a client-enforced expiry; private/protected resources use expiring signatures and remain subject to server/domain policies.

## Existing data and upgrades

- Normal accounts are in `%USERPROFILE%\.config\object0\accounts.local.json`, in plaintext. Do not treat that file as password-protected storage.
- Old encrypted `vault.enc` is retained and can be imported once with the original Yuncang passphrase or skipped. That passphrase is not a Qiniu SecretKey, and a recovery key is not mandatory.
- Missing old passwords cannot decrypt old data. Do not delete/reset the old vault or send passwords/keys in chat.
- Back up configuration and unfinished jobs before upgrading. New versions can read old jobs with missing fields; older executables may reject new native checkpoints with added display metadata. Do not use an older version to resume those new records.
- Qiniu cross-cloud, recursive directory, editing and private-deployment capabilities remain incomplete. Validate in a dedicated test bucket first; do not run production mirror cleanup.

## Integrity and source

Download matching installer, portable ZIP and `SHA256SUMS.txt` from [this repository's release page](https://github.com/70548887/object0/releases/tag/v1.7.0-preview.3).

```powershell
Get-FileHash -Algorithm SHA256 .\object0_1.7.0-preview.3_windows_x64_setup.exe
Get-FileHash -Algorithm SHA256 .\object0_1.7.0-preview.3_windows_x64_portable.zip
```

Compare each hash with the checksum file. Packages are not commercially Windows code-signed; do not disable system protection to bypass an unknown-publisher warning.

## Licenses and updates

Yuncang preserves object0's MIT license and copyright notices. Microsoft WebView2 terms are included as `WEBVIEW2-LICENSE.html`. Its fixed runtime does not update itself; use later complete packages to obtain updates. Software-update signing is also unconfigured and is separate from Windows commercial code signing. Download manually from this fork, compare SHA256, and exit the old application before installation or complete extraction. See [updater boundaries](UPDATER.md).

Failed usage reads are not reported as zero. Check the UI's data source, scan scope and delay information. See the [README](../README.en.md) and [release notes](RELEASE_v1.7.0-preview.3.md) for feature boundaries.
