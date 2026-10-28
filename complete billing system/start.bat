@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  MartBill - start the billing system
rem  Double-click this file. Close this window to stop the system.
rem
rem  Optional:  start.bat --no-open     start without opening the browser
rem             set PORT=3305           run on another port
rem ---------------------------------------------------------------

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed on this computer.
  echo   Install Node.js 18 or newer from https://nodejs.org  then double-click this file again.
  echo.
  pause
  exit /b 1
)

if "%PORT%"=="" set "PORT=3000"

if not exist "node_modules" (
  echo.
  echo   First run: installing the required files. This takes about a minute...
  echo.
  call npm install --omit=dev
  if errorlevel 1 (
    echo.
    echo   Installation failed. Check the internet connection and try again.
    echo.
    pause
    exit /b 1
  )
)

if not exist "dist\index.html" (
  echo   Building the interface...
  call npm run build
  if errorlevel 1 (
    echo   Build failed. Re-install Node.js and try again.
    pause
    exit /b 1
  )
)

echo.
echo   Starting MartBill...
echo       address : http://localhost:%PORT%
echo       login   : admin / admin123   (change it after the first login)
echo.
echo   To STOP the system, close this window.
echo.

if /i not "%~1"=="--no-open" start "" "http://localhost:%PORT%"
call node server\index.js
echo.
echo   MartBill stopped.
pause
exit /b 0
