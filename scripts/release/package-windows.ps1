#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BuildDir,
    [Parameter(Mandatory = $true)][string]$OutputDir
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$package = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$tauriConfig = Get-Content -LiteralPath (Join-Path $projectRoot 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$productName = [string]$tauriConfig.productName
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'The package version is not a supported release version.'
}
$buildRoot = (Resolve-Path -LiteralPath $BuildDir).Path
$releaseRoot = if (Test-Path -LiteralPath (Join-Path $buildRoot 'release/object0.exe')) {
    Join-Path $buildRoot 'release'
} elseif (Test-Path -LiteralPath (Join-Path $buildRoot 'object0.exe')) {
    $buildRoot
} else {
    throw 'BuildDir must contain release/object0.exe or object0.exe.'
}
$application = Join-Path $releaseRoot 'object0.exe'
$runtimeRoot = Join-Path $releaseRoot 'WebView2Runtime'
$runtimeExe = Join-Path $runtimeRoot 'msedgewebview2.exe'
if (-not (Test-Path -LiteralPath $runtimeExe -PathType Leaf)) {
    throw 'A fixed WebView2Runtime/msedgewebview2.exe is required for the portable package.'
}
if (((Get-Item -LiteralPath $runtimeRoot).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'The fixed runtime root must be a real directory, not a reparse point.'
}
$compiledVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($application).ProductVersion
if ($compiledVersion -notmatch ('^' + [regex]::Escape($version) + '(?:\.0)?(?:\+.*)?$')) {
    throw "Compiled executable version $compiledVersion does not match package version $version."
}
$installerDirectory = Join-Path $releaseRoot 'bundle/nsis'
$installers = @(Get-ChildItem -LiteralPath $installerDirectory -File -Filter '*.exe' |
    Where-Object { $_.Name -like ($productName + '_' + $version + '_*-setup.exe') })
if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS setup for version $version; found $($installers.Count)."
}
$license = Join-Path $projectRoot 'LICENSE'
$guide = Join-Path $projectRoot 'docs/PORTABLE_ZH.md'
$englishGuide = Join-Path $projectRoot 'docs/PORTABLE_EN.md'
$webviewLicense = Join-Path $projectRoot 'packaging/WEBVIEW2-LICENSE.html'
foreach ($required in @($application, $license, $guide, $englishGuide, $webviewLicense)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Missing input: $required" }
}

# Never collect a whole project or a live application data directory. Only the
# executable, pristine fixed runtime, license and this guide may enter the ZIP.
function Assert-SafePackageEntry([string]$EntryName) {
    $normalized = $EntryName.Replace('\', '/')
    if ($normalized -match '(^|/)\.\.(/|$)' -or $normalized -match '^[/\\]' -or $normalized -match '^[A-Za-z]:') {
        throw "Unsafe archive entry: $EntryName"
    }
    $leaf = ($normalized.TrimEnd('/') -split '/')[-1]
    if ($leaf -match '(?i)^(vault(?:\..*)?|accounts\.local\.json|profiles?\.json|settings\.json|credentials(?:\..*)?|\.env(?:\..*)?|Cookies|History|Local State|Preferences|Secure Preferences|DevToolsActivePort)$' -or
        $leaf -match '(?i)\.(?:log|pem|pfx|p12|key)$' -or
        $normalized -match '(?i)(^|/)(?:\.git|node_modules|User Data|\.config)(/|$)') {
        throw "Application data, credentials or build files are not permitted: $EntryName"
    }
}
$runtimeEntries = @(Get-ChildItem -LiteralPath $runtimeRoot -Recurse -Force)
foreach ($entry in $runtimeEntries) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse points are not permitted in the fixed runtime: $($entry.Name)"
    }
    Assert-SafePackageEntry ([IO.Path]::GetRelativePath($runtimeRoot, $entry.FullName))
}

# Microsoft's fixed runtime itself contains an EBWebView directory. Do not
# mistake those official loader files for a browser user profile. Instead,
# require every runtime byte to match the pristine, pinned build input.
$pristineRuntime = Join-Path $projectRoot 'src-tauri/WebView2Runtime'
$pristineFiles = @(Get-ChildItem -LiteralPath $pristineRuntime -Recurse -File -Force)
$runtimeFiles = @($runtimeEntries | Where-Object { -not $_.PSIsContainer })
if ($pristineFiles.Count -ne $runtimeFiles.Count) { throw 'Runtime contains extra or missing files.' }
foreach ($runtimeFile in $runtimeFiles) {
    $relativeRuntimePath = [IO.Path]::GetRelativePath($runtimeRoot, $runtimeFile.FullName)
    $pristineFile = Join-Path $pristineRuntime $relativeRuntimePath
    if (-not (Test-Path -LiteralPath $pristineFile -PathType Leaf) -or
        (Get-FileHash -LiteralPath $pristineFile -Algorithm SHA256).Hash -ne
        (Get-FileHash -LiteralPath $runtimeFile.FullName -Algorithm SHA256).Hash) {
        throw 'Runtime does not match the pristine build input.'
    }
}

$outputRoot = [IO.Path]::GetFullPath($OutputDir)
$resolvedRuntime = (Resolve-Path -LiteralPath $runtimeRoot).Path
$runtimePrefix = $resolvedRuntime.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if ($outputRoot -eq $resolvedRuntime -or $outputRoot.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'OutputDir must not be inside the fixed runtime input.'
}
if (-not (Test-Path -LiteralPath $outputRoot)) { New-Item -ItemType Directory -Path $outputRoot | Out-Null }
$outputRoot = (Resolve-Path -LiteralPath $outputRoot).Path
$installerName = "object0_${version}_windows_x64_setup.exe"
$portableName = "object0_${version}_windows_x64_portable.zip"
$installerPath = Join-Path $outputRoot $installerName
$portablePath = Join-Path $outputRoot $portableName
$checksumPath = Join-Path $outputRoot 'SHA256SUMS.txt'
foreach ($destination in @($installerPath, $portablePath, $checksumPath)) {
    if (Test-Path -LiteralPath $destination) { throw "Refusing to overwrite release asset: $destination" }
}

