#!/usr/bin/env python
"""
Download and export the cafe_aesthetic BEiT classifier as ONNX, then drop the
single ``model.onnx`` file into the immich-style cache layout where
``CafeAestheticScorer`` expects it:

    /cache/aesthetic/cafe-aesthetic/scorer/model.onnx

Run this **inside the immich_machine_learning container** so the export uses
the same Python / onnxruntime versions that will load the model later. From
the host:

    docker exec -it immich_machine_learning \\
        uv run --with optimum --with onnxruntime --with transformers \\
        python /usr/src/immich_ml/../scripts/fetch_aesthetic_model.py

(optimum / transformers / onnxruntime aren't in immich_ml's main dependency
set — uv installs them just for this command and discards them after.)
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
from pathlib import Path

HF_REPO = "cafeai/cafe_aesthetic"
DEFAULT_CACHE_ROOT = Path(os.environ.get("MACHINE_LEARNING_CACHE_FOLDER", "/cache"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=DEFAULT_CACHE_ROOT,
        help=f"Root of the immich ML cache (default: {DEFAULT_CACHE_ROOT})",
    )
    parser.add_argument(
        "--model-name",
        default="cafe-aesthetic",
        help="Logical name used inside the cache path (default: cafe-aesthetic)",
    )
    parser.add_argument(
        "--hf-repo",
        default=HF_REPO,
        help=f"HuggingFace repo to export from (default: {HF_REPO})",
    )
    args = parser.parse_args()

    try:
        from optimum.onnxruntime import ORTModelForImageClassification  # noqa: F401
    except ImportError:
        print(
            "optimum + onnxruntime + transformers are required. Re-run with:\n"
            "  uv run --with optimum --with onnxruntime --with transformers "
            "python scripts/fetch_aesthetic_model.py",
            file=sys.stderr,
        )
        return 1

    target_dir = args.cache_root / "aesthetic" / args.model_name / "scorer"
    target_path = target_dir / "model.onnx"
    if target_path.exists():
        print(f"Model already present at {target_path}, leaving it alone.")
        return 0

    target_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        print(f"Exporting {args.hf_repo} → {tmp}/ ...")
        from optimum.onnxruntime import ORTModelForImageClassification

        model = ORTModelForImageClassification.from_pretrained(args.hf_repo, export=True)
        model.save_pretrained(tmp)

        produced = tmp / "model.onnx"
        if not produced.exists():
            print(
                f"Expected {produced} after export but it's missing. "
                f"Files actually produced: {sorted(p.name for p in tmp.iterdir())}",
                file=sys.stderr,
            )
            return 1

        print(f"Moving {produced} → {target_path}")
        shutil.move(str(produced), str(target_path))

    print("Done. The auto-trip job will pick up the model on next run.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
