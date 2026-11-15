# Terminate all running CloudStream local servers.
# Finds node.exe processes running this repo's app\server.js - any port,
# including the per-provider launchers (8787-8791) - and stops them.
# Run this before start.bat when the running server has old code in memory
# (e.g. after editing app\server.js or app\lib\*: backend changes need a restart).
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$serverFile = Join-Path $root 'app\server.js'

# Match node processes whose command line points at this repo's server.js.
# The fallback also catches other spellings of the path (host drive letters,
# subst/mapped drives), so this works from the .bat on the host as well.
function Find-CloudstreamServers {
    $byCmd = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
        $cl = $_.CommandLine
        if (-not $cl) { return $false }
        ($cl -match [regex]::Escape($serverFile)) -or
            ($cl -match 'cloudstream' -and $cl -match 'app[\\/]server\.js')
    }
    # Also catch any node.exe that owns one of the project ports, even if its
    # command line does not mention server.js (e.g. started with a relative path).
    $ids = @(Get-NetTCPConnection -LocalPort (8787..8799) -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object OwningProcess | Sort-Object -Unique)
    $byPort = @()
    if ($ids.Count) {
        $byPort = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
            Where-Object { $ids -contains $_.ProcessId }
    }
    @($byCmd) + @($byPort) | Where-Object { $_ } | Sort-Object ProcessId -Unique
}

# A force-killed process can stay listed for a few seconds while its parent
# still holds its pipes. Owning a LISTEN socket is the true liveness test:
# a dead process owns none, a live node server always owns one.
function Test-StillListening($procId) {
    [bool](Get-NetTCPConnection -OwningProcess $procId -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ''
Write-Host 'Stopping CloudStream local servers...'
Write-Host ''

$procs = @(Find-CloudstreamServers)
if ($procs.Count -eq 0) {
    Write-Host '  No running CloudStream servers found.'
} else {
    foreach ($p in $procs) {
        $cl = $p.CommandLine
        $short = if ($cl.Length -gt 110) { '...' + $cl.Substring($cl.Length - 110) } else { $cl }
        Write-Host "  stopping PID $($p.ProcessId): $short"
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    # Force-kill is asynchronous: wait for all of them, then retry once for
    # any stragglers before judging.
    Wait-Process -Id @($procs | ForEach-Object ProcessId) -Timeout 10 -ErrorAction SilentlyContinue
    $left = @(Find-CloudstreamServers)
    if ($left.Count) {
        foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
        Wait-Process -Id @($left | ForEach-Object ProcessId) -Timeout 5 -ErrorAction SilentlyContinue
    }

    $alive = @(Find-CloudstreamServers | Where-Object { Test-StillListening $_.ProcessId })
    Write-Host ''
    if ($alive.Count) {
        foreach ($p in $alive) { Write-Host "  FAILED   PID $($p.ProcessId) is still listening" }
    } else {
        Write-Host "  Stopped $($procs.Count) CloudStream server(s)."
    }
}

# Final verification: no live CloudStream node process, no busy project ports.
Start-Sleep -Milliseconds 500
$remaining = @(Find-CloudstreamServers | Where-Object { Test-StillListening $_.ProcessId })
$ports = @(8787..8799)
$busy = @($ports | Where-Object { Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
Write-Host ''
if ($remaining.Count -or $busy.Count) {
    if ($remaining.Count) { Write-Host "  Warning: still running: $($remaining.ProcessId -join ', ')" }
    if ($busy.Count) { Write-Host "  Warning: port(s) $($busy -join ', ') are still busy (another process owns them)." }
} else {
    Write-Host '  All CloudStream servers stopped; ports 8787-8799 are free.'
}

Write-Host ''
Write-Host 'Done. Start a fresh server with start.bat or a start_<provider>.bat launcher.'
Write-Host 'If the page in your browser still looks old after restarting, hard-refresh'
Write-Host 'it once (Ctrl+F5) - a cached page keeps showing the old UI.'
