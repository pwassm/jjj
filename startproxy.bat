@echo off
REM Thin, stable entry point for AHK. All the real logic (robust kill + restart +
REM build verification) lives in restart-proxy.ps1 so there's no cmd quoting to break.
powershell -NoProfile -ExecutionPolicy Bypass -File "M:\jjj\restart-proxy.ps1"
pause
