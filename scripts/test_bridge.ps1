$ErrorActionPreference = 'Stop'
$root = 'D:\Claude Cinematics\cloudstream'
Set-Location -LiteralPath $root
. (Join-Path $root 'scripts\env.ps1')
$env:PORT = '8799'
$env:OPEN_URL = ''
$node = $script:CloudstreamNode
$proc = Start-Process -FilePath $node -ArgumentList (Join-Path $root 'app\server.js') -WorkingDirectory $root -PassThru -WindowStyle Hidden
$base = 'http://127.0.0.1:8799'
try {
    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        try { $h = Invoke-RestMethod "$base/health" -TimeoutSec 3; $ready = $true; break } catch { }
    }
    if (-not $ready) { throw 'server did not start' }
    Write-Output ("health: v{0} providers={1} ffmpeg={2} chrome={3}" -f $h.version, $h.providers, $h.ffmpeg.ok, $h.chrome.ok)
    $prov = Invoke-RestMethod "$base/providers"
    Write-Output ("providers: {0}" -f (($prov.providers | ForEach-Object { $_.id }) -join ', '))
    $homeResp = Invoke-WebRequest "$base/" -TimeoutSec 5
    Write-Output ("home: {0} bytes, ui={1}" -f $homeResp.RawContentLength, ($homeResp.Content -match 'Cloudstream <span>bridge'))
    $body = @{ source = 'data/intel/sheet-test/test.mp4'; title = 'Synthetic Test'; provider = 'local'; season = 0; episode = 0 } | ConvertTo-Json
    $job = Invoke-RestMethod "$base/contact-sheet" -Method Post -ContentType 'application/json' -Body $body
    Write-Output ("job: {0} {1}" -f $job.job, $job.status)
    $last = $null
    for ($i = 0; $i -lt 240; $i++) {
        Start-Sleep -Milliseconds 500
        $last = Invoke-RestMethod "$base/jobs/$($job.job)"
        if ($last.status -eq 'done' -or $last.status -eq 'error') { break }
    }
    Write-Output ("job final: {0} {1}%" -f $last.status, $last.progress.percent)
    if ($last.status -eq 'error') { throw $last.error }
    Write-Output ("sheet: {0}" -f $last.result.sheet)
    Write-Output ("url: {0}" -f $last.result.sheetUrl)
    $file = Get-Item -LiteralPath (Join-Path (Join-Path $root 'data\sheets') $last.result.sheet)
    Write-Output ("sheet bytes: {0}" -f $file.Length)
    $img = Invoke-WebRequest ("$base" + $last.result.sheetUrl) -TimeoutSec 10
    Write-Output ("sheet http: {0} bytes {1}" -f $img.StatusCode, $img.RawContentLength)
    Write-Output ("timestamps: {0}" -f (($last.result.timestamps | Select-Object -First 6) -join ', '))
}
catch {
    Write-Output ("TEST FAILED: {0}" -f $_.Exception.Message)
    exit 1
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
