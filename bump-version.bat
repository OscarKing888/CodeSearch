@echo off
setlocal EnableExtensions DisableDelayedExpansion

cd /d "%~dp0"

if "%~1"=="" (
    echo Usage:
    echo   bump-version.bat 0.2.1 --notes "Fix Electron ABI 146 native packaging."
    echo.
    echo Updates the version files, commits them, creates an annotated version tag, and pushes
    echo main together with the tag to origin by default - run from a checkout on main.
    echo Use --no-tag to skip the tag, --no-push to keep the commit and tag local,
    echo or --no-commit to only update files.
    exit /b 1
)

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found. Please install Node.js.
    exit /b 1
)

rem scripts\bump-version.js validates and updates the version files, then prints a key=value plan.
rem The commit, tag, and push below are plain git commands.
set "BUMP_PLAN=%TEMP%\codesearch-bump-plan-%RANDOM%%RANDOM%.txt"
set "CODESEARCH_BUMP_ENTRY=1"
node scripts\bump-version.js %* > "%BUMP_PLAN%"
if errorlevel 1 (
    del /q "%BUMP_PLAN%" >nul 2>&1
    exit /b 1
)
for %%K in (version commit create_tag push push_tag) do set "BUMP_%%K="
for /f "usebackq tokens=1,* delims==" %%A in ("%BUMP_PLAN%") do set "BUMP_%%A=%%B"
del /q "%BUMP_PLAN%" >nul 2>&1
if not defined BUMP_version (
    echo [ERROR] scripts\bump-version.js returned an incomplete plan. 1>&2
    exit /b 1
)
set "BUMP_TAG=v%BUMP_version%"

rem --only commits these working-tree paths without including other staged work.
if "%BUMP_commit%"=="1" git commit --only -m "chore: bump version to %BUMP_version%" -- package.json package-lock.json CHANGELOG.md || (
    echo [ERROR] Version files were updated, but the commit failed. Changes were kept. After fixing the Git error, commit only package.json, package-lock.json, and CHANGELOG.md. 1>&2
    exit /b 1
)

set "BUMP_HEAD="
for /f "usebackq delims=" %%H in (`git rev-parse HEAD`) do set "BUMP_HEAD=%%H"
if "%BUMP_create_tag%"=="1" git tag -a "%BUMP_TAG%" %BUMP_HEAD% -m "Release %BUMP_version%" || (
    echo [ERROR] Version commit %BUMP_HEAD% was kept, but creating tag %BUMP_TAG% failed. Fix the Git error and rerun the same version to create the missing tag. Existing tags are never overwritten. 1>&2
    exit /b 1
)
if "%BUMP_create_tag%"=="1" echo Created annotated tag %BUMP_TAG% at %BUMP_HEAD%.

if not "%BUMP_push%"=="1" exit /b 0
set "BUMP_REFS=refs/heads/main:refs/heads/main"
if "%BUMP_push_tag%"=="1" set "BUMP_REFS=%BUMP_REFS% refs/tags/%BUMP_TAG%:refs/tags/%BUMP_TAG%"
rem --atomic: origin gets main and the tag together, or neither.
git push --atomic origin %BUMP_REFS% || (
    echo [ERROR] The local version commit and tag were kept, but pushing to origin failed. Fix the Git error, for example merge origin/main into main, then rerun: bump-version.bat %BUMP_version% 1>&2
    exit /b 1
)
if "%BUMP_push_tag%"=="1" (echo Pushed main and %BUMP_TAG% to origin.) else echo Pushed main to origin.
exit /b 0