$stagingRoot = Join-Path $outputRoot ('.staging-portable-' + [guid]::NewGuid().ToString('N'))
$portableRoot = Join-Path $stagingRoot "object0_${version}_windows_x64_portable"
New-Item -ItemType Directory -Path $portableRoot | Out-Null
Copy-Item -LiteralPath $application -Destination (Join-Path $portableRoot 'object0.exe')
Copy-Item -LiteralPath $runtimeRoot -Destination (Join-Path $portableRoot 'WebView2Runtime') -Recurse
Copy-Item -LiteralPath $license -Destination (Join-Path $portableRoot 'LICENSE')
Copy-Item -LiteralPath $guide -Destination (Join-Path $portableRoot 'README.zh-CN.md')
Copy-Item -LiteralPath $englishGuide -Destination (Join-Path $portableRoot 'README.en.md')
Copy-Item -LiteralPath $webviewLicense -Destination (Join-Path $portableRoot 'WEBVIEW2-LICENSE.html')

Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($portableRoot, $portablePath, [IO.Compression.CompressionLevel]::Optimal, $true)
$archive = [IO.Compression.ZipFile]::OpenRead($portablePath)
try {
    $files = @($archive.Entries | Where-Object { -not $_.FullName.EndsWith('/') })
    foreach ($entry in $archive.Entries) { Assert-SafePackageEntry $entry.FullName }
    $archivePrefix = "object0_${version}_windows_x64_portable/"
    foreach ($entry in $files) {
        if (-not $entry.FullName.StartsWith($archivePrefix, [StringComparison]::Ordinal)) { throw 'ZIP root directory mismatch.' }
        $relative = $entry.FullName.Substring($archivePrefix.Length)
        if ($relative -notin @('object0.exe', 'LICENSE', 'README.zh-CN.md', 'README.en.md', 'WEBVIEW2-LICENSE.html') -and -not $relative.StartsWith('WebView2Runtime/', [StringComparison]::Ordinal)) {
            throw "Unexpected ZIP member: $relative"
        }
    }
    foreach ($expected in @('object0.exe', 'LICENSE', 'README.zh-CN.md', 'README.en.md', 'WEBVIEW2-LICENSE.html', 'WebView2Runtime/msedgewebview2.exe')) {
        if ($null -eq $archive.GetEntry($archivePrefix + $expected)) { throw "Missing ZIP member: $expected" }
    }
    $expectedCount = @($runtimeEntries | Where-Object { -not $_.PSIsContainer }).Count + 5
    if ($files.Count -ne $expectedCount) { throw 'ZIP member count does not match the explicit input allowlist.' }
} finally { $archive.Dispose() }
$verificationRoot = Join-Path $stagingRoot 'extracted-verification'
[IO.Compression.ZipFile]::ExtractToDirectory($portablePath, $verificationRoot)
$extractedRoot = Join-Path $verificationRoot "object0_${version}_windows_x64_portable"
$extractedFiles = @(Get-ChildItem -LiteralPath $extractedRoot -Recurse -File -Force)
foreach ($file in $extractedFiles) {
    Assert-SafePackageEntry ([IO.Path]::GetRelativePath($extractedRoot, $file.FullName))
}
if ($extractedFiles.Count -ne $expectedCount) { throw 'Extracted portable file count mismatch.' }
foreach ($relative in @('object0.exe', 'WebView2Runtime/msedgewebview2.exe')) {
    $before = Join-Path $portableRoot $relative
    $after = Join-Path $extractedRoot $relative
    if ((Get-FileHash -LiteralPath $before -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $after -Algorithm SHA256).Hash) {
        throw "Portable extraction checksum mismatch: $relative"
    }
}
[IO.File]::Copy($installers[0].FullName, $installerPath, $false)
if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -ne
    (Get-FileHash -LiteralPath (Join-Path $portableRoot 'object0.exe') -Algorithm SHA256).Hash) {
    throw 'The portable executable does not match the compiled executable.'
}
$assets = @($installerPath, $portablePath) | ForEach-Object {
    [pscustomobject]@{
        name = [IO.Path]::GetFileName($_)
        path = $_
        bytes = (Get-Item -LiteralPath $_).Length
        sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$checksumText = (($assets | ForEach-Object { $_.sha256 + '  ' + $_.name }) -join "`n") + "`n"
$checksumStream = [IO.File]::Open($checksumPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
try {
    $checksumBytes = [Text.UTF8Encoding]::new($false).GetBytes($checksumText)
    $checksumStream.Write($checksumBytes, 0, $checksumBytes.Length)
} finally { $checksumStream.Dispose() }

# Remove only this invocation's newly created, disposable copy after success.
$resolvedStaging = (Resolve-Path -LiteralPath $stagingRoot).Path
$allowedPrefix = $outputRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not $resolvedStaging.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase) -or
    (Split-Path -Leaf $resolvedStaging) -notlike '.staging-portable-*') { throw 'Staging cleanup escaped OutputDir.' }
Remove-Item -LiteralPath $resolvedStaging -Recurse -Force
[pscustomobject]@{ version = $version; assets = @($assets); checksums = $checksumPath; portableArchiveValidated = $true } | ConvertTo-Json -Depth 5
