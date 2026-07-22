@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo  Ace Code Search - Build Extension
echo ========================================
echo.

del *.vsix

set "TARGET=%~1"
if /i "%TARGET%"=="" set "TARGET=all"

set "ACS_NODE_ENV=%TEMP%\ace-code-search-node-%RANDOM%%RANDOM%.cmd"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\ensure-node.ps1" -Root "%CD%" -CmdFile "%ACS_NODE_ENV%"
if errorlevel 1 (
    echo [ERROR] Could not prepare a compatible Node.js runtime.
    exit /b 1
)
call "%ACS_NODE_ENV%"
del "%ACS_NODE_ENV%" >nul 2>&1

node "%~dp0scripts\check-node-version.js"
if errorlevel 1 exit /b 1

if not exist "node_modules\" (
    echo node_modules not found. Running install.bat...
    call "%~dp0install.bat"
    if errorlevel 1 exit /b 1
    echo.
)

echo [1/4] Building extension (esbuild)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    exit /b 1
)

echo.
echo [2/4] Running tests...
node "%~dp0scripts\rebuild-node.js" --all-detected
if errorlevel 1 (
    echo [ERROR] better-sqlite3 rebuild for detected Node runtimes failed.
    exit /b 1
)
call npm test
if errorlevel 1 (
    echo.
    echo [ERROR] Tests failed.
    exit /b 1
)

echo.
echo [3/4] Rebuilding better-sqlite3 for editor Electron...
node "%~dp0scripts\rebuild-electron.js" %TARGET%
if errorlevel 1 (
    echo [ERROR] Electron rebuild failed.
    exit /b 1
)

echo.
echo [4/4] Packaging VSIX...
call npm run package
if errorlevel 1 (
    echo [ERROR] vsce package failed.
    exit /b 1
)

for /f "delims=" %%v in ('node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'"') do set "VSIX=%%v"

if not exist "!VSIX!" (
    echo [ERROR] Expected package file not found: !VSIX!
    exit /b 1
)

echo.
echo ========================================
echo  Build completed successfully.
echo.
echo  Output:
echo    dist\extension.js
echo    dist\webview\main.js
echo    !VSIX!
echo.
echo  Debug: open this folder in VS Code and press F5
echo  Install: run 安装CodeSearch.bat
echo ========================================
call "%~dp0install-extension.bat"
exit /b %ERRORLEVEL%
