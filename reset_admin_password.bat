@echo off
cd /d "%~dp0"
python reset_admin_password.py
if errorlevel 1 (
  echo.
  echo Reset password gagal.
)
echo.
pause
