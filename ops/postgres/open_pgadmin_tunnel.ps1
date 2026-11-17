$ErrorActionPreference = 'Stop'
$lcitBinary = Get-Command cloudflared.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
if (-not $lcitBinary) {
    $lcitBinary = Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'
}
if (-not (Test-Path -LiteralPath $lcitBinary)) {
    throw 'Install cloudflared first: winget install --id Cloudflare.cloudflared --exact --source winget'
}
if (Get-NetTCPConnection -LocalPort 15432 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 15432 is already in use. The tunnel may already be running.'
}
Write-Host 'pgAdmin: host 127.0.0.1, port 15432, database lcit_manager.'
Write-Host 'Keep this window open while using pgAdmin. Sign in to Cloudflare when prompted.'
& $lcitBinary access tcp --hostname db.akatruyen.com --url 127.0.0.1:15432
if ($LASTEXITCODE -ne 0) { throw "cloudflared exited with code $LASTEXITCODE" }
