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
    $all = Invoke-RestMethod "$base/search?q=inception&provider=all&limit=3" -TimeoutSec 120
    Write-Output ("all count={0} errors={1}" -f $all.count, $all.errors.Count)
    foreach ($r in $all.results) { Write-Output ("  {0} | {1} | {2}" -f $r.provider, $r.id, $r.title) }
    foreach ($e in $all.errors) { Write-Output ("  ERR {0}: {1}" -f $e.provider, $e.error) }

    $v = Invoke-RestMethod "$base/search?q=final table&provider=vegamovies-cncverse&limit=3" -TimeoutSec 120
    Write-Output ("vega count={0}" -f $v.count)
    if ($v.results.Count -eq 0) { throw 'vega search returned nothing' }
    $hit = $v.results[0]
    Write-Output ("vega hit: {0} | {1}" -f $hit.id, $hit.title)
    $d = Invoke-RestMethod ("$base/title?provider=vegamovies-cncverse&id=" + [uri]::EscapeDataString($hit.id)) -TimeoutSec 120
    Write-Output ("vega detail: {0} type={1} seasons={2} eps={3}" -f $d.item.title, $d.item.type, $d.item.seasons.Count, $d.item.seasons[0].episodes.Count)
    $eps = Invoke-RestMethod ("$base/episodes?provider=vegamovies-cncverse&id=" + [uri]::EscapeDataString($hit.id)) -TimeoutSec 120
    Write-Output ("vega episodes: {0}" -f $eps.seasons[0].episodes.Count)
    $streams = Invoke-RestMethod ("$base/stream?provider=vegamovies-cncverse&id=" + [uri]::EscapeDataString($hit.id) + "&episode=1") -TimeoutSec 180
    Write-Output ("vega streams: {0} first={1}" -f $streams.count, $streams.streams[0].url.Substring(0, [Math]::Min(90, $streams.streams[0].url.Length)))
}
catch {
    Write-Output ("SEARCH TEST FAILED: {0}" -f $_.Exception.Message)
    exit 1
}
finally {
    if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}
