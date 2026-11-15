# Cloudstream runtime environment (dot-source this file)
#   . "D:\Claude Cinematics\cloudstream\scripts\env.ps1"
# Adds the workspace Pillow install plus the host Python, Node, ffmpeg/ffprobe,
# yt-dlp and Chromium to this process only. It installs nothing and does not
# change machine/user PATH.

$script:CloudstreamRoot = Split-Path -Parent $PSScriptRoot

# --- Python: prefer the host install exposed through the C: mapping ---
$pyCandidates = @(
    'C:\HostDrives\C\Python313\python.exe',
    (Get-Command python.exe -ErrorAction SilentlyContinue).Source
)
$script:CloudstreamPython = $pyCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1

# --- Node: prefer the host install exposed through the C: mapping ---
$nodeCandidates = @(
    'C:\HostDrives\C\Program Files\nodejs\node.exe',
    (Get-Command node.exe -ErrorAction SilentlyContinue).Source
)
$script:CloudstreamNode = $nodeCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1

# --- Pillow: installed into the workspace, not the host ---
$script:CloudstreamPyLib = Join-Path $CloudstreamRoot 'tools\py'
if (Test-Path -LiteralPath $script:CloudstreamPyLib) {
    $env:PYTHONPATH = $script:CloudstreamPyLib
}

# --- ffmpeg: prefer workspace build, else the host WinGet package (real path) ---
$ffCandidates = @()
$localFF = Join-Path $CloudstreamRoot 'tools\ffmpeg\bin'
if (Test-Path -LiteralPath (Join-Path $localFF 'ffmpeg.exe')) {
    $ffCandidates += $localFF
}
$wingetRoots = @(
    'C:\Users\DELL\AppData\Local\Microsoft\WinGet\Packages',
    'C:\HostDrives\C\Users\DELL\AppData\Local\Microsoft\WinGet\Packages'
)
foreach ($wingetRoot in $wingetRoots) {
    if (-not (Test-Path -LiteralPath $wingetRoot)) { continue }
    $wingetFF = Get-ChildItem -LiteralPath $wingetRoot -Directory -Filter 'Gyan.FFmpeg*' -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -Recurse -Depth 3 -Filter 'ffmpeg.exe' -File -ErrorAction SilentlyContinue } |
        Select-Object -First 1
    if ($wingetFF) { $ffCandidates += $wingetFF.DirectoryName; break }
}
$cmdFF = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source
if ($cmdFF) { $ffCandidates += (Split-Path -Parent $cmdFF) }
$script:CloudstreamFFmpeg = $ffCandidates | Select-Object -First 1

# --- yt-dlp: required by the youtube provider (stream resolution) ---
$ytdlpCandidates = @(
    (Join-Path $CloudstreamRoot 'tools\yt-dlp\yt-dlp.exe'),
    'C:\Users\DELL\AppData\Local\Microsoft\WinGet\Links\yt-dlp.exe',
    'C:\HostDrives\C\Users\DELL\AppData\Local\Microsoft\WinGet\Links\yt-dlp.exe',
    (Get-Command yt-dlp.exe -ErrorAction SilentlyContinue).Source
)
$script:CloudstreamYtdlp = $ytdlpCandidates |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
    Select-Object -First 1

# --- Chromium: required only by the 4KHDHub mediator path ---
$script:CloudstreamChrome = @(
    (Get-Command chrome.exe -ErrorAction SilentlyContinue).Source,
    'C:\HostDrives\C\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\HostDrives\C\Program Files (x86)\Google\Chrome\Application\chrome.exe',
    'C:\HostDrives\C\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\HostDrives\C\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

# --- PATH additions for child processes (server, ffmpeg, python) ---
$pathAdds = @()
if ($script:CloudstreamFFmpeg) { $pathAdds += $script:CloudstreamFFmpeg }
if ($script:CloudstreamPython) { $pathAdds += (Split-Path -Parent $script:CloudstreamPython) }
if ($script:CloudstreamNode) { $pathAdds += (Split-Path -Parent $script:CloudstreamNode) }
foreach ($add in $pathAdds) {
    if ($env:PATH -notlike "*$add*") { $env:PATH = "$add;$env:PATH" }
}
if ($script:CloudstreamYtdlp) {
    $ytdlpDir = Split-Path -Parent $script:CloudstreamYtdlp
    if ($env:PATH -notlike "*$ytdlpDir*") { $env:PATH = "$ytdlpDir;$env:PATH" }
}

# --- Export for the bridge server ---
$env:CLOUDSTREAM_ROOT = $script:CloudstreamRoot
if ($script:CloudstreamPython) { $env:PYTHON = $script:CloudstreamPython }
if ($script:CloudstreamNode) { $env:CLOUDSTREAM_NODE = $script:CloudstreamNode }
if ($script:CloudstreamFFmpeg) {
    $env:FFMPEG_PATH = Join-Path $script:CloudstreamFFmpeg 'ffmpeg.exe'
    $env:FFPROBE_PATH = Join-Path $script:CloudstreamFFmpeg 'ffprobe.exe'
}
if ($script:CloudstreamChrome) { $env:CHROME_PATH = $script:CloudstreamChrome }
if ($script:CloudstreamYtdlp) { $env:YTDLP_PATH = $script:CloudstreamYtdlp }

if (-not $script:CloudstreamPython) { Write-Warning 'Python not found. Set PATH or install Python.' }
if (-not $script:CloudstreamNode) { Write-Warning 'Node not found. Set PATH or install Node.' }
if (-not $script:CloudstreamFFmpeg) { Write-Warning 'ffmpeg not found. Place it in tools\ffmpeg\bin or install via WinGet.' }
if (-not $script:CloudstreamChrome) { Write-Warning 'Chrome/Edge not found. 4KHDHub mediator resolution will fail until CHROME_PATH is set.' }
if (-not $script:CloudstreamYtdlp) { Write-Warning 'yt-dlp not found. The YouTube provider will fail until it is installed (winget install yt-dlp) or YTDLP_PATH is set.' }

Write-Host "Cloudstream root : $script:CloudstreamRoot"
Write-Host "Python           : $script:CloudstreamPython"
Write-Host "Node             : $script:CloudstreamNode"
Write-Host "Pillow path      : $script:CloudstreamPyLib"
Write-Host "ffmpeg bin       : $script:CloudstreamFFmpeg"
Write-Host "yt-dlp           : $script:CloudstreamYtdlp"
Write-Host "Chromium         : $script:CloudstreamChrome"
