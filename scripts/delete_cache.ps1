<#
  DELETE_CACHE - removes DISPOSABLE caches only, after three confirmations.

  Deletes the CONTENTS of (the empty folders are left in place):
    <ROOT>\edit-workspace\<Title>\cache      contact sheets, frames, subtitles, reference breakdown
    <ROOT>\data\cache                        provider index caches (rebuilt on demand)
    <ROOT>\extensions\<repo>\contact-sheets  contact sheets made by the bridge

  Never touches:
    edit-workspace\<Title>\inputs | plan | output
    media\            the local library
    extensions\<repo>\clips   clips cut by the bridge
    data\downloads, data\jobs, data\catalog.json, anything else

  Usage:  DELETE_CACHE.bat              list, then ask three times
          DELETE_CACHE.bat -ListOnly    list only, delete nothing
#>
param([switch]$ListOnly)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path.TrimEnd('\')

function Format-Size([long]$b) {
  if ($b -ge 1GB) { return ('{0:N2} GB' -f ($b / 1GB)) }
  if ($b -ge 1MB) { return ('{0:N1} MB' -f ($b / 1MB)) }
  if ($b -ge 1KB) { return ('{0:N0} KB' -f ($b / 1KB)) }
  return ('{0} B' -f $b)
}

# ---- collect candidates (exact folder names only) ---------------------------------------
$candidates = New-Object System.Collections.ArrayList

$ws = Join-Path $Root 'edit-workspace'
if (Test-Path -LiteralPath $ws -PathType Container) {
  foreach ($d in Get-ChildItem -LiteralPath $ws -Directory -Force) {
    $c = Join-Path $d.FullName 'cache'
    if (Test-Path -LiteralPath $c -PathType Container) {
      [void]$candidates.Add([pscustomobject]@{ Kind = 'title cache'; Label = $d.Name; Path = $c; Name = 'cache' })
    }
  }
}

$dc = Join-Path $Root 'data\cache'
if (Test-Path -LiteralPath $dc -PathType Container) {
  [void]$candidates.Add([pscustomobject]@{ Kind = 'data cache'; Label = 'data\cache'; Path = $dc; Name = 'cache' })
}

$ext = Join-Path $Root 'extensions'
if (Test-Path -LiteralPath $ext -PathType Container) {
  foreach ($d in Get-ChildItem -LiteralPath $ext -Directory -Force) {
    $c = Join-Path $d.FullName 'contact-sheets'
    if (Test-Path -LiteralPath $c -PathType Container) {
      [void]$candidates.Add([pscustomobject]@{ Kind = 'bridge sheets'; Label = ('extensions\' + $d.Name); Path = $c; Name = 'contact-sheets' })
    }
  }
}

# ---- safety checks + sizes --------------------------------------------------------------
function Get-Problem($t) {
  $full = [IO.Path]::GetFullPath($t.Path)
  if (-not $full.StartsWith($Root + '\', [StringComparison]::OrdinalIgnoreCase)) { return 'outside the Cloudstream folder' }
  if ((Split-Path -Leaf $full) -ne $t.Name) { return 'unexpected folder name' }
  $item = Get-Item -LiteralPath $full -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { return 'is a junction or symlink' }
  $rp = Get-ChildItem -LiteralPath $full -Recurse -Force -Attributes ReparsePoint -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($rp) { return ('contains a junction or symlink: ' + $rp.FullName) }
  return $null
}

$targets = New-Object System.Collections.ArrayList
$skipped = New-Object System.Collections.ArrayList
foreach ($t in $candidates) {
  $problem = Get-Problem $t
  if ($problem) { [void]$skipped.Add(('{0}  ({1})' -f $t.Path, $problem)); continue }
  $files = @(Get-ChildItem -LiteralPath $t.Path -Recurse -Force -File -ErrorAction SilentlyContinue)
  $sum = ($files | Measure-Object -Property Length -Sum).Sum
  if (-not $sum) { $sum = 0 }
  $t | Add-Member -NotePropertyName Bytes -NotePropertyValue ([long]$sum)
  $t | Add-Member -NotePropertyName Files -NotePropertyValue $files.Count
  if ($files.Count -gt 0) { [void]$targets.Add($t) }
}

Write-Host ''
Write-Host ('Cloudstream folder: ' + $Root)
Write-Host ''
if ($targets.Count -eq 0) {
  Write-Host 'Nothing to delete: every cache folder is empty or missing.'
} else {
  Write-Host 'These will be emptied:'
  Write-Host ''
  $total = [long]0
  $count = 0
  foreach ($t in $targets) {
    Write-Host ('  {0,-14} {1,10}  {2,7} files  {3}' -f $t.Kind, (Format-Size $t.Bytes), $t.Files, $t.Path)
    $total += $t.Bytes
    $count += $t.Files
  }
  Write-Host ''
  Write-Host ('  TOTAL          {0,10}  {1,7} files' -f (Format-Size $total), $count)
}
foreach ($s in $skipped) { Write-Host ('  SKIPPED (unsafe): ' + $s) -ForegroundColor Yellow }
Write-Host ''
Write-Host 'Kept untouched: inputs, plan, output, media, bridge clips, downloads.'
Write-Host 'If a contact-sheet job is running, close it or run terminate.bat first.'
Write-Host ''

if ($targets.Count -eq 0) { exit 0 }
if ($ListOnly) { Write-Host 'List only: nothing was deleted.'; exit 0 }

# ---- three confirmations; anything except y cancels -------------------------------------
$q1 = Read-Host 'Delete the caches listed above? Type y and press Enter'
if ($q1 -ne 'y') { Write-Host 'Cancelled. Nothing was deleted.'; exit 0 }
$q2 = Read-Host ('Are you sure? This cannot be undone ({0} files). Type y and press Enter' -f $count)
if ($q2 -ne 'y') { Write-Host 'Cancelled. Nothing was deleted.'; exit 0 }
$q3 = Read-Host 'Are you REALLY sure? Last chance. Type y and press Enter'
if ($q3 -ne 'y') { Write-Host 'Cancelled. Nothing was deleted.'; exit 0 }

# ---- delete contents, keep the folders --------------------------------------------------
$failed = 0
foreach ($t in $targets) {
  foreach ($child in Get-ChildItem -LiteralPath $t.Path -Force) {
    try {
      Remove-Item -LiteralPath $child.FullName -Recurse -Force -ErrorAction Stop
    } catch {
      $failed++
      Write-Host ('  could not delete {0}: {1}' -f $child.FullName, $_.Exception.Message) -ForegroundColor Yellow
    }
  }
  Write-Host ('  emptied {0}' -f $t.Path)
}
Write-Host ''
if ($failed -gt 0) {
  Write-Host ('Done with {0} item(s) that could not be deleted (in use?). Close anything using them and run again.' -f $failed) -ForegroundColor Yellow
} else {
  Write-Host ('Done. Freed about {0}.' -f (Format-Size $total))
}
