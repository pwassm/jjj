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

REM (dev0947) -WindowStyle Hidden: the task ran with a visible elevated console that
REM sat on top of whatever you were doing for the whole ~30s verify loop. Everything
REM it printed already goes to vpn-rotate.log and to the I screen VPN pill, so the
REM window was pure interruption. Re-run this file once to re-register both tasks.
echo Registering scheduled task "ProtonVpnRotate"...
REM Full path to powershell.exe - a bare "powershell" makes Task Scheduler fail
REM to launch with 0x80070002 (file not found), so the switch never runs.
schtasks /Create /TN "ProtonVpnRotate" /F /SC ONCE /ST 00:00 /RL HIGHEST ^
  /TR "\"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe\" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0vpn-rotate.ps1\" -Mode random"

echo Registering scheduled task "ProtonVpnStop" (Drop VPN button)...
schtasks /Create /TN "ProtonVpnStop" /F /SC ONCE /ST 00:00 /RL HIGHEST ^
  /TR "\"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe\" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%~dp0vpn-rotate.ps1\" -Stop"

echo Hardening both tasks (StopExisting + 5-min limit, and NO window at all)...
REM (dev0965) LOGON TYPE - the other half of "run it hidden". dev0947 added
REM   -WindowStyle Hidden, but the task was still registered with
REM   LogonType=InteractiveToken, which means Task Scheduler launches
REM   powershell.exe ON YOUR DESKTOP: Windows creates its console window and gives
REM   it the foreground FIRST, and only then does -WindowStyle Hidden hide it. That
REM   is the brief flash - and, worse, the focus theft, which swallowed keystrokes
REM   from whatever you were typing into when a rotation fired. S4U ("run whether
REM   user is logged on or not", no stored password) runs the task in a
REM   non-interactive window station instead: no window is ever created on your
REM   desktop, so there is nothing to flash and nothing to take focus. It still runs
REM   as YOU - so the log and state.json stay in your own LOCALAPPDATA, which is
REM   where proxy.js reads them - and still elevated (RunLevel Highest), which is
REM   what wireguard /installtunnelservice needs.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name;" ^
  "foreach ($t in 'ProtonVpnRotate','ProtonVpnStop') {" ^
  "  $x = schtasks /query /tn $t /xml ONE | Out-String;" ^
  "  $x = $x -replace '<MultipleInstancesPolicy>\w+</MultipleInstancesPolicy>','<MultipleInstancesPolicy>StopExisting</MultipleInstancesPolicy>';" ^
  "  if ($x -match '<ExecutionTimeLimit>') { $x = $x -replace '<ExecutionTimeLimit>[^<]+</ExecutionTimeLimit>','<ExecutionTimeLimit>PT5M</ExecutionTimeLimit>' }" ^
  "  else { $x = $x -replace '</Settings>','  <ExecutionTimeLimit>PT5M</ExecutionTimeLimit></Settings>' }" ^
  "  $f = Join-Path $env:TEMP ($t + '.xml'); Set-Content -Path $f -Value $x -Encoding Unicode;" ^
  "  schtasks /create /tn $t /xml $f /f | Out-Null; Remove-Item $f -Force;" ^
  "  try { Set-ScheduledTask -TaskName $t -Principal (New-ScheduledTaskPrincipal -UserId $me -LogonType S4U -RunLevel Highest) -ErrorAction Stop | Out-Null }" ^
  "  catch { Write-Host ('  ' + $t + ': S4U REFUSED - ' + $_.Exception.Message);" ^
  "          Write-Host '     it will still rotate, but it will still flash and steal focus' }" ^
  "  $k = Get-ScheduledTask -TaskName $t;" ^
  "  Write-Host ('  ' + $t + ': ' + $k.Settings.MultipleInstances + ', ' + $k.Settings.ExecutionTimeLimit + ', logon=' + $k.Principal.LogonType) }"

if %errorlevel%==0 (
    echo.
    echo Done. Both tasks should say logon=S4U above - that is the one that means
    echo no window, no flash and no stolen focus when the VPN rotates. Switches stay
    echo UAC-free, and a stalled rotation is force-ended after 5 min.
) else (
    echo.
    echo Failed to register the task ^(are you on an admin account?^).
)
echo.
pause
