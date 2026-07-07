@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if "%~1"=="" (
    echo Usage:
    echo   bump-version.bat 0.2.1 --notes "Fix Electron ABI 146 native packaging."
    echo.
    echo Equivalent to:
    echo   npm run version:bump -- 0.2.1 --notes "Fix Electron ABI 146 native packaging."
    exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js with npm.
    exit /b 1
)

call npm run version:bump -- %*
exit /b %ERRORLEVEL%
