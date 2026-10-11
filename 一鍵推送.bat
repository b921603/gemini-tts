@echo off
setlocal
cd /d "%~dp0"
where git >nul 2>nul || (echo [!] Git not found. Run: winget install --id Git.Git -e & pause & exit /b 1)
where py >nul 2>nul && (py -3 deploy.py %* & goto done)
where python >nul 2>nul && (python deploy.py %* & goto done)
echo [!] Python not found. Run: winget install Python.Python.3.12
:done
echo.
pause
