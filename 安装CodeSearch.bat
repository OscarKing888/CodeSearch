@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo  Ace Code Search - 安装扩展 (.vsix)
echo ========================================
echo.

set "VSIX="

for /f "delims=" %%f in ('dir /b /o-d "%~dp0*.vsix" 2^>nul') do (
    set "VSIX=%~dp0%%f"
    goto :found_vsix
)

:found_vsix

if not defined VSIX (
    echo [ERROR] 当前目录未找到 .vsix 文件。
    echo         请先将扩展包放在与本脚本相同的目录下。
    exit /b 1
)

echo 将安装: %VSIX%
echo.

set "TARGET=%~1"
if /i "%TARGET%"=="" set "TARGET=all"

if /i "%TARGET%"=="all" goto :install_both
if /i "%TARGET%"=="vscode" goto :install_vscode
if /i "%TARGET%"=="cursor" goto :install_cursor
echo [ERROR] 未知目标: %TARGET%
echo        用法: 安装CodeSearch.bat [vscode^|cursor^|all]
exit /b 1

:install_both
set "INSTALLED=0"
call :try_install_vscode
call :try_install_cursor
goto :done_install

:install_vscode
set "INSTALLED=0"
call :try_install_vscode
goto :done_install

:install_cursor
set "INSTALLED=0"
call :try_install_cursor
goto :done_install

:try_install_vscode
where code >nul 2>&1
if errorlevel 1 (
    echo [SKIP] 未找到 VS Code CLI ^(code^)，已跳过。
    exit /b 0
)
echo 正在安装到 VS Code...
call code --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo [ERROR] VS Code 安装失败。
    exit /b 1
)
set "INSTALLED=1"
echo [OK] 已安装到 VS Code。
exit /b 0

:try_install_cursor
where cursor >nul 2>&1
if errorlevel 1 (
    echo [SKIP] 未找到 Cursor CLI ^(cursor^)，已跳过。
    exit /b 0
)
echo 正在安装到 Cursor...
call cursor --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo [ERROR] Cursor 安装失败。
    exit /b 1
)
set "INSTALLED=1"
echo [OK] 已安装到 Cursor。
exit /b 0

:done_install
if "!INSTALLED!"=="0" (
    echo.
    echo [ERROR] 未找到可用的编辑器 CLI。请先将以下命令加入 PATH：
    echo   VS Code:  命令面板 -^> "Shell Command: Install 'code' command in PATH"
    echo   Cursor:   命令面板 -^> "Shell Command: Install 'cursor' command in PATH"
    echo.
    echo 也可手动安装：
    echo   code --install-extension "%VSIX%"
    echo   cursor --install-extension "%VSIX%"
    exit /b 1
)

echo.
echo ========================================
echo  扩展安装成功。
echo  请重启 VS Code / Cursor，然后搜索：
echo    命令:  "Ace Code Search"
echo    设置:  "sourceSearch"
echo    面板:  "Ace Code Search" ^(底部^)
echo ========================================
exit /b 0
