@echo off
chcp 65001 >nul
title DirectorCam - Dev Launcher

:: Cleanup stale processes
echo Cleaning up stale processes...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :5173 ^| findstr LISTENING') do (
    taskkill /f /pid %%a >nul 2>&1
    echo   Killed stale Vite on port 5173 (PID %%a)
)
taskkill /f /im directorcam.exe >nul 2>&1

:: Switch to project directory
cd /d "%~dp0"
if errorlevel 1 (
    echo ERROR: Cannot access project directory.
    pause
    exit /b
)

echo ========================================
echo   DirectorCam - Starting Dev Mode
echo   Path: %cd%
echo ========================================
echo.

call npm run tauri dev
pause