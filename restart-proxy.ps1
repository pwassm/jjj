# ============================================================================
#  SLAM local servers: restart + build verification  (AHK LButton & t)
#  - Reaps EVERYTHING from the last run: the :8080 and :8081 processes AND the
#    orphaned "cmd /k" host windows they leave behind
#  - Starts the static web server (:8080) and the proxy (:8081), each in its own
#    titled window
#  - Verifies the LIVE /version build == PROXY_BUILD in proxy.js, so you always
#    KNOW whether the new code actually loaded (no more "I thought it updated")
#  - Then HIDES both server windows and closes itself.  LButton & z toggles them
#    back into view; see show-servers.ps1.
#
#  (dev0929) WHY THE WINDOWS PILED UP.  The old AHK label freed :8080 by killing
#  whatever held the port - which is PYTHON, not the "cmd /k" that launched it.
#  The cmd host survived every restart as an empty window still titled
#  "SLAM web :8080", so a run of restarts left a stack of dead consoles.  The
#  reap below kills the host by its command line, then posts WM_CLOSE to any
#  window still wearing a server title, which also collects a WT tab whose
#  client is already gone.
# ============================================================================
param(
    [switch]$Show   # -Show leaves both server windows visible (the old behaviour)
)
Set-Location 'M:\jjj'
$Host.UI.RawUI.WindowTitle = 'SLAM restart'
. 'M:\jjj\slam-windows.ps1'
Write-Host ''
Write-Host '=== Restarting the SLAM servers (:8080 web, :8081 proxy) ===' -ForegroundColor Cyan

# ---------------------------------------------------------------------------
# 1) Clean slate.
# ---------------------------------------------------------------------------
# (dev0697) THE SUPERVISOR GOES FIRST. proxy-loop.ps1 restarts node whenever it dies
# unexpectedly, so killing node while the supervisor still lives would hand :8081 to a
# replacement that races the one this script is about to start. (The supervisor also
# stops itself on exit code -1 - Stop-Process's code - but belt and braces: order here
# is what actually guarantees it, and this runs even if that check ever regresses.)
$killed = $false
Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*proxy-loop.ps1*' } | ForEach-Object {
        Write-Host "  killing proxy supervisor PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed = $true
    }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*proxy.js*' } | ForEach-Object {
        Write-Host "  killing proxy node PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed = $true
    }
# (dev0929) the web server, moved here from the AHK label so its cmd host dies too.
Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*http.server*8080*' } | ForEach-Object {
        Write-Host "  killing web python PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed = $true
    }
# The "cmd /k" hosts. These are what outlived every previous restart.
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*node proxy.js*' -or $_.CommandLine -like '*http.server 8080*' -or
                   $_.CommandLine -like '*SLAM web :8080*' -or $_.CommandLine -like '*SLAM proxy :8081*' } |
    ForEach-Object {
        Write-Host "  closing leftover console host PID $($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $killed = $true
    }
# Last resort, by port: catches anything the command-line matches missed.
foreach ($port in 8080, 8081) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; $killed = $true
    }
}
if (-not $killed) { Write-Host '  (nothing was running)' }

# Windows still wearing a server title now have no live client behind them.
Start-Sleep -Milliseconds 300
$orphans = 0
foreach ($t in 'SLAM web :8080', 'SLAM proxy :8081') { $orphans += (Close-SlamWindow -Title $t) }
if ($orphans -gt 0) { Write-Host "  closed $orphans orphaned server window(s)" }

foreach ($port in 8080, 8081) {
    $n = 0
    while ((Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) -and $n -lt 20) {
        Start-Sleep -Milliseconds 250; $n++
    }
    if ($n -ge 20) {
        Write-Host "  WARNING: port $port is STILL busy - close every node/python window and retry." -ForegroundColor Yellow
    } else {
        Write-Host "  port $port is free"
    }
}

# ---------------------------------------------------------------------------
# 2) Static web server on :8080, in its OWN titled window.
# ---------------------------------------------------------------------------
#    ONE string, not an array: -ArgumentList as an array makes PowerShell re-quote any
#    element containing spaces, so cmd would receive /k "title ... && python ..." and
#    have to guess at its own quote-stripping rules around the &&. A single string is
#    handed to cmd verbatim - byte for byte the line the AHK label used to run.
Start-Process 'cmd.exe' -ArgumentList '/k title SLAM web :8080 && python -m http.server 8080 --bind 127.0.0.1' -WorkingDirectory 'M:\jjj'

