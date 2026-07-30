# ============================================================================
#  SLAM proxy restart + build verification  (called by startproxy.bat)
#  - Kills ANY process listening on :8081 and waits for the port to free
#  - Launches the proxy in its own window titled "SLAM proxy :8081"
#  - Verifies the LIVE /version build == PROXY_BUILD in proxy.js, so you always
#    KNOW whether the new code actually loaded (no more "I thought it updated")
# ============================================================================
Set-Location 'M:\jjj'
Write-Host ''
Write-Host '=== Restarting SLAM proxy on :8081 ===' -ForegroundColor Cyan

# 1) Clean slate: kill the proxy node(s), their leftover cmd host windows, and anything
#    still holding :8081. This also reaps dead "SLAM proxy" windows from prior restarts.
$killed = $false
# (dev0697) THE SUPERVISOR GOES FIRST. proxy-loop.ps1 restarts node whenever it dies
# unexpectedly, so killing node while the supervisor still lives would hand :8081 to a
# replacement that races the one this script is about to start. (The supervisor also
# stops itself on exit code -1 — Stop-Process's code — but belt and braces: order here
# is what actually guarantees it, and this runs even if that check ever regresses.)
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
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*node proxy.js*' } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
    Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue; $killed = $true
}
if (-not $killed) { Write-Host '  (no existing proxy was running)' }
$n = 0
while ((Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue) -and $n -lt 20) {
    Start-Sleep -Milliseconds 250; $n++
}
if ($n -ge 20) {
    Write-Host '  WARNING: port 8081 is STILL busy - close every node window and retry.' -ForegroundColor Yellow
} else {
    Write-Host '  port 8081 is free'
}

# 2) Launch the proxy in its OWN titled window (keeps running after this closes).
#    (dev0684) stderr is APPENDED to proxy.err.log. It used to go only to this window,
#    and the window dies with the process - so when node was killed/aborted mid-grind
#    on 2026-07-27 its last words were unrecoverable: proxy.log stopped mid-request
#    with no signal and no exit line, and Windows logged no crash. A V8 fatal error
#    ("FATAL ERROR: ... heap out of memory", an abort, a native crash) prints on
#    stderr, so from now on it lands in a file. stdout stays in the window, so the
#    startup banner and the [ig/download] chatter are unchanged.
#    (dev0687) EXIT CODE CAPTURE — the one fact still missing. Three times now the
#    proxy has vanished mid-download with no signal line, no exit line, nothing on
#    stderr, and no Windows record, while its cmd window survived. node itself can
#    record nothing in that situation, but the SHELL that launched it can: cmd is
#    /v:on (delayed expansion) so !ERRORLEVEL! is read AFTER node ends, and the code
#    lands in proxy.log. That single number names the killer:
#    (dev0688) TABLE CORRECTED against a measured exit. The first code captured was
#    -1, from THIS script's own Stop-Process at line 18 — so -1 is now calibrated,
#    not guessed: .NET Process.Kill() (which Stop-Process -Force uses) calls
#    TerminateProcess(handle, -1), giving 0xFFFFFFFF, which cmd reads as -1. node's
#    own exits are 0-13 or 128+n, so -1 can never be node ending itself.
#       -1 (0xFFFFFFFF)          → Process.Kill(): something force-killed it. If a
#                                  MID-DOWNLOAD death shows this, look for a stray
#                                  restart-proxy.ps1 / Stop-Process (AHK misfire?),
#                                  NOT a crash.
#       0                        → a clean, deliberate shutdown
#       -1073741819 (0xC0000005) → access violation: node crashed natively
#       -1073740791 (0xC0000409) → stack/abort: a V8 fatal
#       -1073741510 (0xC000013A) → Ctrl+C / console close
#    (dev0697) THE CODE WAS CAPTURED, AND IT WAS 0xC0000409 SIX TIMES IN ONE NIGHT —
#    a V8 abort, traced to the SYSTEM running out of commit (limit 32.8GB, charged
#    30.9GB, free 1.85GB, pagefile pinned manual at 1000-5000MB) while node and the
#    browser each allocated a copy of the same 59MB store after every batch. proxy.js
#    now shrinks that per-batch demand by ~65% and logs the headroom; two things here
#    finish the job:
#      · the launch moved into proxy-loop.ps1, which RESTARTS node after a crash. The
#        old `cmd /k` printed the exit code and sat at a prompt, so a 3:43 AM abort
#        ended the night — the client waited its full 30 minutes for a proxy that was
#        never coming back. Now it is back in ~3s and the paused grind continues.
#      · --report-on-fatalerror, so the next abort finally leaves a reason behind.
Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'M:\jjj\proxy-loop.ps1' -WorkingDirectory 'M:\jjj'

# 3) Verify: does the LIVE build match proxy.js on disk? (polls up to ~25s while node boots)
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
if ($live -eq $disk) {
    Write-Host "  OK  proxy is LIVE on $live  (matches proxy.js on disk)" -ForegroundColor Green
} elseif ($live -eq '(no response)') {
    Write-Host "  proxy did not answer within ~25s - it may still be booting." -ForegroundColor Yellow
    Write-Host "  Check the 'SLAM proxy :8081' window: if it shows the '$disk' banner you're good." -ForegroundColor Yellow
    Write-Host "  Otherwise it failed to start (e.g. node error) - read that window." -ForegroundColor Yellow
} else {
    Write-Host "  MISMATCH  disk=$disk  live=$live" -ForegroundColor Red
    Write-Host '  An OLD proxy is still serving. Close EVERY node/cmd window, then run this again.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'The proxy runs in the "SLAM proxy :8081" window. You can close THIS one.'
