# ============================================================================
#  (dev0697) SLAM proxy supervisor - keeps :8081 alive through a crash
#
#  WHY: on the night of 2026-07-29/30 node aborted SIX times (0xC0000409) during
#  an overnight IG grind. Each time the launcher's `cmd /k` printed the exit code
#  and then just sat there at a prompt, so the proxy stayed dead. The client did
#  its part - dev0688 pauses the grind and waits for the proxy to come back - but
#  nothing ever brought it back. It waited the full 30 minutes and gave up:
#  "The proxy never came back", 537 of 2154 posts done, at 3:43 AM.
#
#  Restart it here and that whole failure mode costs about ten seconds. dev0697
#  also attacks the CAUSE (the per-batch 59MB save that exhausted system commit),
#  but a grind that has to survive eight unattended hours should not depend on
#  nothing ever going wrong.
#
#  This is NOT a background daemon. It runs inside the "SLAM proxy :8081" window
#  you already have open, it polls nothing, and it opens no window of its own
#  (dev0657's watchdog was rejected for flashing a console every minute - that
#  objection was right, and nothing here does it).
#
#  KEEP THIS FILE PURE ASCII. restart-proxy.ps1 launches it with powershell.exe
#  (5.1), which reads a BOM-less .ps1 in the system ANSI codepage - so a UTF-8
#  em-dash arrives as three characters, the last of which is a RIGHT DOUBLE
#  QUOTATION MARK, and PowerShell accepts smart quotes as string delimiters. An
#  em-dash inside a Write-Host string therefore ends the string early and the
#  whole script dies with "Missing closing ')' in expression". Caught exactly
#  that way while testing this file. In restart-proxy.ps1 the non-ASCII is all in
#  comments, which is why that one has always been fine.
#
#  Launched by restart-proxy.ps1. Run it directly and it behaves the same.
# ============================================================================
Set-Location 'M:\jjj'
$Host.UI.RawUI.WindowTitle = 'SLAM proxy :8081'

# (dev0929) restart-proxy.ps1 HIDES this window once the build check passes, so the
# two places below that stop the loop have to put it back on screen - a crash storm
# or a deliberate stop is exactly when you need to read it, and the Read-Host at the
# bottom would otherwise wait forever on a window nobody can see.
. 'M:\jjj\slam-windows.ps1'
function Reveal-Self { [void](Show-SlamWindow -Title 'SLAM proxy :8081' -Foreground) }

# node flags, and why each one is here.
#   FIRST, what these are NOT for. It is tempting to read "abort" as "node ran out
#   of JS heap", and it was not. Measured on this machine:
#       a JS-heap OOM       -> exit 134, and 3.5KB of "<--- Last few GCs --->" plus
#                              "FATAL ERROR: ... heap out of memory" on stderr
#       process.abort()     -> exit 134, plus a full native + JS stack trace
#       the six real deaths -> exit -1073740791 (0xC0000409) and ZERO bytes on
#                              stderr, though stderr has been captured to
#                              proxy.err.log since dev0684
#   Silence plus 0xC0000409 is Windows __fastfail: the process was torn down without
#   getting to write anything, which is what a NATIVE allocation failure looks like
#   when the system refuses to commit. So no node flag can cure this - the cure is
#   fewer and smaller allocations (dev0697's delta save) and more commit headroom
#   (the pagefile).
#
#   --max-old-space-size=2048  HYGIENE, not the cure. V8's default cap here is
#                              4288MB, so it lets the heap ratchet up and stay
#                              there: rss sat at 688MB after every save and never
#                              came back down, holding commit that everything else
#                              then needed. 2GB is still ~4x the measured peak
#                              (429MB) and makes V8 collect rather than grow.
#   --report-on-fatalerror     writes report.<date>.<pid>.<tid>.<seq>.json next to
#                              proxy.js naming the reason for an abort - the fact
#                              that was missing from all six crashes. If the next
#                              one leaves no report either, that is itself the
#                              answer: node never got to run. .gitignore already
#                              covers the filename pattern.
$nodeArgs = '--max-old-space-size=2048 --report-on-fatalerror proxy.js'

# Exit codes that mean "somebody meant this" -> stop, don't fight them. Restarting
# on -1 would be actively harmful: that is restart-proxy.ps1's own Stop-Process
# (dev0688 measured it), so a restart here would race the replacement for :8081.
$deliberate = @{
     0 = 'clean shutdown'
    -1 = 'force-killed (restart script / End task)'
    -1073741510 = 'Ctrl+C or the window was closed'
}

$restarts = 0
$shortRuns = 0            # consecutive runs that died in under a minute
while ($true) {
    $t0 = Get-Date
    # cmd /c, not a bare call: stdout must stay in THIS window (the startup banner
    # and the [ig/download] chatter are how you read a running grind) while stderr
    # is appended to proxy.err.log, where a V8 fatal message would land. cmd hands
    # node's exit code straight back, including the negative NTSTATUS ones.
    cmd /c "node $nodeArgs 2>> proxy.err.log"
    $code = $LASTEXITCODE
    $secs = [int]((Get-Date) - $t0).TotalSeconds
    # Same wording the old launcher used, because proxy.js reads this line back on
    # its next start to report how the previous run ended.
    $stamp = Get-Date -Format 'ddd MM/dd/yyyy  HH:mm:ss.ff'
    Add-Content -LiteralPath 'proxy.log' -Value "$stamp  node exited EXITCODE=$code  (ran $secs`s)"

    if ($deliberate.ContainsKey($code)) {
        Reveal-Self
        Write-Host ''
        Write-Host "  proxy stopped: $($deliberate[$code])  EXITCODE=$code, ran $secs`s" -ForegroundColor Cyan
        break
    }

    # A crash. Guard against a crash STORM: if it cannot stay up for a minute,
    # something is wrong that restarting will not fix (a syntax error, :8081 taken,
    # a missing binary) and spinning on it would bury the real message.
    if ($secs -lt 60) { $shortRuns++ } else { $shortRuns = 0 }
    if ($shortRuns -ge 3) {
        Reveal-Self
        Write-Host ''
        Write-Host '  STOPPING: the proxy crashed 3 times in a row without staying up 60s.' -ForegroundColor Red
        Write-Host "  Last EXITCODE=$code. Read the lines above, proxy.err.log, and any" -ForegroundColor Yellow
        Write-Host '  report.*.json in M:\jjj - then fix it before restarting.' -ForegroundColor Yellow
        break
    }

    $restarts++
    Write-Host ''
    Write-Host "  !! proxy CRASHED after $secs`s - EXITCODE=$code" -ForegroundColor Red
    if ($code -eq -1073740791) {
        Write-Host '     0xC0000409 = abort. On this machine that has meant the SYSTEM ran out of' -ForegroundColor Yellow
        Write-Host "     COMMIT - see the 'system memory' line proxy.log prints at startup." -ForegroundColor Yellow
    }
    Write-Host "  restarting in 3s (restart #$restarts) - a paused grind will pick up where it stopped" -ForegroundColor Green
    Start-Sleep -Seconds 3
}

Write-Host ''
Write-Host "  (this window ran the proxy $($restarts + 1) time(s); $restarts restart(s) after a crash)"
Write-Host '  Press Enter to close.'
Read-Host | Out-Null
