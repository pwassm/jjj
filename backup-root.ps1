# backup-root.ps1  (dev0853)
# ---------------------------------------------------------------------------
# Mirrors the ROOT of M:\jjj (files only, no subdirectories) to each backup
# target that is currently reachable.
#
# WHY THIS EXISTS: ml.json is now gitignored — the repo is public, and the full
# file carries packaged web-page text and personal notes that must not be
# served. Git was the backup; it no longer is. This replaces it.
#
# Run it after every commit. It must NEVER hang: a drive that is asleep,
# disconnected or a dead network path is SKIPPED after a short probe, not
# waited on. Missing targets are reported, never fatal.
#
#   pwsh -File backup-root.ps1            # copy to every reachable target
#   pwsh -File backup-root.ps1 -List      # just say what is reachable
# ---------------------------------------------------------------------------
[CmdletBinding()]
param(
    [string[]]$Targets = @('E:\_jjjRoot', 'F:\_jjjRoot', 'C:\_jjjRoot'),
    [string]  $Source  = 'M:\jjj',
    [int]     $ProbeTimeoutSec = 5,
    [switch]  $List
)

$ErrorActionPreference = 'Continue'

if (-not (Test-Path -LiteralPath $Source)) {
    Write-Error "Source not found: $Source"; exit 1
}

# Drive letters the OS already knows are mounted and ready. Asking this costs
# nothing and answers for the common case (a drive that is simply not there)
# without touching the filesystem at all.
$ReadyRoots = @{}
foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    try { if ($d.IsReady) { $ReadyRoots[$d.Name.ToUpperInvariant()] = $true } } catch { }
}

# Probe a target without blocking.
#   • local drive not in $ReadyRoots  -> instant skip, no I/O
#   • local drive that IS ready       -> probe inline (fast, no job overhead)
#   • UNC path                        -> run in a job we are willing to abandon,
#                                        because a dead host can stall for
#                                        tens of seconds on its own
function Test-TargetWritable {
    param([string]$Path)
    try {
        if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force -ErrorAction Stop | Out-Null }
        $probe = Join-Path $Path '.wtest'
        Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return 'ok'
    } catch { return 'nowrite' }
}

function Test-TargetReachable {
    param([string]$Path, [int]$TimeoutSec)
    $root = [System.IO.Path]::GetPathRoot($Path)

    if ($root -notmatch '^\\\\') {
        if (-not $ReadyRoots.ContainsKey($root.ToUpperInvariant())) { return 'noroot' }
        return Test-TargetWritable -Path $Path
    }

    $job = Start-Job -ScriptBlock {
        param($p)
        try {
            if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force -ErrorAction Stop | Out-Null }
            $probe = Join-Path $p '.wtest'
            Set-Content -LiteralPath $probe -Value 'x' -ErrorAction Stop
            Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
            return 'ok'
        } catch { return 'nowrite' }
    } -ArgumentList $Path

    $done = Wait-Job $job -Timeout $TimeoutSec
    if (-not $done) {
        Stop-Job $job -ErrorAction SilentlyContinue
        Remove-Job $job -Force -ErrorAction SilentlyContinue
        return 'timeout'
    }
    $res = Receive-Job $job
    Remove-Job $job -Force -ErrorAction SilentlyContinue
    return $res
}

$stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Write-Host "backup-root  $stamp" -ForegroundColor Cyan
Write-Host "  source : $Source (root files only)" -ForegroundColor DarkGray

$copied = 0; $skipped = 0
foreach ($t in $Targets) {
    $state = Test-TargetReachable -Path $t -TimeoutSec $ProbeTimeoutSec
    switch ($state) {
        'ok' {
            if ($List) { Write-Host ("  {0,-16} reachable" -f $t) -ForegroundColor Green; continue }
            # /NP no progress, /R:0 /W:0 never retry (a flaky drive must not stall
            # the commit), /XJ skip junctions, /NFL /NDL quiet file+dir lists.
            # No /MIR and no /PURGE: this only ever ADDS or UPDATES, so a file
            # deleted here can still be recovered from a backup.
            $rc = robocopy $Source $t /COPY:DAT /R:0 /W:0 /NP /NFL /NDL /NJH /NJS /XJ /XF '.wtest'
            $code = $LASTEXITCODE
            if ($code -lt 8) {
                $n = (Get-ChildItem -LiteralPath $t -File -ErrorAction SilentlyContinue).Count
                Write-Host ("  {0,-16} OK    ({1} files)" -f $t, $n) -ForegroundColor Green
                $copied++
            } else {
                Write-Host ("  {0,-16} robocopy exit {1} - see above" -f $t, $code) -ForegroundColor Yellow
                $skipped++
            }
        }
        'noroot'  { Write-Host ("  {0,-16} skipped - drive not present"  -f $t) -ForegroundColor DarkYellow; $skipped++ }
        'nowrite' { Write-Host ("  {0,-16} skipped - not writable"       -f $t) -ForegroundColor DarkYellow; $skipped++ }
        'timeout' { Write-Host ("  {0,-16} skipped - no answer in ${ProbeTimeoutSec}s" -f $t) -ForegroundColor DarkYellow; $skipped++ }
        default   { Write-Host ("  {0,-16} skipped - {1}" -f $t, $state) -ForegroundColor DarkYellow; $skipped++ }
    }
}

if (-not $List) {
    Write-Host ("  -> {0} target(s) written, {1} skipped" -f $copied, $skipped) -ForegroundColor Cyan
    if ($copied -eq 0) { Write-Warning 'NO backup target was reachable - ml.json is gitignored, so it is currently unbacked.' }
}
exit 0
