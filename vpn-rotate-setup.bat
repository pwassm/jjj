@echo off
REM vpn-rotate-setup.bat (dev0656) - run ONCE.
REM Registers Scheduled Tasks so vpn-rotate.bat can switch/stop the VPN with NO
REM UAC prompt each time (needed for hands-off overnight batches). Requires an
REM admin account. To change the rotation style edit the -Mode below (random|cycle).
REM
REM dev0656: harden both tasks against a HUNG instance. The stock /Create leaves
REM   MultipleInstancesPolicy=IgnoreNew + ExecutionTimeLimit=PT72H, so if a
REM   rotation ever stalls (e.g. the PC sleeps mid-switch) that zombie sits in
REM   "Running" state and REFUSES every later run for up to 72h (0x800710E0 -
REM   "the operator or administrator has refused the request"): the VPN pill
REM   never gets a new exit. We repair that to StopExisting + PT5M below.

REM --- self-elevate ---------------------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo Registering scheduled task "ProtonVpnRotate"...
REM Full path to powershell.exe - a bare "powershell" makes Task Scheduler fail
REM to launch with 0x80070002 (file not found), so the switch never runs.
schtasks /Create /TN "ProtonVpnRotate" /F /SC ONCE /ST 00:00 /RL HIGHEST ^
  /TR "\"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0vpn-rotate.ps1\" -Mode random"

echo Registering scheduled task "ProtonVpnStop" (Drop VPN button)...
schtasks /Create /TN "ProtonVpnStop" /F /SC ONCE /ST 00:00 /RL HIGHEST ^
  /TR "\"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0vpn-rotate.ps1\" -Stop"

echo Hardening both tasks (StopExisting + 5-min limit so a hung run can't block)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "foreach ($t in 'ProtonVpnRotate','ProtonVpnStop') {" ^
  "  $x = schtasks /query /tn $t /xml ONE | Out-String;" ^
  "  $x = $x -replace '<MultipleInstancesPolicy>\w+</MultipleInstancesPolicy>','<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>';" ^
  "  if ($x -match '<ExecutionTimeLimit>') { $x = $x -replace '<ExecutionTimeLimit>[^<]+</ExecutionTimeLimit>','<ExecutionTimeLimit>PT5M</ExecutionTimeLimit>' }" ^
  "  else { $x = $x -replace '(</Settings>)','  <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>`r`n$1' }" ^
  "  $f = Join-Path $env:TEMP ($t + '.xml'); Set-Content -Path $f -Value $x -Encoding Unicode;" ^
  "  schtasks /create /tn $t /xml $f /f | Out-Null; Remove-Item $f -Force;" ^
  "  $s = (Get-ScheduledTask -TaskName $t).Settings; Write-Host ('  ' + $t + ': ' + $s.MultipleInstances + ', ' + $s.ExecutionTimeLimit) }"

if %errorlevel%==0 (
    echo.
    echo Done. From now on, vpn-rotate.bat switches the VPN silently, and a
    echo stalled rotation is force-ended after 5 min instead of blocking the next.
) else (
    echo.
    echo Failed to register the task ^(are you on an admin account?^).
)
echo.
pause
