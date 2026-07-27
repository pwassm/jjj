@echo off
title SLAM - start the proxy (port 8081)
REM Thin, stable entry point for AHK. All the real logic (robust kill + restart +
REM build verification) lives in restart-proxy.ps1 so there's no cmd quoting to break.
REM (dev0680) Banner + closing advice: three .bat files sit in this folder and only
REM this one is the routine one, so it now says so out loud.
echo.
echo  ============================================================
echo    SLAM  -  START THE PROXY   (port 8081)
echo.
echo    THIS IS THE ONE TO RUN when the I screen says the proxy
echo    is not answering. Safe to run any time: it restarts the
echo    proxy and then tells you whether it came back.
echo  ============================================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "M:\jjj\restart-proxy.ps1"
echo.
echo  ------------------------------------------------------------
echo   Look for "proxy is LIVE" above - that means it worked.
echo.
echo   IMPORTANT: leave the new "SLAM proxy :8081" window OPEN.
echo   Closing that window STOPS the proxy (proxy.log records this
echo   as "signal SIGHUP"). This window here is safe to close.
echo  ------------------------------------------------------------
echo.
pause
