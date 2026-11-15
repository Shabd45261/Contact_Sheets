$ErrorActionPreference = 'Continue'
# Regenerates _CLONE-SOURCES.md at the project root: one row per third-party clone
# under skills\ and extensions\, with its upstream URL and the commit it is at.
# Run this after adding, removing or upgrading a clone.
#
#   powershell -NoProfile -File "D:\Claude Cinematics\cloudstream\scripts\collect_clone_sources.ps1"

$cs   = Split-Path -Parent $PSScriptRoot          # ...\cloudstream
$root = Split-Path -Parent $cs                    # D:\Claude Cinematics
$out  = Join-Path $root '_CLONE-SOURCES.md'
$stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm')

# Only these two trees hold clones. Search them explicitly so that neither the
# cloudstream repo itself nor anything else is picked up as a "clone".
$scanRoots = @(
    (Join-Path $cs   'extensions'),
    (Join-Path $root 'skills')
)

$rows = New-Object System.Collections.Generic.List[object]
foreach ($scan in $scanRoots) {
    if (-not (Test-Path -LiteralPath $scan)) { continue }
    Get-ChildItem -LiteralPath $scan -Recurse -Directory -Filter '.git' -Force -Depth 2 -ErrorAction SilentlyContinue |
        ForEach-Object {
            $repo = $_.Parent.FullName
            $rel  = $repo.Substring($root.Length).TrimStart('\')
            $url  = (git -C $repo remote get-url origin 2>$null)
            if (-not $url) { $url = '(no origin)' }
            $head = (git -C $repo rev-parse --short HEAD 2>$null)
            if (-not $head) { $head = '?' }
            $rows.Add([pscustomobject]@{ Rel = $rel; Url = $url; Head = $head })
        }
}

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Cloned repos that live as folders in this tree')
$lines.Add('')
$lines.Add('Every one of these is a third-party repository, cloned into place. Their file contents')
$lines.Add('are **not** committed: git would have stored each folder as an empty submodule link')
$lines.Add('because of its nested `.git`, so the folders are rebuilt by cloning the URL below instead.')
$lines.Add('')
$lines.Add('Clone URLs and the commit each was at when this file was generated are recorded here so')
$lines.Add('the tree can be rebuilt exactly. Per-folder copies of this information sit in')
$lines.Add('`_REPO.md` next to each clone (regenerate with `scripts\write_repo_records.ps1`).')
$lines.Add('')
$lines.Add('| Path | Upstream | Commit |')
$lines.Add('|---|---|---|')
foreach ($r in ($rows | Sort-Object Rel)) {
    $lines.Add('| ' + $r.Rel + ' | ' + $r.Url + ' | ' + $r.Head + ' |')
}
$lines.Add('')
$lines.Add('Generated ' + $stamp + ' - ' + $rows.Count + ' clones (' +
    ($rows | Where-Object { $_.Rel -like 'skills\*' }).Count + ' skills, ' +
    ($rows | Where-Object { $_.Rel -like 'cloudstream\extensions\*' }).Count + ' extensions).')

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($out, ($lines -join "`r`n"), $utf8)
Write-Output ('Wrote ' + $out + ' with ' + $rows.Count + ' clones')
