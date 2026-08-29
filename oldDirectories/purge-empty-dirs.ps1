<#
  purge-empty-dirs.ps1 - remove directories that contain no real files at any depth.

  DRY RUN BY DEFAULT. Nothing is deleted unless you pass -Execute.

    .\purge-empty-dirs.ps1                  # dry run, drives D E G H I
    .\purge-empty-dirs.ps1 -Drives G        # dry run, one drive
    .\purge-empty-dirs.ps1 -Drives G -Execute
    .\purge-empty-dirs.ps1 -SnapshotAll     # also record EVERY dir before deleting
    .\purge-empty-dirs.ps1 -KeepJunkFiles   # treat desktop.ini/Thumbs.db as real content
    .\purge-empty-dirs.ps1 -KeepReadOnly    # do NOT clear ReadOnly/System to delete

  RULES (all applied in a single pass):
    - a directory is removable only if it holds no real files at any depth
    - desktop.ini / Thumbs.db / .DS_Store count as junk, not content, and are
      sent to the RECYCLE BIN (recoverable, and a tripwire: after a run the bin
      must contain junk and nothing else)
    - Windows-customized folders (My Videos, Camera Roll, Captures, ...) are
      ReadOnly+System and refuse deletion; once proven empty, the attribute is
      cleared and the delete retried. -KeepReadOnly opts out.
    - reparse points (junctions/symlinks) are never traversed or deleted
    - deletes are NON-recursive, so the OS itself refuses any non-empty directory

  Every removed path is written to a manifest CSV; restore-empty-dirs.ps1 can
  recreate the whole tree from it. Directories are deleted permanently.
#>
[CmdletBinding()]
param(
    [string[]] $Drives   = @("D","E","G","H","I"),
    [switch]   $Execute,
    [switch]   $KeepJunkFiles,      # default: junk-only folders ARE deletable
    [switch]   $KeepReadOnly,       # default: clear ReadOnly/System and retry the delete
    [switch]   $SnapshotAll,        # also dump every directory, pre-delete
    [switch]   $AllowSystemDrive,
    [int]      $MinDepth = 1,       # 1 = may remove D:\Foo ; 2 = only D:\Foo\Bar and deeper
    [string]   $OutDir   = "M:\jjj\oldDirectories",              # git-backed
    [string]   $MirrorTo = "C:\Users\Phil\Dropbox\oldDirectories" # second copy
)

$ErrorActionPreference = "Stop"
$es = "C:\Special\ES-1.1.0.37.x64\es.exe"

$Excludes = @(
    '\$Recycle\.Bin',  'System Volume Information', '\\Config\.Msi',
    '\\\.git(\\|$)',   '\\\.svn(\\|$)',             '\\\.hg(\\|$)',
    '\\node_modules(\\|$)',
    '\\AppData(\\|$)', '\\Windows(\\|$)',           '\\ProgramData(\\|$)',
    '\\Program Files', '\\Recovery(\\|$)',          '\\Boot(\\|$)',
    '\\venv(\\|$)',    '\\\.venv(\\|$)',            '\\site-packages(\\|$)',
    '\\EFI(\\|$)',     '\\\$WinREAgent'
)
# Pure caches, no information content. NOT folder.jpg (album art = real content).
# NOT Zone.Identifier (that is an alternate data stream, never a standalone file).
$JunkFiles = @('desktop.ini','Thumbs.db','.DS_Store')

