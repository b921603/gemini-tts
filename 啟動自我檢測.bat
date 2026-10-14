@echo off
cd /d "%~dp0local"
where py >nul 2>nul && (py -3 selftest.py %* & goto done)
where python >nul 2>nul && (python selftest.py %* & goto done)
echo [!] Python not found. Run: winget install Python.Python.3.12
:done
echo.
pause
