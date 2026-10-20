@echo off
setlocal EnableExtensions
set "ROOT=%~dp0"
set "PG_BIN=%ROOT%.runtime\postgres\pgsql\bin"
set "PG_DATA=%ROOT%.runtime\pgdata"

echo Stopping FATE API / web / proxy ...
for %%P in (8787 8788 5173 3000) do call :stop_port %%P

echo Stopping PostgreSQL on 127.0.0.1:5436 ...
if exist "%PG_BIN%\pg_ctl.exe" (
  "%PG_BIN%\pg_ctl.exe" -D "%PG_DATA%" stop -m fast >nul 2>&1
)
echo done.
endlocal
exit /b 0

:stop_port
set "PORT=%~1"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>&1
exit /b 0