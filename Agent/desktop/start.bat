@echo off
rem Panorama Maps - desktop launcher (Windows)
rem Double-click this file.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Panorama Maps needs Node.js ^(18 or newer^) - https://nodejs.org
  pause
  exit /b 1
)
node --no-warnings=ExperimentalWarning main.mjs %*
if errorlevel 1 pause
