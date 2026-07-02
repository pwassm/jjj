@echo off
REM Free port 8081 if a stale proxy.js is holding it, then (re)launch.
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8081 ^| findstr LISTENING') do taskkill /F /PID %%a
node proxy.js
