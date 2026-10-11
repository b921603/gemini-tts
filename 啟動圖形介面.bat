@echo off
cd /d "%~dp0local"
where py >nul 2>nul && (py -3 tts_gui.py %* & goto done)
where python >nul 2>nul && (python tts_gui.py %* & goto done)
echo [!] Python not found. Run: winget install Python.Python.3.12
pause
exit /b 1
:done
if errorlevel 1 pause
