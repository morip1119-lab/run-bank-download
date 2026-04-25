@echo off
chcp 65001 > nul
cd /d "%~dp0"

echo [%DATE% %TIME%] 月次CSVダウンロード開始 >> data\schedule.log 2>&1
node scripts/download_sumishin_csv.js >> data\schedule.log 2>&1
echo [%DATE% %TIME%] 月次CSVダウンロード終了 >> data\schedule.log 2>&1
