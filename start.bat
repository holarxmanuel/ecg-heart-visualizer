@echo off
REM Real-Time ECG Heart Visualizer -- double-click launcher.
REM Delegates to start.ps1, bypassing the execution policy for this run only
REM (it does not change any machine-wide setting).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
