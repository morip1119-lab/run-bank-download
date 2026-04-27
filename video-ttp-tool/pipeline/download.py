"""
Step 1: YouTube動画をダウンロードする
"""
import json
from pathlib import Path
import yt_dlp


def _find_downloaded_file(stem: Path) -> Path:
    """ダウンロードされた実際のファイルを探す（.part は除外）"""
    for ext in ["mp4", "mkv", "webm", "mov"]:
        candidate = stem.parent / f"{stem.name}.{ext}"
        if candidate.exists():
            return candidate
    # glob fallback（.part / .ytdl などの一時ファイルは除外）
    matches = [
        m for m in stem.parent.glob(f"{stem.name}.*")
        if m.suffix not in {".part", ".ytdl", ".tmp"}
    ]
    if matches:
        return matches[0]
    return stem.with_suffix(".mp4")


def download_video(url: str, output_stem: Path, label: str) -> Path:
    """1本の動画をダウンロードして保存済みパスを返す"""
    # キャッシュ確認
    existing = _find_downloaded_file(output_stem)
    if existing.exists():
        print(f"  {label}: キャッシュ使用 ({existing.name})")
        return existing

    print(f"  {label} をダウンロード中...")
    ydl_opts = {
        "outtmpl": str(output_stem) + ".%(ext)s",
        "format": "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best",
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([url])

    result = _find_downloaded_file(output_stem)
    print(f"    -> {result.name}")
    return result


def download_videos(config: dict, output_dir: Path) -> dict:
    """設定ファイルに記載された全動画をダウンロード"""
    paths = {}

    paths["reference"] = download_video(
        config["reference_video"],
        output_dir / "reference",
        "参考動画",
    )
    paths["source"] = download_video(
        config["source_video"],
        output_dir / "source",
        "素材動画",
    )

    paths["avoid"] = []
    for i, avoid_cfg in enumerate(config.get("avoid_clips", [])):
        dl_path = download_video(
            avoid_cfg["url"],
            output_dir / f"avoid_{i}",
            f"複製回避素材{i + 1}",
        )
        paths["avoid"].append({"path": dl_path, "clips": avoid_cfg["clips"]})

    # JSON に保存（後のステップで --skip-download した場合に参照）
    serializable = {
        "reference": str(paths["reference"]),
        "source": str(paths["source"]),
        "avoid": [
            {"path": str(a["path"]), "clips": a["clips"]}
            for a in paths["avoid"]
        ],
    }
    (output_dir / "paths.json").write_text(
        json.dumps(serializable, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    print("  ✅ ダウンロード完了")
    return paths


def load_paths(output_dir: Path) -> dict:
    """保存済み paths.json からパスを復元する"""
    paths_file = output_dir / "paths.json"
    if not paths_file.exists():
        raise FileNotFoundError(
            "paths.json が見つかりません。--skip-download を外して再実行してください"
        )
    data = json.loads(paths_file.read_text(encoding="utf-8"))
    return {
        "reference": Path(data["reference"]),
        "source": Path(data["source"]),
        "avoid": [
            {"path": Path(a["path"]), "clips": a["clips"]}
            for a in data["avoid"]
        ],
    }
