@echo off
setlocal
cd /d "%~dp0"
where py >nul 2>nul
if not errorlevel 1 (
  start "ArtExplorer Cashbook local server" /min py -u -m http.server 8765 --bind 127.0.0.1
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Python was not found. Install Python 3, then run this file again.
    pause
    exit /b 1
  )
  start "ArtExplorer Cashbook local server" /min python -u -m http.server 8765 --bind 127.0.0.1
)

for /l %%i in (1,1,20) do (
  powershell -NoProfile -Command "$client = New-Object System.Net.Sockets.TcpClient; try { $client.Connect('127.0.0.1',8765); exit 0 } catch { exit 1 } finally { $client.Dispose() }" >nul 2>nul
  if not errorlevel 1 goto server_ready
  timeout /t 1 /nobreak >nul
)

echo The ArtExplorer local server did not start on port 8765.
echo Check that Python can run and that a security program did not block it.
pause
exit /b 1

:server_ready
start "" http://127.0.0.1:8765/
endlocal
