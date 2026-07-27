@echo off
REM vpn-rotate.bat (dev0649) - switch Proton VPN to a different US server.
REM Run this after every ~18 downloads.
REM
REM If you ran vpn-rotate-setup.bat once, this fires the scheduled task and
REM switches SILENTLY (no admin prompt). Otherwise it falls back to running the
REM script directly, which will pop one UAC prompt.

title SLAM - manual VPN switch (not the proxy)
REM (dev0680) Confirm-first gate. Nothing happens until you press Y, so opening the
REM wrong .bat from the folder can't do anything.
echo.
echo  ------------------------------------------------------------
echo   vpn-rotate.bat  -  switches Proton VPN to another US server.
echo.
echo   You usually do NOT need this. The I screen rotates the VPN
echo   by itself during Download + rotate.
echo.
echo   Wanted to START THE PROXY? Press N, then run startproxy.bat
echo  ------------------------------------------------------------
echo.
choice /C YN /N /M "Switch the VPN now?  [Y/N] "
if errorlevel 2 exit /b

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
timeout /t 8 /nobreak >nul
if exist "%LOG%" (
    echo -----------------------------------------------------
    powershell -NoProfile -Command "Get-Content -LiteralPath '%LOG%' -Tail 2"
)
endlocal
