@echo off
cd /d "%~dp0"
set "STUDYBUDDY_NODE=D:\Applications\nvm\app\v26.13.0\node.exe"
if not exist "%STUDYBUDDY_NODE%" set "STUDYBUDDY_NODE=node"
"%STUDYBUDDY_NODE%" "%~dp0scripts\start-studybuddy.mjs" %*
exit /b %errorlevel%
