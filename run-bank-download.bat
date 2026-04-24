@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo.
echo ========================================
echo  Sumishin SBI CSV Download
echo ========================================
echo.

node scripts/download_sumishin_csv.js

echo.
if %ERRORLEVEL% == 0 (
    echo ========================================
    echo  Done! CSV files saved to downloads/
echo ========================================
) else (
    echo ========================================
    echo  Error occurred. Check data/ folder.
    echo ========================================
)

echo.
pause
