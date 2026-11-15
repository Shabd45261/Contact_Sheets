$ErrorActionPreference = 'Stop'
$root = 'D:\Claude Cinematics\cloudstream'
Set-Location -LiteralPath $root
. (Join-Path $root 'scripts\env.ps1')
$env:PORT = '8799'
$proc = Start-Process -FilePath $script:CloudstreamNode -ArgumentList (Join-Path $root 'app\server.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try { Invoke-RestMethod 'http://127.0.0.1:8799/health' -TimeoutSec 3 | Out-Null; break } catch { }
    }
    & $script:CloudstreamNode (Join-Path $root 'scripts\test_ui.js')
    if ($LASTEXITCODE -ne 0) { throw "UI test exited $LASTEXITCODE" }
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
