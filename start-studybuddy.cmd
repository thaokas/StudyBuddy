@echo off
cd /d "%~dp0"
node "%~dp0scripts\start-studybuddy.mjs" %*
exit /b %errorlevel%
