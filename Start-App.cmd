@echo off
cd /d "%~dp0"
python backend/server.py --open-browser
if errorlevel 1 pause
