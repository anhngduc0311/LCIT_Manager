param([switch]$Publish)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$tauriPath = Join-Path $projectRoot 'apps/desktop/src-tauri'
$version = (Get-Content -LiteralPath (Join-Path $tauriPath 'tauri.conf.json') -Raw | ConvertFrom-Json).version
if ($version -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw 'Use a stable version in tauri.conf.json.'
}

if (-not $env:TAURI_SIGNING_PRIVATE_KEY) {
    $env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $env:USERPROFILE '.codex/private/lcit-desktop-updater/lcit-manager.key'
    if (-not (Test-Path -LiteralPath $env:TAURI_SIGNING_PRIVATE_KEY -PathType Leaf)) { throw 'LCIT signing key not found.' }
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
}
$env:NEXT_PUBLIC_API_URL = 'https://api.akatruyen.com'
Push-Location -LiteralPath $projectRoot
try {
    $profile = Join-Path $tauriPath 'tauri.neon.conf.json'
    npm.cmd run desktop:build -- --config $profile
    if ($LASTEXITCODE -ne 0) { throw 'The signed Windows build failed.' }
} finally {
    Pop-Location
}

$bundle = Join-Path $tauriPath 'target/release/bundle/nsis'
$installer = Join-Path $bundle "LCIT Manager_${version}_x64-setup.exe"
$signature = (Get-Content -LiteralPath "$installer.sig" -Raw).Trim()
if (-not $signature) { throw 'The installer signature is missing.' }
$name = "LCIT-Manager-$version-x64-setup.exe"
$stageName = 'lcit-update-' + [guid]::NewGuid().ToString('N')
$stage = Join-Path $tauriPath "target/desktop-releases/$stageName"
$null = New-Item -ItemType Directory -Path $stage
Copy-Item -LiteralPath $installer -Destination (Join-Path $stage $name)
$encoding = [System.Text.UTF8Encoding]::new($false)
$manifest = @{
    version = $version
    platforms = @{
        'windows-x86_64' = @{
            url = "https://api.akatruyen.com/desktop-updates/$name"
            signature = $signature
        }
    }
} | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $stage 'latest.json'), $manifest, $encoding)
[System.IO.File]::WriteAllText((Join-Path $stage 'sha256.txt'), (Get-FileHash -LiteralPath $installer).Hash, $encoding)
Write-Output "Release files are ready at $stage"

if ($Publish) {
    $server = 'root@192.168.251.126'
    Push-Location -LiteralPath (Split-Path -Parent $stage)
    try {
        scp.exe -r $stageName "${server}:/var/tmp/"
        if ($LASTEXITCODE -ne 0) { throw 'Upload failed. The current update manifest was not changed.' }
    } finally {
        Pop-Location
    }
    Get-Content -LiteralPath (Join-Path $PSScriptRoot 'publish-update.py') -Raw | ssh.exe $server "python3 - /var/tmp/$stageName"
    if ($LASTEXITCODE -ne 0) { throw 'The server could not publish this release.' }
}