# ---------------------------------------------------------------------------
# 3) Proxy on :8081, in its OWN titled window (keeps running after this closes).
# ---------------------------------------------------------------------------
#    (dev0684) stderr is APPENDED to proxy.err.log. It used to go only to this window,
#    and the window dies with the process - so when node was killed/aborted mid-grind
#    on 2026-07-27 its last words were unrecoverable: proxy.log stopped mid-request
#    with no signal and no exit line, and Windows logged no crash. A V8 fatal error
#    ("FATAL ERROR: ... heap out of memory", an abort, a native crash) prints on
#    stderr, so from now on it lands in a file. stdout stays in the window, so the
#    startup banner and the [ig/download] chatter are unchanged.
#    (dev0687) EXIT CODE CAPTURE - the one fact still missing. Three times the proxy
#    vanished mid-download with no signal line, no exit line, nothing on stderr, and
#    no Windows record, while its cmd window survived. node itself can record nothing
#    in that situation, but the SHELL that launched it can, and the code lands in
#    proxy.log. That single number names the killer:
#    (dev0688) TABLE CORRECTED against a measured exit. The first code captured was
#    -1, from THIS script's own Stop-Process above - so -1 is now calibrated, not
#    guessed: .NET Process.Kill() (which Stop-Process -Force uses) calls
#    TerminateProcess(handle, -1), giving 0xFFFFFFFF, which cmd reads as -1. node's
#    own exits are 0-13 or 128+n, so -1 can never be node ending itself.
#       -1 (0xFFFFFFFF)          -> Process.Kill(): something force-killed it. If a
#                                   MID-DOWNLOAD death shows this, look for a stray
#                                   restart-proxy.ps1 / Stop-Process (AHK misfire?),
#                                   NOT a crash.
#       0                        -> a clean, deliberate shutdown
#       -1073741819 (0xC0000005) -> access violation: node crashed natively
#       -1073740791 (0xC0000409) -> stack/abort: a V8 fatal
#       -1073741510 (0xC000013A) -> Ctrl+C / console close
#    (dev0697) THE CODE WAS CAPTURED, AND IT WAS 0xC0000409 SIX TIMES IN ONE NIGHT -
#    a V8 abort, traced to the SYSTEM running out of commit while node and the browser
#    each allocated a copy of the same 59MB store after every batch. proxy.js now
#    shrinks that per-batch demand, and the launch lives in proxy-loop.ps1, which
#    RESTARTS node after a crash instead of sitting at a dead prompt until morning.
Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'M:\jjj\proxy-loop.ps1' -WorkingDirectory 'M:\jjj'

# ---------------------------------------------------------------------------
# 4) Verify: does the LIVE build match proxy.js on disk? (polls up to ~25s)
# ---------------------------------------------------------------------------
#    MUST poll 127.0.0.1, NOT localhost: proxy.js binds .listen(PORT,'127.0.0.1') (IPv4-only,
#    on purpose - the exec bridge stays off the network). On Win11 'localhost' resolves to
#    IPv6 ::1 FIRST, nothing listens there, and the ::1 packet is DROPPED (times out) rather
#    than refused - so a localhost poll burns its whole timeout every iteration and hangs at
#    "waiting for the proxy to answer" even when the proxy is up. (Browsers dodge this via
#    Happy Eyeballs; Invoke-RestMethod does not.) 127.0.0.1 hits the real listener directly.
$disk = (Select-String -Path 'M:\jjj\proxy.js' -Pattern "PROXY_BUILD = '([^']+)'" | Select-Object -First 1).Matches.Groups[1].Value
Write-Host "  waiting for the proxy to answer (build on disk = $disk) ..."
$live = '(no response)'
for ($i = 0; $i -lt 50; $i++) {
    try { $live = (Invoke-RestMethod 'http://127.0.0.1:8081/version' -TimeoutSec 2).build; break }
    catch { Start-Sleep -Milliseconds 500 }
}
Write-Host ''

# ---------------------------------------------------------------------------
# 5) Hide on success; STAY PUT and shout on failure.
# ---------------------------------------------------------------------------
#    (dev0929) The failure paths used to print red text and then close instantly,
#    which nobody can read. Now a bad start is the one case that keeps a window on
#    screen - which is also the only way you would ever find out, given both server
#    windows are hidden from here on.
$ok = ($live -eq $disk)
if ($ok) {
    Write-Host "  OK  proxy is LIVE on $live  (matches proxy.js on disk)" -ForegroundColor Green
} elseif ($live -eq '(no response)') {
    Write-Host "  proxy did not answer within ~25s - it may still be booting." -ForegroundColor Yellow
    Write-Host "  The 'SLAM proxy :8081' window is being left VISIBLE: if it shows the" -ForegroundColor Yellow
    Write-Host "  '$disk' banner you are good, otherwise node failed to start - read it." -ForegroundColor Yellow
} else {
    Write-Host "  MISMATCH  disk=$disk  live=$live" -ForegroundColor Red
    Write-Host '  An OLD proxy is still serving. Close EVERY node/cmd window, then run this again.' -ForegroundColor Yellow
}
Write-Host ''

if ($ok -and -not $Show) {
    # The web window has been up since step 2 and the proxy window since step 3, so
    # both have had their few seconds on screen while the verify polled. Tuck away.
    $hidden = 0
    foreach ($t in 'SLAM web :8080', 'SLAM proxy :8081') {
        if ((Wait-SlamWindow -Title $t -TimeoutMs 4000).Count -gt 0) { $hidden += (Hide-SlamWindow -Title $t) }
        else { Write-Host "  (could not find the '$t' window to hide - leaving it be)" -ForegroundColor DarkYellow }
    }
    Write-Host "  hid $hidden server window(s) - LButton & z brings them back." -ForegroundColor DarkGray
    Write-Host '  Both servers keep running. This window closes in 2s.'
    Start-Sleep -Seconds 2
} elseif ($ok) {
    Write-Host '  (-Show given: both server windows left visible.) This window closes in 2s.'
    Start-Sleep -Seconds 2
} else {
    Write-Host '  Both server windows are VISIBLE so you can read them.' -ForegroundColor Yellow
    Read-Host '  Press Enter to close this window'
}
