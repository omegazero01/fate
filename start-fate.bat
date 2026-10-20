@echo off
setlocal EnableExtensions EnableDelayedExpansion
title FATE launcher
set "ROOT=%~dp0"
set "PG_BIN=%ROOT%.runtime\postgres\pgsql\bin"
set "PG_DATA=%ROOT%.runtime\pgdata"
set "PG_LOG=%ROOT%.runtime\pg.log"
set "PG_PORT=5436"
set "API_ADDR=127.0.0.1:8787"
set "PROXY_ADDR=127.0.0.1:8788"
set "WEB_PORT=5173"
set "SERIES_PG_DSN=postgres://series:series@127.0.0.1:%PG_PORT%/series"

echo ============================================================
echo  FATE (SERIES pi refactor) one-click start
echo  PostgreSQL : 127.0.0.1:%PG_PORT%  ^(embedded, .runtime\pgdata^)
echo  API/Proxy  : %API_ADDR% / %PROXY_ADDR%
echo  Web (dev)  : http://localhost:%WEB_PORT%
echo ============================================================

if not exist "%PG_BIN%\pg_ctl.exe" (
  echo [ERROR] embedded PostgreSQL not found: %PG_BIN%
  pause
  exit /b 1
)
if not exist "%PG_DATA%\PG_VERSION" (
  echo [ERROR] database cluster not found: %PG_DATA%
  pause
  exit /b 1
)

echo [1/3] PostgreSQL ...
"%PG_BIN%\pg_isready.exe" -h 127.0.0.1 -p %PG_PORT% >nul 2>&1
if errorlevel 1 (
  "%PG_BIN%\pg_ctl.exe" -D "%PG_DATA%" -l "%PG_LOG%" -w start
  if errorlevel 1 (
    echo [ERROR] PostgreSQL failed to start. See %PG_LOG%
    pause
    exit /b 1
  )
)
set "PG_OK=0"
for /l %%N in (1,1,20) do (
  if "!PG_OK!"=="0" (
    "%PG_BIN%\pg_isready.exe" -h 127.0.0.1 -p %PG_PORT% >nul 2>&1
    if not errorlevel 1 set "PG_OK=1"
    if "!PG_OK!"=="0" timeout /t 1 /nobreak >nul
  )
)
if "!PG_OK!"=="0" (
  echo [ERROR] PostgreSQL did not become ready in 20s. See %PG_LOG%
  pause
  exit /b 1
)
echo       ready.

echo [2/3] API ...
if not exist "%ROOT%apps\server\node_modules\.bin\tsx.cmd" (
  echo [ERROR] apps\server dependencies missing.
  echo         Run: cd apps\server ^&^& npx pnpm@12.14.0 install
  pause
  exit /b 1
)
start "FATE-API" /D "%ROOT%apps\server" cmd /k "call "%ROOT%apps\server\node_modules\.bin\tsx.cmd" src/index.ts -addr %API_ADDR% -data ./data -proxy %PROXY_ADDR%"

echo [3/3] Web ...
if exist "%ROOT%web\node_modules\next" (
  start "FATE-WEB" /D "%ROOT%web" cmd /k "set PORT=%WEB_PORT%&& npm run dev"
) else (
  echo       web dependencies missing, skipped. Run: cd web ^&^& npm install
)

echo waiting for API ...
set "API_OK=0"
for /l %%N in (1,1,45) do (
  if "!API_OK!"=="0" (
    curl -s -m 2 http://127.0.0.1:8787/api/health >nul 2>&1
    if not errorlevel 1 set "API_OK=1"
    if "!API_OK!"=="0" timeout /t 1 /nobreak >nul
  )
)
if "!API_OK!"=="1" (
  echo       API ready.
  start "" http://localhost:%WEB_PORT%
) else (
  echo.
  echo [WARN] API did not become ready in 45s. Check the FATE-API window.
  echo        Known blocker in current source: multipart is registered twice
  echo        ^(http/app.ts + routes/skills-mgmt.ts^), so the process exits with
  echo        FST_ERR_CTP_ALREADY_PRESENT until that is fixed.
)
echo.
echo URLs: http://localhost:%WEB_PORT%   ^(API only: http://127.0.0.1:8787^)
echo Stop with stop-fate.bat
endlocal