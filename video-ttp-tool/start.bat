@echo off
chcp 65001 > nul
title 動画TTP 自動編集ツール

echo.
echo  ================================================
echo   動画TTP 自動編集ツール を起動します
echo  ================================================
echo.

REM ── Python の確認 ─────────────────────────────────────────────
python --version > nul 2>&1
if %errorlevel% neq 0 (
    echo  [エラー] Python が見つかりません。
    echo.
    echo  以下のURLから Python をインストールしてください:
    echo  https://www.python.org/downloads/
    echo.
    echo  ※ インストール時に「Add Python to PATH」にチェックを入れてください
    echo.
    pause
    exit /b 1
)

REM ── ffmpeg の確認 ─────────────────────────────────────────────
ffmpeg -version > nul 2>&1
if %errorlevel% neq 0 (
    echo  [エラー] ffmpeg が見つかりません。
    echo.
    echo  以下のURLから ffmpeg をダウンロードして、
    echo  PATH に追加してください:
    echo  https://ffmpeg.org/download.html
    echo.
    echo  （わからない場合はサポートまでご連絡ください）
    echo.
    pause
    exit /b 1
)

REM ── 仮想環境の作成（初回のみ） ───────────────────────────────
if not exist ".venv" (
    echo  [初期設定] 仮想環境を作成中...
    python -m venv .venv
    echo  完了
    echo.
)

REM ── 仮想環境を有効化 ──────────────────────────────────────────
call .venv\Scripts\activate.bat

REM ── ライブラリのインストール（初回 or 更新時） ────────────────
python -c "import streamlit" > nul 2>&1
if %errorlevel% neq 0 (
    echo  [初期設定] 必要なライブラリをインストール中...
    echo  （初回は数分かかります。そのままお待ちください）
    echo.
    pip install -r requirements.txt --quiet
    pip install streamlit --quiet
    echo  インストール完了
    echo.
)

REM ── ブラウザを開く（サーバー起動後に自動で開く） ─────────────
echo  ブラウザが開きます。しばらくお待ちください...
echo.
echo  ※ このウィンドウは閉じないでください
echo    （ツールを終了したいときは Ctrl+C を押してください）
echo.

streamlit run app.py --server.headless false --browser.gatherUsageStats false

pause
