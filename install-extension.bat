@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ========================================
echo  Ace Code Search - 安装扩展 (.vsix)
echo ========================================
echo.

set "EXT_ID=OscarKing888.ace-code-search"
set "EXT_ID_LOWER=oscarking888.ace-code-search"
set "EXPECTED_VER="
set "VSIX="

where node >nul 2>&1
if not errorlevel 1 (
    for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "EXPECTED_VER=%%v"
    for /f "delims=" %%f in ('node -p "require('./package.json').name + '-' + require('./package.json').version + '.vsix'"') do set "VSIX=%~dp0%%f"
)

if not defined VSIX if defined EXPECTED_VER set "VSIX=%~dp0ace-code-search-%EXPECTED_VER%.vsix"

if not exist "%VSIX%" (
    for /f "delims=" %%f in ('dir /b /o-d "%~dp0*.vsix" 2^>nul') do (
        set "VSIX=%~dp0%%f"
        goto :found_vsix
    )
)

:found_vsix

if not defined VSIX (
    echo [ERROR] 当前目录未找到 .vsix 文件。
    echo         请先运行 build.bat 生成扩展包。
    exit /b 1
)

if not defined EXPECTED_VER (
    for %%f in ("%VSIX%") do set "EXPECTED_VER=%%~nf"
    set "EXPECTED_VER=!EXPECTED_VER:ace-code-search-=!"
)

echo 目标版本: %EXPECTED_VER%
echo 将安装: %VSIX%
echo.

set "TARGET=%~1"
if /i "%TARGET%"=="" set "TARGET=all"
set "INSTALL_FAILED=0"
set "INSTALLED=0"

if /i "%TARGET%"=="all" goto :install_both
if /i "%TARGET%"=="vscode" goto :install_vscode
if /i "%TARGET%"=="cursor" goto :install_cursor
echo [ERROR] 未知目标: %TARGET%
echo        用法: 安装CodeSearch.bat [vscode^|cursor^|all]
exit /b 1

:install_both
call :try_install_vscode
if errorlevel 1 set "INSTALL_FAILED=1"
call :try_install_cursor
if errorlevel 1 set "INSTALL_FAILED=1"
goto :done_install

:install_vscode
call :try_install_vscode
if errorlevel 1 set "INSTALL_FAILED=1"
goto :done_install

:install_cursor
call :try_install_cursor
if errorlevel 1 set "INSTALL_FAILED=1"
goto :done_install

:try_install_vscode
where code >nul 2>&1
if errorlevel 1 (
    echo [SKIP] 未找到 VS Code CLI ^(code^)，已跳过。
    exit /b 0
)
echo 正在安装到 VS Code...
call :install_to_editor code "%USERPROFILE%\.vscode\extensions" "VS Code"
exit /b %ERRORLEVEL%

:try_install_cursor
where cursor >nul 2>&1
if errorlevel 1 (
    echo [SKIP] 未找到 Cursor CLI ^(cursor^)，已跳过。
    exit /b 0
)
echo 正在安装到 Cursor...
call :install_to_editor cursor "%USERPROFILE%\.cursor\extensions" "Cursor"
exit /b %ERRORLEVEL%

:install_to_editor
set "CLI=%~1"
set "EXT_ROOT=%~2"
set "LABEL=%~3"

call :purge_extension_dirs "%EXT_ROOT%"

call %CLI% --uninstall-extension %EXT_ID% >nul 2>&1
call %CLI% --uninstall-extension %EXT_ID_LOWER% >nul 2>&1
call :purge_extension_dirs "%EXT_ROOT%"

call %CLI% --install-extension "%VSIX%" --force
if errorlevel 1 (
    echo [ERROR] %LABEL% 安装失败。
    exit /b 1
)

set "INSTALLED_VER="
for /f "tokens=2 delims=@" %%v in ('%CLI% --list-extensions --show-versions 2^>nul ^| findstr /i "ace-code-search"') do set "INSTALLED_VER=%%v"
if not defined INSTALLED_VER (
    echo [ERROR] %LABEL% 安装后未检测到扩展。
    exit /b 1
)
if /i not "!INSTALLED_VER!"=="%EXPECTED_VER%" (
    echo [ERROR] %LABEL% 版本不匹配：期望 %EXPECTED_VER%，实际 !INSTALLED_VER!
    exit /b 1
)

set "INSTALLED=1"
echo [OK] 已安装到 %LABEL% ^(v!INSTALLED_VER!^)。
call :purge_stale_extension_dirs "%EXT_ROOT%" "!INSTALLED_VER!"
exit /b 0

:purge_extension_dirs
set "EXT_ROOT=%~1"
if not exist "%EXT_ROOT%" exit /b 0
for /d %%d in ("%EXT_ROOT%\oscarking888.ace-code-search-*") do (
    echo   清理旧目录: %%~nxd
    rmdir /s /q "%%~fd" 2>nul
)
for /d %%d in ("%EXT_ROOT%\OscarKing888.ace-code-search-*") do (
    echo   清理旧目录: %%~nxd
    rmdir /s /q "%%~fd" 2>nul
)
exit /b 0

:purge_stale_extension_dirs
set "EXT_ROOT=%~1"
set "KEEP_VER=%~2"
if not exist "%EXT_ROOT%" exit /b 0
for /d %%d in ("%EXT_ROOT%\oscarking888.ace-code-search-*") do (
    echo %%~nxd | findstr /i /c:"-%KEEP_VER%" >nul || (
        echo   清理残留: %%~nxd
        rmdir /s /q "%%~fd" 2>nul
    )
)
for /d %%d in ("%EXT_ROOT%\OscarKing888.ace-code-search-*") do (
    echo %%~nxd | findstr /i /c:"-%KEEP_VER%" >nul || (
        echo   清理残留: %%~nxd
        rmdir /s /q "%%~fd" 2>nul
    )
)
exit /b 0

:done_install
if "!INSTALLED!"=="0" (
    echo.
    echo [ERROR] 未找到可用的编辑器 CLI。请先将以下命令加入 PATH：
    echo   VS Code:  命令面板 -^> "Shell Command: Install 'code' command in PATH"
    echo   Cursor:   命令面板 -^> "Shell Command: Install 'cursor' command in PATH"
    exit /b 1
)
if "!INSTALL_FAILED!"=="1" (
    echo.
    echo [ERROR] 至少一个目标编辑器安装失败。
    exit /b 1
)

echo.
echo ========================================
echo  Done: v%EXPECTED_VER% installed.
echo  Fully quit and restart your editor.
echo  Status bar should show: Ready v%EXPECTED_VER%
echo ========================================
exit /b 0

