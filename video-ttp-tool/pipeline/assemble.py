"""
Step 5: ffmpeg でクリップをカット・音声差し替え・結合する

処理フロー:
  1. 素材動画から各マッチセグメントをカット
  2. VOICEVOX 音声が存在するクリップは音声を差し替え
  3. 複製回避クリップをカット
  4. [メインクリップ群] の末尾 N 番目の前に回避クリップを挿入
  5. 全クリップを一定フォーマットに再エンコードして結合
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import List, Dict


# ─── ffmpeg ユーティリティ ────────────────────────────────────

def _run(args: List[str], desc: str = "") -> None:
    cmd = ["ffmpeg", "-y"] + args
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"ffmpeg エラー [{desc}]:\n{result.stderr[-500:]}"
        )


def _get_video_info(path: Path) -> Dict:
    """ffprobe でビデオのサイズ・フレームレートを取得"""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_streams", str(path),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    data = json.loads(r.stdout)
    vs = next((s for s in data.get("streams", []) if s["codec_type"] == "video"), {})
    w = int(vs.get("width", 1920))
    h = int(vs.get("height", 1080))
    fps_str = vs.get("r_frame_rate", "30/1")
    try:
        num, den = fps_str.split("/")
        fps = round(int(num) / int(den), 3)
    except Exception:
        fps = 30.0
    return {"width": w, "height": h, "fps": fps}


def _reencode(
    input_path: Path,
    output_path: Path,
    target_w: int,
    target_h: int,
    fps: float,
    crf: int = 23,
) -> None:
    """
    再エンコード。解像度・fps を揃えることで concat が確実に動く。
    スケール時にアスペクト比を維持してパディング。
    """
    vf = (
        f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
        f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,"
        f"fps={fps}"
    )
    _run(
        [
            "-i", str(input_path),
            "-vf", vf,
            "-c:v", "libx264", "-crf", str(crf), "-preset", "fast",
            "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
            str(output_path),
        ],
        f"reencode {input_path.name}",
    )


def _cut(source: Path, start: float, end: float, output: Path) -> None:
    """精密カット（-ss を -i の前に置かないことで再エンコードなし）"""
    _run(
        [
            "-ss", str(start), "-to", str(end),
            "-i", str(source),
            "-c", "copy",
            str(output),
        ],
        f"cut {start:.1f}-{end:.1f}",
    )


def _replace_audio(video: Path, audio: Path, output: Path) -> None:
    """動画の音声トラックを WAV ファイルで置き換える"""
    _run(
        [
            "-i", str(video),
            "-i", str(audio),
            "-c:v", "copy",
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-shortest",
            str(output),
        ],
        "replace_audio",
    )


def _concat(clip_paths: List[Path], output: Path) -> None:
    """concat demuxer で複数クリップを結合"""
    list_file = output.parent / "_concat_list.txt"
    list_file.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in clip_paths),
        encoding="utf-8",
    )
    _run(
        [
            "-f", "concat", "-safe", "0",
            "-i", str(list_file),
            "-c", "copy",
            str(output),
        ],
        "concat",
    )
    list_file.unlink(missing_ok=True)


# ─── 時刻パーサー ─────────────────────────────────────────────

def _to_seconds(t) -> float:
    """HH:MM:SS, MM:SS, SS（数値・文字列）-> float 秒"""
    if isinstance(t, (int, float)):
        return float(t)
    parts = str(t).strip().split(":")
    nums = [float(p) for p in parts]
    if len(nums) == 3:
        return nums[0] * 3600 + nums[1] * 60 + nums[2]
    if len(nums) == 2:
        return nums[0] * 60 + nums[1]
    return nums[0]


# ─── メイン ───────────────────────────────────────────────────

def assemble_video(
    paths: dict,
    segments: List[Dict],
    audio_segments: List[Dict],
    config: dict,
    output_dir: Path,
) -> Path:
    """全クリップを組み立てて最終動画を出力する"""

    clips_dir = output_dir / "clips"
    clips_dir.mkdir(exist_ok=True)

    quality_map = {"low": 28, "medium": 23, "high": 18}
    quality = config.get("output", {}).get("video_quality", "medium")
    crf = quality_map.get(quality, 23)
    insert_before = config.get("matching", {}).get("summary_insert_before_last", 2)

    audio_map = {a["clip_index"]: Path(a["audio_path"]) for a in audio_segments}

    # ── ターゲットフォーマットを素材動画から取得 ──
    info = _get_video_info(paths["source"])
    tw, th, fps = info["width"], info["height"], info["fps"]
    print(f"  ターゲット解像度: {tw}x{th} @ {fps}fps")

    # ─ Step A: メインクリップのカット & 音声差し替え ─
    main_clips: List[Path] = []
    total = len(segments)
    print(f"  素材動画から {total} クリップをカット中...")

    for i, seg in enumerate(segments):
        raw = clips_dir / f"raw_{i:03d}.mp4"
        encoded = clips_dir / f"main_{i:03d}.mp4"

        if encoded.exists():
            print(f"    [{i+1}/{total}] キャッシュ使用")
            main_clips.append(encoded)
            continue

        # カット
        _cut(paths["source"], seg["source_start"], seg["source_end"], raw)

        # 音声差し替え
        if i in audio_map:
            voiced = clips_dir / f"voiced_{i:03d}.mp4"
            _replace_audio(raw, audio_map[i], voiced)
            _reencode(voiced, encoded, tw, th, fps, crf)
        else:
            _reencode(raw, encoded, tw, th, fps, crf)

        raw.unlink(missing_ok=True)
        dur = seg["source_end"] - seg["source_start"]
        print(f"    [{i+1}/{total}] {seg['source_start']:.1f}s～{seg['source_end']:.1f}s ({dur:.1f}s) 完了")
        main_clips.append(encoded)

    # ─ Step B: 複製回避クリップのカット ─
    avoid_clips: List[Path] = []
    avoid_sources = paths.get("avoid", [])

    if avoid_sources:
        print(f"  複製回避クリップをカット中...")
        for ai, avoid in enumerate(avoid_sources):
            for ci, clip_info in enumerate(avoid["clips"]):
                s = _to_seconds(clip_info["start"])
                e = _to_seconds(clip_info["end"])
                raw = clips_dir / f"avoid_raw_{ai}_{ci}.mp4"
                out = clips_dir / f"avoid_{ai}_{ci}.mp4"
                if out.exists():
                    avoid_clips.append(out)
                    continue
                _cut(avoid["path"], s, e, raw)
                _reencode(raw, out, tw, th, fps, crf)
                raw.unlink(missing_ok=True)
                avoid_clips.append(out)
                print(f"    avoid[{ai}][{ci}] {s:.1f}s～{e:.1f}s 完了")

    # ─ Step C: 挿入位置を決めて最終シーケンスを組む ─
    insert_idx = max(0, len(main_clips) - insert_before)
    final_sequence = (
        main_clips[:insert_idx]
        + avoid_clips
        + main_clips[insert_idx:]
    )

    print(f"  {len(final_sequence)} クリップを結合中...")
    output_path = output_dir / config["output"]["filename"]
    _concat(final_sequence, output_path)

    size_mb = output_path.stat().st_size / 1024 / 1024
    print(f"  ✅ 結合完了 ({size_mb:.1f} MB)")
    return output_path
