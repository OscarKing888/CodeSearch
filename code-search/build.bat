@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo  Code Search - Build Extension
echo ========================================
echo.

set "TARGET=%~1"
if /i "%TARGET%"=="" set "TARGET=all"

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    exit /b 1
)

if not exist "node_modules\" (
    echo node_modules not found. Running install.bat...
    call "%~dp0install.bat"
    if errorlevel 1 exit /b 1
    echo.
)

echo [1/4] Rebuilding better-sqlite3 for editor Electron...
node "%~dp0scripts\rebuild-electron.js" %TARGET%
if errorlevel 1 (
    echo [ERROR] Electron rebuild failed.
    exit /b 1
)

echo.
echo [2/4] Building extension (esbuild)...
call npm run build
if errorlevel 1 (
    echo.
    echo [ERROR] Build failed.
    exit /b 1
)

echo.
echo [3/4] Running tests...
call npm test
if errorlevel 1 (
    echo.
    echo [ERROR] Tests failed.
    exit /b 1
)

echo.
echo [4/4] Packaging VSIX...
call npx --yes @vscode/vsce package --allow-missing-repository --baseContentUrl https://github.com/local/source-search/blob/main/source-search
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
exit /b 0
