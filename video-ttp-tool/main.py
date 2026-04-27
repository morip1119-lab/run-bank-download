#!/usr/bin/env python3
"""
動画TTP 自動編集ツール
======================
参考動画の構成を元に、素材動画から意味的に対応する箇所を抽出・結合し、
VOICEVOX 波音リツのナレーション付きで完成動画を出力します。

使い方:
  python main.py                          全ステップ実行
  python main.py --skip-download          ダウンロード済みならスキップ
  python main.py --skip-transcribe        文字起こし済みならスキップ
  python main.py --skip-match             マッチング済みならスキップ
  python main.py --skip-voice             元の音声を使用（VOICEVOX 不要）
  python main.py --config my_config.yaml  設定ファイルを指定

環境変数:
  OPENAI_API_KEY  OpenAI API キー（Step 3 のセマンティックマッチングに必要）
"""
import sys
import argparse
from pathlib import Path

import yaml
from dotenv import load_dotenv

# .env ファイルを自動読み込み（OPENAI_API_KEY 等）
load_dotenv()


def load_yaml(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def header(text: str) -> None:
    print(f"\n{'━' * 50}")
    print(f"  {text}")
    print(f"{'━' * 50}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="動画TTP 自動編集ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--config", default="config.yaml", help="設定ファイルパス")
    parser.add_argument("--skip-download",   action="store_true", help="Step 1 スキップ")
    parser.add_argument("--skip-transcribe", action="store_true", help="Step 2 スキップ")
    parser.add_argument("--skip-match",      action="store_true", help="Step 3 スキップ")
    parser.add_argument("--skip-voice",      action="store_true", help="Step 4 スキップ")
    args = parser.parse_args()

    config_path = Path(args.config)
    if not config_path.exists():
        print(f"❌ 設定ファイルが見つかりません: {config_path}")
        print("   config.yaml をコピーして編集してください。")
        sys.exit(1)

    config = load_yaml(str(config_path))
    output_dir = Path(config["output"]["dir"]).expanduser()
    output_dir.mkdir(parents=True, exist_ok=True)

    # ── 遅延インポート（実行時のみ読み込む）──────────────────
    from pipeline.download   import download_videos, load_paths
    from pipeline.transcribe import transcribe_videos, load_transcripts
    from pipeline.match      import find_matching_segments, load_segments
    from pipeline.voice      import synthesize_narration
    from pipeline.assemble   import assemble_video

    # ── Step 1: ダウンロード ──────────────────────────────────
    header("Step 1 / 5  動画ダウンロード")
    if args.skip_download:
        print("  スキップ（保存済みファイルを使用）")
        paths = load_paths(output_dir)
    else:
        paths = download_videos(config, output_dir)

    # ── Step 2: 文字起こし ────────────────────────────────────
    header("Step 2 / 5  文字起こし（Whisper）")
    model_size = (
        config.get("matching", {})
        .get("whisper_model", "medium")
        .replace("whisper-", "")
    )
    if args.skip_transcribe:
        print("  スキップ（保存済みデータを使用）")
        transcripts = load_transcripts(output_dir)
    else:
        transcripts = transcribe_videos(paths, output_dir, model_size)

    # ── Step 3: セマンティックマッチング ─────────────────────
    header("Step 3 / 5  セマンティックマッチング")
    if args.skip_match:
        print("  スキップ（保存済みデータを使用）")
        segments = load_segments(output_dir)
    else:
        segments = find_matching_segments(transcripts, config, output_dir)

    if not segments:
        print("\n❌ マッチするセグメントが見つかりませんでした。")
        print("   config.yaml の similarity_threshold を下げてみてください（現在値を確認）。")
        sys.exit(1)

    # ── Step 4: 音声合成 ──────────────────────────────────────
    header("Step 4 / 5  ナレーション音声合成（波音リツ）")
    if args.skip_voice:
        print("  スキップ（素材動画の元の音声を使用）")
        audio_segments = []
    else:
        audio_segments = synthesize_narration(
            transcripts["reference"], segments, config, output_dir
        )

    # ── Step 5: 動画組み立て ──────────────────────────────────
    header("Step 5 / 5  動画の組み立て")
    output_path = assemble_video(paths, segments, audio_segments, config, output_dir)

    # ── 完了 ──────────────────────────────────────────────────
    print(f"\n{'━' * 50}")
    print(f"  ✅ 完成！")
    print(f"  出力ファイル: {output_path.resolve()}")
    print(f"{'━' * 50}\n")


if __name__ == "__main__":
    main()
