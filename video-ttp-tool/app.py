"""
動画TTP 自動編集ツール - ブラウザUI
start.bat をダブルクリックすると自動でブラウザが開きます
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import streamlit as st
import yaml
from dotenv import load_dotenv, set_key

ROOT = Path(__file__).parent
ENV_FILE = ROOT / ".env"

# output は Dropbox/OneDrive 外のデスクトップに置く（ファイルロック回避）
OUTPUT_DIR = Path.home() / "Desktop" / "video-ttp-output"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

load_dotenv(ENV_FILE)

# ─── ページ設定 ────────────────────────────────────────────────
st.set_page_config(
    page_title="動画TTP 自動編集ツール",
    page_icon="🎬",
    layout="centered",
)

st.markdown(
    """
    <style>
    /* 実行ボタンを目立たせる */
    div[data-testid="stButton"] > button[kind="primary"] {
        background: linear-gradient(135deg, #6C63FF, #4B40CC);
        color: white;
        border: none;
        border-radius: 12px;
        font-size: 1.1rem;
        font-weight: 700;
        padding: 0.75rem 2rem;
        width: 100%;
        height: 3.2rem;
    }
    div[data-testid="stButton"] > button[kind="primary"]:hover {
        background: linear-gradient(135deg, #5a51e0, #3a30bb);
    }
    .status-done   { color: #059669; font-weight: bold; }
    .status-error  { color: #DC2626; font-weight: bold; }
    </style>
    """,
    unsafe_allow_html=True,
)

# ─── セッション初期化 ──────────────────────────────────────────
def _init_state() -> None:
    if "avoid_count" not in st.session_state:
        st.session_state.avoid_count = 1
    if "running" not in st.session_state:
        st.session_state.running = False
    if "done" not in st.session_state:
        st.session_state.done = False
    if "output_path" not in st.session_state:
        st.session_state.output_path = None

_init_state()

# ─── ヘッダー ──────────────────────────────────────────────────
st.title("🎬 動画TTP 自動編集ツール")
st.caption(
    "参考動画の構成を元に、素材動画から対応箇所を自動抽出・結合して"
    "完成動画を作ります。URLを貼り付けてボタンを押すだけ！"
)
st.divider()

# ─── タイムスタンプパーサー ────────────────────────────────────
def parse_timestamps(text: str) -> list[dict]:
    """
    テキストから複数のタイムスタンプを解析。
    対応フォーマット:
      0:14 - 0:22   /   0:14〜0:22   /   0:14→0:22
      7:02:51 - 7:07:27
    """
    clips = []
    for line in text.strip().splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(r"([\d:]+)\s*[-〜→~–—]+\s*([\d:]+)", line)
        if m:
            clips.append({"start": m.group(1).strip(), "end": m.group(2).strip()})
    return clips


# ─── Section 1: 動画URL ───────────────────────────────────────
st.subheader("① 動画URL を入力")

ref_url = st.text_input(
    "参考動画URL（TTPしたい動画）",
    placeholder="https://youtu.be/xxxxxxxxxx",
    help="構成・ナレーション台本の参照元になります。映像は使いません。",
)

src_url = st.text_input(
    "素材動画URL（実際に使う映像）",
    placeholder="https://www.youtube.com/watch?v=xxxxxxxxxx",
)

st.divider()

# ─── Section 2: 複製回避素材 ──────────────────────────────────
st.subheader("② 複製回避素材（任意）")
st.caption("まとめ箇所の直前に自動で挿入されます。不要な場合は空欄でOK。")

avoid_data: list[dict] = []

for i in range(st.session_state.avoid_count):
    with st.expander(f"素材 {i + 1}", expanded=(i == 0)):
        url_key = f"avoid_url_{i}"
        ts_key  = f"avoid_ts_{i}"

        av_url = st.text_input(
            "URL",
            key=url_key,
            placeholder="https://www.youtube.com/watch?v=xxxxxxxxxx",
        )
        av_ts = st.text_area(
            "タイムスタンプ（1行に 1区間: 開始 - 終了）",
            key=ts_key,
            height=120,
            placeholder=(
                "0:14 - 0:22\n"
                "1:55 - 2:03\n"
                "2:07 - 2:15"
            ),
            help="ハイフン・〜・→ のどれでも認識します",
        )
        if av_url:
            clips = parse_timestamps(av_ts)
            if clips:
                avoid_data.append({"url": av_url, "clips": clips})
            else:
                st.warning("タイムスタンプが読み取れません。例: `0:14 - 0:22`")

col_add, col_remove = st.columns([1, 1])
with col_add:
    if st.button("＋ 素材を追加"):
        st.session_state.avoid_count += 1
        st.rerun()
with col_remove:
    if st.session_state.avoid_count > 1 and st.button("－ 素材を削除"):
        st.session_state.avoid_count -= 1
        st.rerun()

st.divider()

# ─── Section 3: 詳細設定 ──────────────────────────────────────
with st.expander("⚙️ 詳細設定（変更しなくてもOK）"):

    st.markdown("**OpenAI API キー**（セマンティックマッチングに使用）")
    saved_key = os.environ.get("OPENAI_API_KEY", "")
    api_key = st.text_input(
        "APIキー",
        value=saved_key,
        type="password",
        placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx",
        help="入力すると次回から自動で入力されます",
    )
    if api_key and api_key != saved_key:
        ENV_FILE.touch()
        set_key(str(ENV_FILE), "OPENAI_API_KEY", api_key)
        st.success("APIキーを保存しました")

    st.markdown("---")

    use_voicevox = st.checkbox(
        "VOICEVOX 波音リツでナレーションを差し替える",
        value=True,
        help="VOICEVOXアプリが起動していることを確認してください",
    )

    if use_voicevox:
        vox_speed = st.slider("読み上げ速度", 0.5, 2.0, 1.0, 0.1)
    else:
        vox_speed = 1.0
        st.info("チェックを外した場合、素材動画の元の音声がそのまま使われます。")

    st.markdown("---")

    threshold = st.slider(
        "マッチング精度（似ている箇所のしきい値）",
        0.50, 0.95, 0.75, 0.05,
        help="下げると多くヒット（ヌケが減る）、上げると精度重視（ノイズが減る）",
    )
    merge_gap = st.slider(
        "連続マッチを統合する間隔（秒）",
        1.0, 10.0, 3.0, 0.5,
        help="大きくするとブツ切れが減る。会話が途切れる場合は増やす",
    )
    insert_before = st.number_input(
        "複製回避素材を末尾から何番目のクリップの前に挿入するか",
        min_value=1, max_value=10, value=2,
    )

st.divider()

# ─── 実行ボタン ───────────────────────────────────────────────
ready = bool(ref_url and src_url and api_key)
if not ready:
    missing = []
    if not ref_url:  missing.append("参考動画URL")
    if not src_url:  missing.append("素材動画URL")
    if not api_key:  missing.append("OpenAI APIキー（詳細設定内）")
    st.warning(f"以下を入力してください: {' / '.join(missing)}")

run_btn = st.button("🚀  編集を開始する", type="primary", disabled=not ready)

# ─── パイプライン実行 ──────────────────────────────────────────
if run_btn and ready:
    st.session_state.done = False
    st.session_state.output_path = None

    # 一時設定ファイルを書き出す
    config = {
        "reference_video": ref_url,
        "source_video": src_url,
        "avoid_clips": avoid_data,
        "matching": {
            "whisper_model": "medium",
            "similarity_threshold": float(threshold),
            "merge_gap_seconds": float(merge_gap),
            "min_clip_duration": 2.0,
            "context_window": 2,
            "summary_insert_before_last": int(insert_before),
        },
        "voicevox": {
            "enabled": use_voicevox,
            "speaker_id": 9,
            "host": "http://localhost:50021",
            "speed": float(vox_speed),
        },
        "openai": {
            "api_key_env": "OPENAI_API_KEY",
            "embedding_model": "text-embedding-3-small",
        },
        "output": {
            "dir": str(OUTPUT_DIR),
            "filename": "final_video.mp4",
            "video_quality": "medium",
        },
    }

    config_tmp = ROOT / "_run_config.yaml"
    config_tmp.write_text(
        yaml.dump(config, allow_unicode=True, default_flow_style=False),
        encoding="utf-8",
    )

    env = {**os.environ, "OPENAI_API_KEY": api_key, "PYTHONIOENCODING": "utf-8"}

    st.markdown("### 🔄 実行ログ")
    log_box = st.empty()
    log_lines: list[str] = []

    # アイコン変換テーブル（ログを見やすく）
    ICONS = {
        "Step 1": "📥 Step 1",
        "Step 2": "📝 Step 2",
        "Step 3": "🧠 Step 3",
        "Step 4": "🗣️ Step 4",
        "Step 5": "✂️ Step 5",
        "✅": "✅",
        "❌": "❌",
        "⚠️": "⚠️",
    }

    try:
        proc = subprocess.Popen(
            [sys.executable, str(ROOT / "main.py"), "--config", str(config_tmp)],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            cwd=str(ROOT),
            env=env,
        )

        for raw_line in iter(proc.stdout.readline, ""):
            line = raw_line.rstrip()
            if line:
                log_lines.append(line)
            # 最新 60 行をコードブロックに表示
            log_box.code("\n".join(log_lines[-60:]), language="")

        proc.wait()
        return_code = proc.returncode

    except Exception as e:
        st.error(f"実行中にエラーが発生しました: {e}")
        return_code = 1

    config_tmp.unlink(missing_ok=True)

    output_path = OUTPUT_DIR / "final_video.mp4"

    if return_code == 0 and output_path.exists():
        st.session_state.done = True
        st.session_state.output_path = str(output_path)
        st.success("✅ 完成しました！下のボタンからダウンロードしてください。")
    else:
        st.error("❌ エラーが発生しました。上のログを確認してください。")

# ─── ダウンロードボタン ───────────────────────────────────────
if st.session_state.done and st.session_state.output_path:
    out_file = Path(st.session_state.output_path)
    if out_file.exists():
        st.divider()
        st.markdown("### 🎬 完成動画")
        st.video(str(out_file))
        with open(out_file, "rb") as f:
            st.download_button(
                label="⬇️  動画をダウンロード（final_video.mp4）",
                data=f,
                file_name="final_video.mp4",
                mime="video/mp4",
            )
