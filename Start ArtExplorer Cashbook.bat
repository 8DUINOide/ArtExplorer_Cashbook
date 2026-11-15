@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  start "ArtExplorer Cashbook local server" /min py -m http.server 8765
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3, then run this file again.
    pause
    exit /b 1
  )
  start "ArtExplorer Cashbook local server" /min python -m http.server 8765
)
timeout /t 2 /nobreak >nul
start "" http://localhost:8765
endlocal
