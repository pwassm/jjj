@echo off
REM vpn-rotate-setup.bat (dev0649) - run ONCE.
REM Registers a Scheduled Task so vpn-rotate.bat can switch the VPN with NO UAC
REM prompt each time (needed for hands-off overnight batches). Requires an admin
REM account. To change the rotation style edit the -Mode below (random | cycle).

REM --- self-elevate ---------------------------------------------------------
net session >nul 2>&1
if %errorlevel% neq 0 (
    powershell -NoProfile -Command "Start-Process '%~f0' -Verb RunAs"
    exit /b
)

echo Registering scheduled task "ProtonVpnRotate"...
schtasks /Create /TN "ProtonVpnRotate" /F /SC ONCE /ST 00:00 /RL HIGHEST ^
  /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0vpn-rotate.ps1\" -Mode random"

if %errorlevel%==0 (
    echo.
    echo Done. From now on, vpn-rotate.bat switches the VPN silently.
) else (
    echo.
    echo Failed to register the task ^(are you on an admin account?^).
)
echo.
pause
