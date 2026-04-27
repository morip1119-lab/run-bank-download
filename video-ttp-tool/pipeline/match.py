"""
Step 3: 参考動画と素材動画のセグメントを意味的に照合する

【アルゴリズム概要】
1. 両動画のセグメントをコンテキストウィンドウで拡張（前後N文を結合）
2. OpenAI Embeddings でベクトル化
3. コサイン類似度でマトリクスを計算
4. 閾値以上の組み合わせをマッチ候補として抽出
5. 参考動画の順序を維持しながら近接クリップを統合
6. 重複・短すぎるクリップを除去
"""
import json
import os
from pathlib import Path
from typing import List, Dict

import numpy as np
from openai import OpenAI


# ─── ベクトル計算 ──────────────────────────────────────────────

def _cosine_sim(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """(N, D) × (M, D) -> (N, M) コサイン類似度行列"""
    eps = 1e-8
    a_n = a / (np.linalg.norm(a, axis=1, keepdims=True) + eps)
    b_n = b / (np.linalg.norm(b, axis=1, keepdims=True) + eps)
    return a_n @ b_n.T


def _get_embeddings(texts: List[str], client: OpenAI, model: str) -> np.ndarray:
    """バッチで埋め込みベクトルを取得"""
    batch_size = 100
    all_embs = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i : i + batch_size]
        resp = client.embeddings.create(input=batch, model=model)
        all_embs.append(np.array([e.embedding for e in resp.data]))
    return np.vstack(all_embs)


# ─── コンテキストウィンドウ ────────────────────────────────────

def _build_context_texts(segments: List[Dict], window: int = 2) -> List[str]:
    """
    各セグメントの前後 window 文を結合して文脈付きテキストを作る。
    単文マッチより精度が上がる。
    """
    texts = []
    for i, seg in enumerate(segments):
        lo = max(0, i - window)
        hi = min(len(segments), i + window + 1)
        ctx = " ".join(s["text"] for s in segments[lo:hi]).strip()
        texts.append(ctx)
    return texts


# ─── マッチング後処理 ──────────────────────────────────────────

def _merge_clips(clips: List[Dict], ref_gap: float, src_gap: float, min_dur: float) -> List[Dict]:
    """
    参考動画・素材動画の両方で近接しているクリップを統合する。
    ref_gap:  参考動画側で連続とみなす最大間隔（秒）
    src_gap:  素材動画側で連続とみなす最大間隔（秒）
    min_dur:  統合後もこの秒数未満なら除外
    """
    if not clips:
        return []

    # 参考動画の順序でソート
    clips = sorted(clips, key=lambda x: x["ref_start"])
    merged = [clips[0].copy()]

    for c in clips[1:]:
        last = merged[-1]
        r_gap = c["ref_start"] - last["ref_end"]
        s_gap = c["source_start"] - last["source_end"]

        if r_gap <= ref_gap and s_gap <= src_gap:
            last["ref_end"] = max(last["ref_end"], c["ref_end"])
            last["source_end"] = max(last["source_end"], c["source_end"])
            last["score"] = max(last["score"], c["score"])
            last["ref_text"] = last["ref_text"] + " " + c["ref_text"]
            last["source_text"] = last["source_text"] + " " + c["source_text"]
        else:
            merged.append(c.copy())

    return [c for c in merged if (c["source_end"] - c["source_start"]) >= min_dur]


def _deduplicate_source(clips: List[Dict]) -> List[Dict]:
    """
    素材動画の同じ箇所が複数回ヒットした場合、スコアが高い方を残す。
    （重複区間が 50% 以上重なっていたら重複とみなす）
    """
    kept = []
    for c in sorted(clips, key=lambda x: -x["score"]):
        overlap = False
        for k in kept:
            lo = max(c["source_start"], k["source_start"])
            hi = min(c["source_end"], k["source_end"])
            if hi > lo:
                c_dur = c["source_end"] - c["source_start"]
                if (hi - lo) / max(c_dur, 0.001) > 0.5:
                    overlap = True
                    break
        if not overlap:
            kept.append(c)

    return sorted(kept, key=lambda x: x["ref_start"])