if ($Drives -contains "C" -and -not $AllowSystemDrive) {
    throw "Refusing C: without -AllowSystemDrive. Windows needs its empty directories."
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp    = Get-Date -Format "yyyyMMdd-HHmmss"
$mode     = if ($Execute) { "EXECUTE" } else { "DRYRUN" }
$manifest = Join-Path $OutDir "removed-$mode-$stamp.csv"
"path,depth,drive,junkfiles,removed_utc" | Out-File $manifest -Encoding utf8

if ($SnapshotAll) {
    $snap = Join-Path $OutDir "alldirs-$stamp.csv"
    "path" | Out-File $snap -Encoding utf8
    foreach ($d in $Drives) {
        & $es -instance 1.5a -path "${d}:\" "folder:" 2>$null |
            ForEach-Object { '"' + $_.TrimEnd('\') + '"' } | Out-File $snap -Append -Encoding utf8
    }
    Write-Host "full directory snapshot: $snap"
}

function Test-Excluded([string]$p) {
    foreach ($e in $Excludes) { if ($p -match $e) { return $true } }
    return $false
}

# Returns: 'empty' | 'junkonly' | 'full' | 'unreadable'
function Get-Emptiness([string]$p) {
    try {
        $sawJunk = $false
        foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($p)) {
            if (-not $KeepJunkFiles -and
                [System.IO.File]::Exists($entry) -and
                ($JunkFiles -contains [System.IO.Path]::GetFileName($entry))) { $sawJunk = $true; continue }
            return 'full'
        }
        if ($sawJunk) { return 'junkonly' } else { return 'empty' }
    } catch { return 'unreadable' }
}

function Test-ReparsePoint([string]$p) {
    try { return ([System.IO.File]::GetAttributes($p) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 }
    catch { return $true }
}

function Get-Depth([string]$p) { ($p.TrimEnd('\') -split '\\').Count - 1 }

# Junk files are the ONLY files this script ever deletes. Route them to the
# Recycle Bin so they stay recoverable AND so the bin acts as a tripwire:
# after a run it must contain junk files and nothing else.
Add-Type -AssemblyName Microsoft.VisualBasic
function Remove-JunkFile([string]$f) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
        $f,
        [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
        [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)
}

# Windows marks customized folders (My Videos, Camera Roll, Captures, ...)
# ReadOnly+System, and Directory.Delete refuses those even when they are empty.
# The directory has ALREADY been proven empty by Get-Emptiness at this point, so
# clearing the attribute risks nothing: it is folder decoration, not content.
# Returns 'ok' | 'ok-attrcleared' | 'failed'.
function Remove-EmptyDir([string]$p) {
    try { [System.IO.Directory]::Delete($p, $false); return 'ok' } catch { }
    if ($KeepReadOnly) { return 'failed' }
    try {
        $di = New-Object System.IO.DirectoryInfo $p
        $di.Attributes = [System.IO.FileAttributes]::Directory      # drop ReadOnly/System/Hidden
        [System.IO.Directory]::Delete($p, $false)
        return 'ok-attrcleared'
    } catch { return 'failed' }
}

# Tripwire baseline: file count per drive, from the index.
# -get-result-count returns a single number instantly; never enumerate millions of paths.
function Get-FileCount([string]$d) {
    try {
        $n = & $es -instance 1.5a -path "${d}:\" -get-result-count "file:" 2>$null
        return [int]($n | Select-Object -First 1)
    } catch { return -1 }
}

$total = 0; $byDrive = @{}; $junkDeleted = @{}; $filesBefore = @{}; $attrCleared = @{}

foreach ($d in $Drives) {
    $root = "${d}:\"
    if (-not (Test-Path -LiteralPath $root)) { Write-Host "$d : not present, skipping"; continue }
    Write-Host "`n=== $root ==="

    # Everything proposes candidates fast; every one is re-verified on disk below.
    # A stale index can therefore only cause a MISS, never a wrong delete.
    $candidates = @(& $es -instance 1.5a -path $root "childcount:0" 2>$null)
    if (-not $KeepJunkFiles) {
        # NB: this build will not AND two child-count filters, so keep it to one.
        # Folders that also hold subfolders are rejected by Get-Emptiness anyway.
        $candidates += @(& $es -instance 1.5a -path $root "childfilecount:<4" 2>$null)
    }
    $candidates = $candidates | Sort-Object -Unique
    Write-Host ("  candidates from index: {0}" -f $candidates.Count)

    $byDrive[$d] = 0; $junkDeleted[$d] = 0; $attrCleared[$d] = 0
    if ($Execute) { $filesBefore[$d] = Get-FileCount $d }
    foreach ($c in $candidates) {
        $p = $c.TrimEnd('\')
        if ([string]::IsNullOrWhiteSpace($p)) { continue }

        while ($true) {
            if (-not [System.IO.Directory]::Exists($p)) { break }
            if ((Get-Depth $p) -lt $MinDepth)           { break }
            if (Test-Excluded $p)                       { break }
            if (Test-ReparsePoint $p)                   { break }

            $state = Get-Emptiness $p
            if ($state -ne 'empty' -and $state -ne 'junkonly') { break }

            $parent = [System.IO.Path]::GetDirectoryName($p)
            $utc    = (Get-Date).ToUniversalTime().ToString("s")
            "`"$p`",$(Get-Depth $p),$d,$state,$utc" | Out-File $manifest -Append -Encoding utf8
            $byDrive[$d]++; $total++

            if ($Execute) {
                try {
                    if ($state -eq 'junkonly') {
                        foreach ($f in @([System.IO.Directory]::EnumerateFiles($p))) {
                            [System.IO.File]::SetAttributes($f, [System.IO.FileAttributes]::Normal)
                            Remove-JunkFile $f
                            $junkDeleted[$d]++
                        }
                    }
                } catch {
                    "`"$p`",$(Get-Depth $p),$d,FAILED,$utc" | Out-File $manifest -Append -Encoding utf8
                    break
                }
                # $false = NON-recursive: the OS refuses if anything is left inside.
                $r = Remove-EmptyDir $p
                if ($r -eq 'failed') {
                    "`"$p`",$(Get-Depth $p),$d,FAILED,$utc" | Out-File $manifest -Append -Encoding utf8
                    break
                }
                if ($r -eq 'ok-attrcleared') { $attrCleared[$d]++ }
            } else { break }   # dry run cannot cascade: the child is still on disk

            if ([string]::IsNullOrWhiteSpace($parent)) { break }
            $p = $parent
        }
    }
    Write-Host ("  {0}: {1}" -f $(if($Execute){"removed"}else{"would remove"}), $byDrive[$d])
}

Write-Host "`n================ $mode SUMMARY ================"
foreach ($d in ($byDrive.Keys | Sort-Object)) {
    $extra = ""
    if ($Execute -and $attrCleared[$d] -gt 0) { $extra = "   (ReadOnly/System cleared: $($attrCleared[$d]))" }
    Write-Host ("  {0}: {1,8}{2}" -f $d, $byDrive[$d], $extra)
}
Write-Host ("  TOTAL: {0}" -f $total)
Write-Host "  manifest: $manifest"

if ($Execute) {
    Write-Host "`n---------------- FILE-COUNT TRIPWIRE ----------------"
    Write-Host "  (only junk files should ever disappear; anything else is a bug)"
    Start-Sleep -Seconds 5      # let the index catch up
    $bad = $false
    foreach ($d in ($filesBefore.Keys | Sort-Object)) {
        $after = Get-FileCount $d
        $lost  = $filesBefore[$d] - $after
        $junk  = $junkDeleted[$d]
        $flag  = if ($lost -gt $junk) { $bad = $true; "  <-- UNEXPECTED" } else { "  ok" }
        Write-Host ("  {0}: files {1} -> {2}   lost={3}  junk deleted={4}{5}" -f `
                    $d, $filesBefore[$d], $after, $lost, $junk, $flag)
    }
    if ($bad) {
        Write-Host "`n  *** WARNING: more files vanished than junk files deleted. ***"
        Write-Host "  *** Check the Recycle Bin and the manifest before continuing. ***"
    } else {
        Write-Host "`n  PASS: no non-junk files were removed."
    }
    Write-Host "`n  Junk files went to the Recycle Bin (recoverable). The bin should"
    Write-Host "  contain ONLY desktop.ini / Thumbs.db / .DS_Store after this run."
}

if ($MirrorTo) {
    try {
        New-Item -ItemType Directory -Force -Path $MirrorTo | Out-Null
        Copy-Item $manifest -Destination $MirrorTo -Force
        if ($SnapshotAll -and (Test-Path $snap)) { Copy-Item $snap -Destination $MirrorTo -Force }
        Write-Host "  mirrored to: $MirrorTo"
    } catch { Write-Host "  WARNING: mirror to $MirrorTo failed: $($_.Exception.Message)" }
}
if (-not $Execute) {
    Write-Host "`n  DRY RUN - nothing deleted. Review the manifest, then re-run with -Execute."
    Write-Host "  (dry run does not cascade, so the real count will be HIGHER)"
} else {
    Write-Host "  restore with: .\restore-empty-dirs.ps1 -Manifest `"$manifest`""
}
