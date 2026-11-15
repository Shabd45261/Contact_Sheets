$ErrorActionPreference = 'Continue'
$root  = 'D:\Claude Cinematics'
$cs    = Join-Path $root 'cloudstream'
$stamp = (Get-Date -Format 'yyyy-MM-dd HH:mm')

# ---------- extensions ----------
$repos = [System.IO.File]::ReadAllText((Join-Path $cs 'config\repos.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$byId  = @{}
foreach ($r in $repos.repos) { $byId[$r.id] = $r }

$extRoot = Join-Path $cs 'extensions'
$written = 0
foreach ($d in (Get-ChildItem $extRoot -Directory -ErrorAction SilentlyContinue)) {
    $id  = $d.Name
    $gitDir = Join-Path $d.FullName '.git'
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Source repository: ' + $id)
    $lines.Add('')

    if ($id -eq 'youtube') {
        $lines.Add('**Not a git clone.** This folder is the output root of the bridge-native')
        $lines.Add('YouTube provider (`app\lib\providers\youtube.js`). It holds the provider''s')
        $lines.Add('`clips\`, `contact-sheets\` and `pdfs\` output and is recreated automatically the')
        $lines.Add('first time the bridge runs a YouTube job. Nothing to clone.')
    }
    elseif ($byId.ContainsKey($id)) {
        $r = $byId[$id]
        $lines.Add('| Field | Value |')
        $lines.Add('|---|---|')
        $lines.Add('| Repo name | ' + $r.name + ' |')
        $lines.Add('| Region | ' + $r.region + ' |')
        $lines.Add('| Git URL | ' + $r.git + ' |')
        $lines.Add('| Branch | ' + $(if ($r.branch) { $r.branch } else { '(default)' }) + ' |')
        $lines.Add('| repo.json | ' + $r.repoJson + ' |')
        if ($r.web) { $lines.Add('| Web | ' + $r.web + ' |') }
        if (Test-Path -LiteralPath $gitDir) {
            $head = (git -C $d.FullName rev-parse --short HEAD 2>$null)
            if ($head) { $lines.Add('| Commit at record time | `' + $head + '` |') }
        }
        $lines.Add('')
        $lines.Add('## Restore')
        $lines.Add('')
        $lines.Add('Handled automatically by `scripts\clone_all.py` (reads `config\repos.json`).')
        $lines.Add('To restore just this one, from the `cloudstream` folder:')
        $lines.Add('')
        $lines.Add('```powershell')
        if ($r.branch) {
            $lines.Add('git clone --depth 1 --single-branch --branch ' + $r.branch + ' ' + $r.git + ' extensions\' + $id)
        } else {
            $lines.Add('git clone --depth 1 ' + $r.git + ' extensions\' + $id)
        }
        $lines.Add('```')
    }
    else {
        $url = (git -C $d.FullName remote get-url origin 2>$null)
        $lines.Add('Not listed in `config\repos.json`. Local clone remote:')
        $lines.Add('')
        $lines.Add('```')
        $lines.Add($(if ($url) { $url } else { '(no origin recorded)' }))
        $lines.Add('```')
    }

    $lines.Add('')
    $lines.Add('Recorded ' + $stamp + '. This file is metadata only; the folder contents are not')
    $lines.Add('committed to the project repo because the URL above reproduces them exactly.')
    $lines | Set-Content -LiteralPath (Join-Path $d.FullName '_REPO.md') -Encoding UTF8
    $written++
}
Write-Output ('extensions: wrote _REPO.md into ' + $written + ' folders')

# ---------- skills ----------
$skRoot = Join-Path $root 'skills'
$written2 = 0
foreach ($d in (Get-ChildItem $skRoot -Directory -ErrorAction SilentlyContinue)) {
    $gitDir = Join-Path $d.FullName '.git'
    $lines  = New-Object System.Collections.Generic.List[string]
    $lines.Add('# Source repository: ' + $d.Name)
    $lines.Add('')
    if (Test-Path -LiteralPath $gitDir) {
        $url  = (git -C $d.FullName remote get-url origin 2>$null)
        $head = (git -C $d.FullName rev-parse --short HEAD 2>$null)
        $br   = (git -C $d.FullName rev-parse --abbrev-ref HEAD 2>$null)
        if (-not $url)  { $url  = '(no origin)' }
        if (-not $head) { $head = '?' }
        if (-not $br)   { $br   = '?' }
        $lines.Add('| Field | Value |')
        $lines.Add('|---|---|')
        $lines.Add('| Git URL | ' + $url + ' |')
        $lines.Add('| Branch | ' + $br + ' |')
        $lines.Add('| Commit at record time | `' + $head + '` |')
        $lines.Add('')
        $lines.Add('## Restore')
        $lines.Add('')
        $lines.Add('```powershell')
        $lines.Add('git clone ' + $url + ' "' + $d.FullName + '"')
        $lines.Add('```')
        $lines.Add('')
        $lines.Add('Pin the exact state with `git -C <folder> reset --hard ' + $head + '` if the upstream')
        $lines.Add('branch has moved and a skill''s behaviour must be reproduced bit for bit.')
    }
    else {
        $lines.Add('**First-party.** No git remote: this skill folder was written locally for')
        $lines.Add('Men Of Mindset and is not a clone. Its contents must be committed to the')
        $lines.Add('project repo, not restored from a URL.')
    }
    $lines.Add('')
    $lines.Add('Recorded ' + $stamp + '.')
    $lines | Set-Content -LiteralPath (Join-Path $d.FullName '_REPO.md') -Encoding UTF8
    $written2++
}
Write-Output ('skills: wrote _REPO.md into ' + $written2 + ' folders')
