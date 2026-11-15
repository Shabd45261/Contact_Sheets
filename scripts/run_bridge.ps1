# Start the localhost Cloudstream bridge.
# Called by start_bridge.bat so PowerShell execution policy only changes here.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

. (Join-Path $PSScriptRoot 'env.ps1')

if (-not $script:CloudstreamNode) { throw 'Node.js not found. Install Node or set CLOUDSTREAM_NODE.' }

$port = $env:PORT
if (-not $port) { $port = '8787' }
$env:PORT = $port

Write-Host ''
Write-Host "Cloudstream bridge -> http://127.0.0.1:$port"
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

if ($env:OPEN_URL) {
    $openUrl = $env:OPEN_URL
    Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @(
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        "Start-Sleep -Seconds 2; Start-Process '$openUrl'"
    ) | Out-Null
}

& $script:CloudstreamNode (Join-Path $root 'app\server.js')
exit $LASTEXITCODE
