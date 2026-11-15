$ErrorActionPreference = 'Stop'
$root = 'D:\Claude Cinematics\cloudstream'
Set-Location -LiteralPath $root
. (Join-Path $root 'scripts\env.ps1')
$env:PORT = '8799'
$node = $script:CloudstreamNode
$proc = Start-Process -FilePath $node -ArgumentList (Join-Path $root 'app\server.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden
$base = 'http://127.0.0.1:8799'
try {
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try { Invoke-RestMethod "$base/health" -TimeoutSec 3 | Out-Null; break } catch { }
    }
    $id = 'https://vegamovies.lease/download-final-table-season-1-hindi-dubbed-series-480p-720p-1080p-web-dl'
    $body = @{ provider = 'vegamovies-cncverse'; id = $id; title = 'Final Table'; season = 1; episode = 1 } | ConvertTo-Json
    $job = Invoke-RestMethod "$base/contact-sheet" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
    Write-Output ("remote job: {0}" -f $job.job)
    $last = $null
    for ($i = 0; $i -lt 1200; $i++) {
        Start-Sleep -Milliseconds 500
        $last = Invoke-RestMethod "$base/jobs/$($job.job)"
        if ($i % 20 -eq 0) { Write-Output ("  {0} {1}% {2}" -f $last.status, $last.progress.percent, $last.progress.stage) }
        if ($last.status -eq 'done' -or $last.status -eq 'error') { break }
    }
    Write-Output ("remote final: {0} {1}%" -f $last.status, $last.progress.percent)
    if ($last.status -eq 'error') { throw $last.error }
    Write-Output ("remote sheet: {0}" -f $last.result.sheetUrl)
    Write-Output ("remote mode: {0} downloaded={1}" -f $last.result.remote, [bool]$last.result.downloaded)
    $file = Get-Item -LiteralPath (Join-Path (Join-Path $root 'data\sheets') $last.result.sheet)
    Write-Output ("remote sheet bytes: {0}" -f $file.Length)
}
catch {
    Write-Output ("REMOTE SHEET TEST FAILED: {0}" -f $_.Exception.Message)
    exit 1
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
