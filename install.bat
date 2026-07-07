@echo off
setlocal EnableExtensions

cd /d "%~dp0"

echo ========================================
echo  Ace Code Search - Install Dependencies
echo ========================================
echo.

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

where npm >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js with npm.
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VERSION=%%v
echo Node.js: %NODE_VERSION%
for /f "tokens=*" %%v in ('npm -v') do set NPM_VERSION=%%v
echo npm:     %NPM_VERSION%
echo.

echo [1/3] Running npm install...
echo       better-sqlite3 requires native build tools on Windows:
echo       - Visual Studio Build Tools with "Desktop development with C++"
echo       - or: npm install -g windows-build-tools
echo.
call npm install
if errorlevel 1 (
    echo.
    echo [ERROR] npm install failed.
    echo        If the npm log shows EINTEGRITY, run: npm cache clean --force
    echo        Then retry install.bat or build.bat with Node.js 20+.
    exit /b 1
)

echo [2/3] Rebuilding better-sqlite3 for VS Code / Cursor Electron...
echo       (native module must match editor Electron, not system Node.js)
node "%~dp0scripts\rebuild-electron.js" all
if errorlevel 1 (
    echo.
    echo [WARN] Electron rebuild failed. Extension may not run in VS Code / Cursor.
    echo        Install Visual Studio Build Tools and run install.bat again.
    exit /b 1
)

echo.
echo [3/3] Optional: rebuild for CLI on system Node.js
echo       Skip this if you only use the VS Code extension.
node "%~dp0scripts\rebuild-node.js"
if errorlevel 1 (
    echo [WARN] System Node rebuild failed. CLI ^(ess^) may not work; extension is unaffected.
)

echo.
echo ========================================
echo  Install completed successfully.
echo  Next: run build.bat, then 安装CodeSearch.bat
echo ========================================
exit /b 0
