# 動画TTP 自動編集ツール

参考動画の構成を元に、素材動画から対応箇所を自動抽出・結合し、  
VOICEVOX 波音リツのナレーション付き完成動画を出力するツールです。

---

## セットアップ（初回のみ）

### 1. 必要なソフトウェア

| ソフト | インストール方法 |
|---|---|
| Python 3.10 以上 | https://www.python.org/ |
| ffmpeg | https://ffmpeg.org/download.html （PATH に追加が必要） |
| VOICEVOX エンジン | https://voicevox.hiroshiba.jp/ （アプリを起動するだけでOK） |

### 2. Python ライブラリのインストール

```bash
cd video-ttp-tool
pip install -r requirements.txt
```

### 3. OpenAI API キーを設定

`.env.example` を `.env` にコピーして API キーを書く：

```
OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 使い方

### 基本（全ステップ自動実行）

```bash
# VOICEVOX アプリを起動してから実行
python main.py
```

完成動画は `output/final_video.mp4` に出力されます。

### 別の動画で使う場合

`config.yaml` の URL を変更するだけです：

```yaml
reference_video: "参考にしたいYouTube動画URL"
source_video:    "素材動画URL"
```

### ステップ別実行（途中から再開できます）

```bash
# ダウンロード済みならスキップ
python main.py --skip-download

# 文字起こし済みならスキップ
python main.py --skip-download --skip-transcribe

# マッチング結果を確認してから続きを実行
python main.py --skip-download --skip-transcribe --skip-match

# VOICEVOX を使わず元の音声のまま
python main.py --skip-voice
```

---

## 処理の流れ

```
Step 1  動画ダウンロード（yt-dlp）
  ↓
Step 2  文字起こし（Whisper）
  ↓
Step 3  セマンティックマッチング（OpenAI Embeddings）
         ※ 意味・文脈の類似度で参考動画と素材動画の対応箇所を特定
  ↓
Step 4  ナレーション音声合成（VOICEVOX 波音リツ）
  ↓
Step 5  動画の組み立て（ffmpeg）
         ※ 複製回避クリップをまとめ箇所の直前に自動挿入
  ↓
output/final_video.mp4 完成
```

---

## 調整のポイント

| 設定項目 | 説明 | 推奨調整 |
|---|---|---|
| `similarity_threshold` | マッチング精度のしきい値（0〜1） | ヒットが少なければ 0.65 に下げる |
| `merge_gap_seconds` | 何秒以内の連続マッチを統合するか | 会話が細切れになる場合は 5.0 に上げる |
| `min_clip_duration` | 短すぎるクリップを除外する秒数 | 短いカットが多い場合は 1.0 に下げる |
| `summary_insert_before_last` | 複製回避素材を末尾から何番目の前に挿入するか | 2〜3 が目安 |
| `whisper_model` | `medium`（バランス）/ `large`（高精度・遅い）| 精度が低い場合は `large` に変更 |
| `voicevox.speed` | 読み上げ速度（1.0 = 標準） | 速すぎる場合は 0.9 に下げる |

---

## VOICEVOX について

- **必要なもの**: [VOICEVOX](https://voicevox.hiroshiba.jp/) をダウンロードしてインストール
- **起動方法**: アプリを開くだけでバックグラウンドにエンジンが立ち上がります（`localhost:50021`）
- **波音リツ**: デフォルトでは speaker_id=9。VOICEVOX アプリで確認できます
- **Docker 版**: `docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-ubuntu20.04-latest`

---

## フォルダ構成

```
video-ttp-tool/
├── main.py               エントリーポイント
├── config.yaml           設定ファイル（URLやパラメータを変更）
├── requirements.txt      必要ライブラリ
├── .env                  API キー（自分で作成）
├── pipeline/
│   ├── download.py       Step 1: yt-dlp ダウンロード
│   ├── transcribe.py     Step 2: Whisper 文字起こし
│   ├── match.py          Step 3: セマンティックマッチング
│   ├── voice.py          Step 4: VOICEVOX 音声合成
│   └── assemble.py       Step 5: ffmpeg 動画組み立て
└── output/               完成動画・中間ファイルの保存先
```
