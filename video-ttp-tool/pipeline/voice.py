"""
Step 4: VOICEVOX で波音リツのナレーション音声を合成する

VOICEVOX エンジンをローカルで起動しておく必要があります。
  起動方法: VOICEVOX アプリを開くか、
            docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-ubuntu20.04-latest
  波音リツ speaker_id = 9 (ノーマル)
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import List, Dict

import requests


VOICEVOX_DEFAULT_HOST = "http://localhost:50021"
RITSU_SPEAKER_ID = 9  # 波音リツ ノーマル


def _check_voicevox(host: str) -> bool:
    """VOICEVOX エンジンが起動しているか確認"""
    try:
        r = requests.get(f"{host}/version", timeout=5)
        print(f"  VOICEVOX v{r.json()} に接続成功")
        return True
    except Exception:
        return False


def _split_text(text: str, max_chars: int = 100) -> List[str]:
    """長いテキストを句点・読点で分割する（VOICEVOX は長文が苦手）"""
    # 句点・感嘆符・疑問符で分割
    parts = re.split(r"(?<=[。！？\.\!\?])", text)
    chunks, buf = [], ""
    for p in parts:
        if len(buf) + len(p) <= max_chars:
            buf += p
        else:
            if buf:
                chunks.append(buf.strip())
            buf = p
    if buf.strip():
        chunks.append(buf.strip())
    return chunks or [text]


def _synthesize_chunk(text: str, speaker_id: int, host: str, speed: float) -> bytes:
    """1チャンクを VOICEVOX で音声合成して WAV バイト列を返す"""
    params = {"text": text, "speaker": speaker_id}
    q_res = requests.post(f"{host}/audio_query", params=params, timeout=30)
    q_res.raise_for_status()
    query = q_res.json()
    query["speedScale"] = speed

    s_res = requests.post(
        f"{host}/synthesis",
        params={"speaker": speaker_id},
        json=query,
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    s_res.raise_for_status()
    return s_res.content


def _merge_wav_chunks(chunks: List[bytes], output_path: Path) -> Path:
    """複数の WAV バイト列を ffmpeg で結合して 1 ファイルにまとめる"""
    import subprocess, tempfile, os

    tmp_dir = output_path.parent / "_wav_tmp"
    tmp_dir.mkdir(exist_ok=True)
    tmp_paths = []
    for i, wav in enumerate(chunks):
        p = tmp_dir / f"chunk_{i:04d}.wav"
        p.write_bytes(wav)
        tmp_paths.append(p)

    list_file = tmp_dir / "list.txt"
    list_file.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in tmp_paths), encoding="utf-8"
    )

    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0",
         "-i", str(list_file), str(output_path)],
        capture_output=True, check=True,
    )

    # 一時ファイルを削除
    for p in tmp_paths:
        p.unlink(missing_ok=True)
    list_file.unlink(missing_ok=True)
    try:
        tmp_dir.rmdir()
    except Exception:
        pass

    return output_path


def synthesize_narration(
    reference_transcript: dict,
    segments: List[Dict],
    config: dict,
    output_dir: Path,
) -> List[Dict]:
    """マッチした各クリップに対応する参考動画のナレーションを音声合成"""

    vox_cfg = config.get("voicevox", {})
    if not vox_cfg.get("enabled", True):
        print("  VOICEVOX 無効設定 → 音声合成スキップ")
        return []

    host = vox_cfg.get("host", VOICEVOX_DEFAULT_HOST)
    speaker_id = vox_cfg.get("speaker_id", RITSU_SPEAKER_ID)
    speed = vox_cfg.get("speed", 1.0)

    if not _check_voicevox(host):
        print(f"  ⚠️  VOICEVOX が {host} で起動していません")
        print("     → VOICEVOXアプリを起動するか Docker で起動してください:")
        print("       docker run --rm -p 50021:50021 voicevox/voicevox_engine:cpu-ubuntu20.04-latest")
        print("     音声合成をスキップし、素材動画の元の音声を使用します。")
        return []

    audio_dir = output_dir / "audio"
    audio_dir.mkdir(exist_ok=True)

    ref_segs = reference_transcript["segments"]
    audio_results: List[Dict] = []

    for i, clip in enumerate(segments):
        out_path = audio_dir / f"narration_{i:03d}.wav"
        if out_path.exists():
            print(f"  [{i+1}/{len(segments)}] キャッシュ使用")
            audio_results.append({"clip_index": i, "audio_path": str(out_path)})
            continue

        # 参考動画のこのクリップに対応するテキストを収集
        texts = [
            s["text"]
            for s in ref_segs
            if s["start"] >= clip["ref_start"] - 0.5
            and s["end"] <= clip["ref_end"] + 1.0
        ]
        text = " ".join(texts).strip() or clip.get("ref_text", "")
        if not text:
            continue

        short_text = text[:40].replace("\n", " ")
        print(f"  [{i+1}/{len(segments)}] {short_text}...")

        try:
            chunks_text = _split_text(text)
            wav_chunks = [
                _synthesize_chunk(c, speaker_id, host, speed)
                for c in chunks_text
                if c.strip()
            ]
            if len(wav_chunks) == 1:
                out_path.write_bytes(wav_chunks[0])
            else:
                _merge_wav_chunks(wav_chunks, out_path)

            audio_results.append({"clip_index": i, "audio_path": str(out_path)})

        except Exception as e:
            print(f"  ⚠️  [{i+1}] 音声合成エラー: {e} → このクリップは元の音声を使用")

    print(f"  ✅ 音声合成完了 ({len(audio_results)} / {len(segments)} 件)")
    return audio_results