# ─── メイン ───────────────────────────────────────────────────

def find_matching_segments(
    transcripts: dict,
    config: dict,
    output_dir: Path,
) -> List[Dict]:
    """参考動画と素材動画で意味的に対応するセグメントを探す"""

    match_cfg = config.get("matching", {})
    threshold = match_cfg.get("similarity_threshold", 0.75)
    merge_gap = match_cfg.get("merge_gap_seconds", 3.0)
    min_dur = match_cfg.get("min_clip_duration", 2.0)
    ctx_window = match_cfg.get("context_window", 2)
    embed_model = config.get("openai", {}).get(
        "embedding_model", "text-embedding-3-small"
    )

    api_key = os.environ.get(
        config.get("openai", {}).get("api_key_env", "OPENAI_API_KEY")
    )
    if not api_key:
        raise EnvironmentError(
            "環境変数 OPENAI_API_KEY が設定されていません。"
            ".env ファイルか環境変数にセットしてください。"
        )

    client = OpenAI(api_key=api_key)

    ref_segs = [s for s in transcripts["reference"]["segments"] if s["text"].strip()]
    src_segs = [s for s in transcripts["source"]["segments"] if s["text"].strip()]

    print(f"  参考動画: {len(ref_segs)} セグメント")
    print(f"  素材動画: {len(src_segs)} セグメント")
    print("  埋め込みベクトルを計算中（OpenAI API）...")

    ref_ctx = _build_context_texts(ref_segs, ctx_window)
    src_ctx = _build_context_texts(src_segs, ctx_window)

    ref_embs = _get_embeddings(ref_ctx, client, embed_model)
    src_embs = _get_embeddings(src_ctx, client, embed_model)

    sim = _cosine_sim(ref_embs, src_embs)  # (ref_n, src_n)

    # 各参考セグメントに対して最も類似した素材セグメントを選ぶ
    raw_matches = []
    for i, ref_seg in enumerate(ref_segs):
        best_j = int(np.argmax(sim[i]))
        best_score = float(sim[i, best_j])
        if best_score < threshold:
            continue
        src_seg = src_segs[best_j]
        raw_matches.append(
            {
                "ref_start": ref_seg["start"],
                "ref_end": ref_seg["end"],
                "ref_text": ref_seg["text"],
                "source_start": src_seg["start"],
                "source_end": src_seg["end"],
                "source_text": src_seg["text"],
                "score": best_score,
            }
        )

    print(f"  マッチ候補: {len(raw_matches)} 件 (閾値={threshold})")

    # 重複除去 → 近接統合 → 短すぎるクリップ除去
    deduped = _deduplicate_source(raw_matches)
    merged = _merge_clips(deduped, merge_gap, merge_gap, min_dur)

    # 結果を保存
    result_path = output_dir / "match_result.json"
    result_path.write_text(
        json.dumps(merged, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 結果レポート表示
    print(f"\n  【マッチング結果】合計 {len(merged)} クリップ")
    print(f"  {'#':>3}  {'素材 開始':>9}  {'終了':>7}  {'尺':>6}  {'スコア':>6}  テキスト")
    print("  " + "─" * 72)
    for i, c in enumerate(merged):
        dur = c["source_end"] - c["source_start"]
        txt = c.get("source_text", "")[:35]
        print(
            f"  {i+1:>3}  {c['source_start']:>9.1f}s  {c['source_end']:>6.1f}s"
            f"  {dur:>5.1f}s  {c['score']:>6.2f}  {txt}"
        )

    print("\n  ✅ マッチング完了")
    return merged


def load_segments(output_dir: Path) -> List[Dict]:
    """保存済み match_result.json を読み込む"""
    f = output_dir / "match_result.json"
    if not f.exists():
        raise FileNotFoundError(
            "match_result.json が見つかりません。--skip-match を外して再実行してください"
        )
    return json.loads(f.read_text(encoding="utf-8"))
