$ErrorActionPreference = 'Continue'
$cs    = 'D:\Claude Cinematics\cloudstream'
$stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm')

$repos = ([System.IO.File]::ReadAllText((Join-Path $cs 'config\repos.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json).repos
$byId  = @{}
foreach ($r in $repos) { $byId[$r.id] = $r }

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('# Extension repositories')
$lines.Add('')
$lines.Add('Index of every folder under `extensions\`. Each one is a third-party repository;')
$lines.Add('the folder contents are **not** committed (they are restored by cloning), only this')
$lines.Add('index is. A copy of its own row also sits in each folder as `_REPO.md`, written by')
$lines.Add('`scripts\write_repo_records.ps1`.')
$lines.Add('')
$lines.Add('Restore everything:')
$lines.Add('')
$lines.Add('```powershell')
$lines.Add('cd "D:\Claude Cinematics\cloudstream"')
$lines.Add('python scripts\index_repos.py')
$lines.Add('python scripts\clone_all.py')
$lines.Add('```')
$lines.Add('')
$lines.Add('| Folder | Repo name | Region | Git URL | Branch | Commit at record time |')
$lines.Add('|---|---|---|---|---|---|')

foreach ($d in (Get-ChildItem (Join-Path $cs 'extensions') -Directory -ErrorAction SilentlyContinue | Sort-Object Name)) {
    $id = $d.Name
    $head = ''
    if (Test-Path (Join-Path $d.FullName '.git')) {
        $h = (git -C $d.FullName rev-parse --short HEAD 2>$null)
        if ($h) { $head = '`' + $h + '`' }
    }
    if ($byId.ContainsKey($id)) {
        $r = $byId[$id]
        $br = '/'
        if ($r.branch) { $br = $r.branch }
        $lines.Add('| `' + $id + '` | ' + $r.name + ' | ' + $r.region + ' | ' + $r.git + ' | ' + $br + ' | ' + $head + ' |')
    }
    elseif ($id -eq 'youtube') {
        $lines.Add('| `youtube` | *(bridge-native output root, not a clone)* | — | — | — | — |')
    }
    else {
        $lines.Add('| `' + $id + '` | *(not in repos.json)* | — | see `_REPO.md` | — | ' + $head + ' |')
    }
}

$lines.Add('')
$lines.Add('Generated ' + $stamp + '.')
$lines | Set-Content -LiteralPath (Join-Path $cs 'extensions\REPOS.md') -Encoding UTF8
Write-Output ('Wrote extensions\REPOS.md with ' + $byId.Count + ' repo entries')
