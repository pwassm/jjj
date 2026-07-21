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
Start-Process cmd -ArgumentList '/k', 'title SLAM proxy :8081 && node proxy.js' -WorkingDirectory 'M:\jjj'

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
