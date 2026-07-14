@echo off
REM Double-click to detect the 960x640 side screen and project the kiosk window onto it.
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0align-screen.ps1"
