@echo off
setlocal

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=update"

if /I "%ACTION%"=="update" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push-both-repos.ps1" -Commit -Message "Update bot source"
  exit /b %ERRORLEVEL%
)

if /I "%ACTION%"=="force-update" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\push-both-repos.ps1" -Commit -Message "Sync bot source to both repos" -ForceSecondRemote
  exit /b %ERRORLEVEL%
)

echo Usage:
echo   .\push update
echo   .\push force-update
exit /b 1
