#requires -Version 7.0
param([Parameter(Mandatory)][string]$AssetsDir, [Parameter(Mandatory)][string]$ValidatorExe, [string]$NotesFile)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$assets = (Resolve-Path -LiteralPath $AssetsDir).Path
$validator = (Resolve-Path -LiteralPath $ValidatorExe).Path
if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY) -and [string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY_PATH)) { throw 'Provide dedicated signing credentials in the protected release environment.' }
if ([string]::IsNullOrWhiteSpace($env:YUNCANG_UPDATER_PUBLIC_KEY)) { throw 'Build with the dedicated pinned public key before signing a release.' }
function Sign-And-Verify([string]$File) {
    if (Test-Path -LiteralPath ($File + '.sig')) { throw 'Refusing to replace an existing signature.' }
    & bun run tauri signer sign $File
    if ($LASTEXITCODE -ne 0) { throw 'Release signature generation failed.' }
    $signature = $File + '.sig'
    if (-not (Test-Path -LiteralPath $signature)) { throw 'Signer did not produce a detached signature.' }
    # This is a no-UI helper mode in the exact compiled release executable;
    # private keys never enter argv, logs, source, manifests or release assets.
    $arguments = @('--yuncang-verify-update-file', ('"' + $File + '"'), ('"' + $signature + '"'))
    $check = Start-Process -FilePath $validator -ArgumentList $arguments -WindowStyle Hidden -PassThru -Wait
    if ($check.ExitCode -ne 0) { throw 'Cryptographic signature verification failed with the compiled public key.' }
}
Push-Location $root
try {
    foreach ($name in @("object0_${version}_windows_x64_setup.exe", "object0_${version}_windows_x64_portable.zip")) { Sign-And-Verify (Join-Path $assets $name) }
    $args = @((Join-Path $root 'scripts/updater/build-github-update-manifest.mjs'), $assets, $version)
    if ($NotesFile) { $args += (Resolve-Path -LiteralPath $NotesFile).Path }
    & bun @args
    if ($LASTEXITCODE -ne 0) { throw 'Manifest generation failed.' }
    Sign-And-Verify (Join-Path $assets 'yuncang-update.json')
    Write-Output 'Both packages and the update manifest were signed and verified with the compiled public key.'
} finally { Pop-Location }
