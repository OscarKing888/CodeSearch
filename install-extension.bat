@echo off
REM 安装同目录下最新的 .vsix（需先运行 build.bat 生成）
call "%~dp0安装CodeSearch.bat" %*
