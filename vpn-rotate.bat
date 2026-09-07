@echo off
REM vpn-rotate.bat (dev0649) - switch Proton VPN to a different US server.
REM Run this after every ~18 downloads.
REM
REM If you ran vpn-rotate-setup.bat once, this fires the scheduled task and
REM switches SILENTLY (no admin prompt). Otherwise it falls back to running the
REM script directly, which will pop one UAC prompt.

setlocal
set "LOG=%LOCALAPPDATA%\ProtonVpnRotate\vpn-rotate.log"

schtasks /query /tn "ProtonVpnRotate" >nul 2>&1
if %errorlevel%==0 (
    echo Switching Proton VPN...
    schtasks /run /tn "ProtonVpnRotate" >nul
) else (
    echo [tip: run vpn-rotate-setup.bat once to make switches silent]
    echo Switching Proton VPN...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vpn-rotate.ps1"
)

REM give the tunnel a moment to come up, then show the result
REM (dev0947) the rotation now runs in a HIDDEN window, so this log tail is the only
REM feedback a manual run gets - wait long enough for the verify loop to finish.
timeout /t 25 /nobreak >nul
if exist "%LOG%" (
    echo -----------------------------------------------------
    powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG%' -Tail 3"
)
endlocal
