"""
Step 2: Whisper で両動画を文字起こしする（タイムスタンプ付き）
"""
import json
from pathlib import Path
from typing import Union
import whisper


def _extract_audio(video_path: Path, audio_path: Path) -> Path:
    """ffmpeg で音声だけ抽出（Whisper は音声のみ受け付ける）"""
    import subprocess
    subprocess.run(
        ["ffmpeg", "-y", "-i", str(video_path), "-vn", "-ar", "16000",
         "-ac", "1", "-f", "wav", str(audio_path)],
        capture_output=True,
        check=True,
    )
    return audio_path


def transcribe_one(
    video_path: Union[Path, str],
    model,
    label: str,
    cache_path: Path,
) -> dict:
    """1本の動画を文字起こしし、セグメントリストを返す"""
    if cache_path.exists():
        print(f"  {label}: キャッシュ使用")
        return json.loads(cache_path.read_text(encoding="utf-8"))

    print(f"  {label} を文字起こし中...")
    video_path = Path(video_path)
    audio_path = video_path.with_suffix(".wav")

    if not audio_path.exists():
        _extract_audio(video_path, audio_path)

    result = model.transcribe(
        str(audio_path),
        language="ja",
        word_timestamps=True,
        verbose=False,
        task="transcribe",
    )

    segments = [
        {
            "start": round(seg["start"], 3),
            "end": round(seg["end"], 3),
            "text": seg["text"].strip(),
        }
        for seg in result["segments"]
        if seg["text"].strip()
    ]

    data = {"segments": segments, "full_text": result["text"]}
    cache_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"    -> {len(segments)} セグメント")
    return data


def transcribe_videos(paths: dict, output_dir: Path, model_size: str = "medium") -> dict:
    """参考動画・素材動画の両方を文字起こし"""
    print(f"  Whisper モデル ({model_size}) を読み込み中... (初回は数分かかります)")
    model = whisper.load_model(model_size)

    transcripts = {}
    transcripts["reference"] = transcribe_one(
        paths["reference"],
        model,
        "参考動画",
        output_dir / "reference_transcript.json",
    )
    transcripts["source"] = transcribe_one(
        paths["source"],
        model,
        "素材動画",
        output_dir / "source_transcript.json",
    )

    print("  ✅ 文字起こし完了")
    return transcripts


def load_transcripts(output_dir: Path) -> dict:
    ref_path = output_dir / "reference_transcript.json"
    src_path = output_dir / "source_transcript.json"
    for p in [ref_path, src_path]:
        if not p.exists():
            raise FileNotFoundError(
                f"{p.name} が見つかりません。--skip-transcribe を外して再実行してください"
            )
    return {
        "reference": json.loads(ref_path.read_text(encoding="utf-8")),
        "source": json.loads(src_path.read_text(encoding="utf-8")),
    }
