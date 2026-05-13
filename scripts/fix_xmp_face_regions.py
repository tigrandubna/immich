#!/usr/bin/env python3
"""
fix_xmp_face_regions.py
=======================

Repair MWG-Region coordinates in XMP sidecar files that were written with
wrong bounding boxes (typically by older versions of Mylio, Picasa, etc.).

Strategy
--------
For every XMP that contains an `mwg-rs:Regions` block:

  1. Find the matching photo on disk.
  2. POST it to immich's machine-learning service (`/predict`) and read back
     the face bboxes detected by the same model immich itself uses.
  3. Match every named XMP region to the closest ML face (greedy: nearest
     center; one ML face is consumed per XMP region).
  4. Replace the XMP region's area coordinates with the matched ML face's
     bbox, normalised against the image's pixel dimensions.
  5. Refuse to touch regions whose ML match is implausibly far away — those
     are kept as-is and reported. Same for XMPs whose JPG can't be found.

Original XMP is backed up to `<name>.xmp.bak` once per file before any
rewrite. Re-running the script over already-fixed files is a no-op.

Usage
-----
    python3 fix_xmp_face_regions.py [options] <path> [<path> ...]

`<path>` can be a directory (walked recursively) or an individual JPG/XMP.

Examples
--------
    # Fix everything under one library, talking to a local immich ML service
    python3 fix_xmp_face_regions.py /Volumes/Photos/2004

    # Dry-run: print what would change but don't write
    python3 fix_xmp_face_regions.py --dry-run /Volumes/Photos

    # Point at a remote machine running immich-machine-learning
    python3 fix_xmp_face_regions.py --ml-url http://nas.local:3003 /Volumes/Photos

    # Repair just a handful of files
    python3 fix_xmp_face_regions.py /Volumes/Photos/2004/Семья/IMG_4160.JPG \
                                     /Volumes/Photos/2004/Семья/IMG_4159.JPG

Dependencies
------------
Only the standard library plus `requests` (for the multipart upload). Install
with::

    pip install requests

The machine running this script must have HTTP access to a running
`immich-machine-learning` instance (port 3003 by default). Pointing it at
the same instance immich uses guarantees the detector is identical.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator

try:
    import requests
except ImportError:  # pragma: no cover
    sys.stderr.write("Missing dependency: pip install requests\n")
    sys.exit(2)


# -----------------------------------------------------------------------
# Configuration
# -----------------------------------------------------------------------

JPG_EXTS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".webp"}

# Same defaults as immich-server's facial-recognition config. Lower minScore
# than runtime so we don't miss faces the user already tagged.
DEFAULT_ML_URL = "http://localhost:3003"
DEFAULT_MODEL = "buffalo_l"
DEFAULT_MIN_SCORE = 0.4

# A matched ML face must be no farther than this fraction of the image
# diagonal from the original XMP region's center. Larger means more
# aggressive repair, smaller means safer.
DEFAULT_MAX_DISTANCE_RATIO = 0.35


# -----------------------------------------------------------------------
# Image dimensions
# -----------------------------------------------------------------------

def read_image_dimensions(path: Path) -> tuple[int, int] | None:
    """Return (width, height) of the displayed image, applying EXIF Orientation.
    Uses a minimal pure-Python JPEG/PNG/HEIC parser so we don't depend on PIL.
    Returns None on unrecognised formats.
    """
    try:
        with open(path, "rb") as f:
            head = f.read(32)
            f.seek(0)
            if head.startswith(b"\xff\xd8"):
                return _jpeg_dimensions(f)
            if head.startswith(b"\x89PNG\r\n\x1a\n"):
                f.seek(16)
                w, h = struct.unpack(">II", f.read(8))
                return w, h
    except OSError:
        pass
    return None


def _jpeg_dimensions(f) -> tuple[int, int] | None:
    """Parse JPEG to find SOF (start of frame) and Orientation tag."""
    f.seek(0)
    if f.read(2) != b"\xff\xd8":
        return None

    width = height = 0
    orientation = 1

    while True:
        marker = f.read(2)
        if len(marker) < 2 or marker[0] != 0xFF:
            break
        m = marker[1]
        if m == 0xD9 or m == 0xDA:  # EOI or SOS
            break
        size_bytes = f.read(2)
        if len(size_bytes) < 2:
            break
        size = struct.unpack(">H", size_bytes)[0]
        payload = f.read(size - 2) if size >= 2 else b""

        if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
            # SOF marker — width/height start at offset 1 (1B precision)
            if len(payload) >= 5:
                height = struct.unpack(">H", payload[1:3])[0]
                width = struct.unpack(">H", payload[3:5])[0]

        elif m == 0xE1 and payload.startswith(b"Exif\x00\x00"):
            orientation = _parse_exif_orientation(payload[6:]) or orientation

    if not width or not height:
        return None
    if orientation in (5, 6, 7, 8):
        return height, width
    return width, height


def _parse_exif_orientation(tiff: bytes) -> int | None:
    if len(tiff) < 8:
        return None
    if tiff[:2] == b"II":
        endian = "<"
    elif tiff[:2] == b"MM":
        endian = ">"
    else:
        return None
    try:
        offset = struct.unpack(f"{endian}I", tiff[4:8])[0]
        count = struct.unpack(f"{endian}H", tiff[offset:offset + 2])[0]
        for i in range(count):
            entry = tiff[offset + 2 + i * 12: offset + 2 + (i + 1) * 12]
            tag = struct.unpack(f"{endian}H", entry[0:2])[0]
            if tag == 0x0112:  # Orientation
                return struct.unpack(f"{endian}H", entry[8:10])[0]
    except (struct.error, IndexError):
        pass
    return None


# -----------------------------------------------------------------------
# XMP parsing — read regions
# -----------------------------------------------------------------------

@dataclass
class XmpRegion:
    name: str
    cx: float
    cy: float
    w: float
    h: float
    raw_match: re.Match  # span of the whole <rdf:li>...</rdf:li>

@dataclass
class ParsedXmp:
    text: str
    applied_w: int | None
    applied_h: int | None
    regions: list[XmpRegion]


_AREA_X_RE = re.compile(r"<stArea:x>([^<]+)</stArea:x>")
_AREA_Y_RE = re.compile(r"<stArea:y>([^<]+)</stArea:y>")
_AREA_W_RE = re.compile(r"<stArea:w>([^<]+)</stArea:w>")
_AREA_H_RE = re.compile(r"<stArea:h>([^<]+)</stArea:h>")
_NAME_RE = re.compile(r"<mwg-rs:Name>([^<]+)</mwg-rs:Name>")
_APPLIED_W_RE = re.compile(r"<stDim:w>([^<]+)</stDim:w>")
_APPLIED_H_RE = re.compile(r"<stDim:h>([^<]+)</stDim:h>")
_LI_RE = re.compile(r"<rdf:li[^>]*rdf:parseType=['\"]Resource['\"]\s*>.*?</rdf:li>", re.DOTALL)


def parse_xmp(text: str) -> ParsedXmp:
    aw_m = _APPLIED_W_RE.search(text)
    ah_m = _APPLIED_H_RE.search(text)
    applied_w = int(float(aw_m.group(1))) if aw_m else None
    applied_h = int(float(ah_m.group(1))) if ah_m else None

    regions: list[XmpRegion] = []
    for li in _LI_RE.finditer(text):
        block = li.group(0)
        x = _AREA_X_RE.search(block)
        y = _AREA_Y_RE.search(block)
        w = _AREA_W_RE.search(block)
        h = _AREA_H_RE.search(block)
        name = _NAME_RE.search(block)
        if not (x and y and w and h and name):
            continue
        regions.append(XmpRegion(
            name=name.group(1).strip(),
            cx=float(x.group(1)),
            cy=float(y.group(1)),
            w=float(w.group(1)),
            h=float(h.group(1)),
            raw_match=li,
        ))

    return ParsedXmp(text=text, applied_w=applied_w, applied_h=applied_h, regions=regions)


def rewrite_region_area(li_block: str, cx: float, cy: float, w: float, h: float) -> str:
    """Replace the stArea:x/y/w/h numbers inside a single <rdf:li> block."""
    def fmt(v: float) -> str:
        return f"{v:.6f}".rstrip("0").rstrip(".") or "0"

    new = li_block
    new = _AREA_X_RE.sub(f"<stArea:x>{fmt(cx)}</stArea:x>", new, count=1)
    new = _AREA_Y_RE.sub(f"<stArea:y>{fmt(cy)}</stArea:y>", new, count=1)
    new = _AREA_W_RE.sub(f"<stArea:w>{fmt(w)}</stArea:w>", new, count=1)
    new = _AREA_H_RE.sub(f"<stArea:h>{fmt(h)}</stArea:h>", new, count=1)
    return new


# -----------------------------------------------------------------------
# Finding XMP <-> JPG pairs
# -----------------------------------------------------------------------

def find_jpg_for_xmp(xmp_path: Path) -> Path | None:
    """Reverse the priority used by immich when locating sidecars."""
    name = xmp_path.name  # e.g. "IMG_4160.JPG.xmp" or "IMG_4160.xmp"
    parent = xmp_path.parent

    # Case A: <dir>/IMG_4160.JPG.xmp -> <dir>/IMG_4160.JPG (drop ".xmp")
    if name.lower().endswith(".xmp"):
        same = parent / name[:-4]
        if same.exists() and same.suffix.lower() in JPG_EXTS:
            return same

    # Case B: <dir>/IMG_4160.xmp -> any <dir>/IMG_4160.<ext>
    stem = xmp_path.stem  # strips ".xmp"
    for ext in JPG_EXTS:
        candidate = parent / f"{stem}{ext}"
        if candidate.exists():
            return candidate
        candidate = parent / f"{stem}{ext.upper()}"
        if candidate.exists():
            return candidate

    # Case C: XMP is in <dir>/.xmp/ subfolder — look in parent dir
    if parent.name == ".xmp":
        photo_dir = parent.parent
        if name.lower().endswith(".xmp"):
            stripped = name[:-4]
            same = photo_dir / stripped
            if same.exists():
                return same
        for ext in JPG_EXTS:
            for candidate_ext in (ext, ext.upper()):
                candidate = photo_dir / f"{stem}{candidate_ext}"
                if candidate.exists():
                    return candidate
    return None


def find_xmp_for_jpg(jpg_path: Path) -> Path | None:
    """Priority same as immich (`getSidecarCandidates`)."""
    parent = jpg_path.parent
    name = jpg_path.name
    stem = jpg_path.stem

    candidates = [
        parent / f"{name}.xmp",
        parent / f"{stem}.xmp",
        parent / ".xmp" / f"{name}.xmp",
        parent / ".xmp" / f"{stem}.xmp",
    ]
    for c in candidates:
        if c.exists():
            return c
    return None


def discover_jobs(paths: Iterable[Path]) -> Iterator[tuple[Path, Path]]:
    """Yield (jpg_path, xmp_path) pairs for every region-bearing XMP."""
    seen: set[Path] = set()

    def yield_pair(xmp: Path) -> Iterator[tuple[Path, Path]]:
        if xmp in seen:
            return
        seen.add(xmp)
        try:
            text = xmp.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        if "mwg-rs:Regions" not in text and "RegionList" not in text:
            return
        jpg = find_jpg_for_xmp(xmp)
        if jpg is None:
            sys.stderr.write(f"[skip] no JPG found for {xmp}\n")
            return
        yield (jpg, xmp)

    for p in paths:
        if p.is_file():
            if p.suffix.lower() == ".xmp":
                yield from yield_pair(p)
            elif p.suffix.lower() in JPG_EXTS:
                xmp = find_xmp_for_jpg(p)
                if xmp:
                    yield from yield_pair(xmp)
            continue

        if p.is_dir():
            for root, dirs, files in os.walk(p):
                root_path = Path(root)
                for fn in files:
                    if fn.lower().endswith(".xmp"):
                        yield from yield_pair(root_path / fn)


# -----------------------------------------------------------------------
# ML client
# -----------------------------------------------------------------------

class MLClient:
    def __init__(self, base_url: str, model: str, min_score: float):
        self.url = base_url.rstrip("/") + "/predict"
        self.entries = json.dumps({
            "facial-recognition": {
                "detection": {"modelName": model, "options": {"minScore": min_score}},
                "recognition": {"modelName": model},
            }
        })

    def detect_faces(self, image_path: Path) -> list[dict]:
        with open(image_path, "rb") as f:
            response = requests.post(
                self.url,
                data={"entries": self.entries},
                files={"image": (image_path.name, f, "application/octet-stream")},
                timeout=120,
            )
        response.raise_for_status()
        data = response.json()
        faces = data.get("facial-recognition") or []
        return [f for f in faces if "boundingBox" in f]


# -----------------------------------------------------------------------
# Matching
# -----------------------------------------------------------------------

@dataclass
class Match:
    region: XmpRegion
    ml_box: dict | None        # the matched ML face, in image pixels
    distance_ratio: float      # 0..~1.4, distance / image diagonal


def match_regions_to_faces(
    regions: list[XmpRegion],
    ml_faces: list[dict],
    image_w: int,
    image_h: int,
    max_ratio: float,
) -> list[Match]:
    """Globally-minimum greedy assignment, one ML face per XMP region.

    At each step we pick the (region, face) pair with the smallest
    center-distance among everything still unassigned. This handles cases
    where the XMP region order doesn't match the spatial order of detected
    faces. A region whose closest available ML face is farther than
    max_ratio of the image diagonal is reported as unmatched.
    """
    diag = (image_w ** 2 + image_h ** 2) ** 0.5 or 1.0

    # Pre-compute centers
    region_centers = [(r.cx * image_w, r.cy * image_h) for r in regions]
    face_centers: list[tuple[float, float, dict]] = []
    for f in ml_faces:
        bb = f["boundingBox"]
        face_centers.append(((bb["x1"] + bb["x2"]) / 2, (bb["y1"] + bb["y2"]) / 2, f))

    region_taken: dict[int, Match] = {}
    face_used: set[int] = set()

    # Build (distance, region_idx, face_idx) tuples sorted ascending.
    pairs: list[tuple[float, int, int]] = []
    for ri, (rx, ry) in enumerate(region_centers):
        for fi, (fx, fy, _f) in enumerate(face_centers):
            d = ((rx - fx) ** 2 + (ry - fy) ** 2) ** 0.5
            pairs.append((d, ri, fi))
    pairs.sort()

    for d, ri, fi in pairs:
        if ri in region_taken or fi in face_used:
            continue
        ratio = d / diag
        if ratio > max_ratio:
            continue
        region_taken[ri] = Match(region=regions[ri], ml_box=face_centers[fi][2], distance_ratio=ratio)
        face_used.add(fi)

    # Build output preserving original region order
    matches: list[Match] = []
    for ri, region in enumerate(regions):
        if ri in region_taken:
            matches.append(region_taken[ri])
        else:
            # Best available distance (for diagnostics) even if it's over the
            # threshold; report inf if there were no ML faces at all.
            best = float("inf")
            for d, rri, _fi in pairs:
                if rri == ri:
                    best = d / diag
                    break
            matches.append(Match(region=region, ml_box=None, distance_ratio=best))
    return matches


# -----------------------------------------------------------------------
# Driver
# -----------------------------------------------------------------------

def process_pair(
    jpg: Path,
    xmp: Path,
    ml: MLClient,
    max_ratio: float,
    dry_run: bool,
    verbose: bool,
) -> tuple[str, int, int, int]:
    """Return (status, n_matched, n_unmatched, n_total)."""
    text = xmp.read_text(encoding="utf-8", errors="replace")
    parsed = parse_xmp(text)
    if not parsed.regions:
        return ("no-regions", 0, 0, 0)

    dims = read_image_dimensions(jpg)
    if dims is None:
        sys.stderr.write(f"[warn] cannot read dims of {jpg}\n")
        return ("err-dims", 0, 0, len(parsed.regions))
    img_w, img_h = dims

    try:
        faces = ml.detect_faces(jpg)
    except requests.HTTPError as e:
        sys.stderr.write(f"[warn] ML service rejected {jpg}: {e}\n")
        return ("err-ml", 0, 0, len(parsed.regions))
    except requests.RequestException as e:
        sys.stderr.write(f"[warn] ML service unreachable for {jpg}: {e}\n")
        return ("err-ml", 0, 0, len(parsed.regions))

    matches = match_regions_to_faces(parsed.regions, faces, img_w, img_h, max_ratio)

    new_text = parsed.text
    n_changed = 0
    n_matched = 0
    n_unmatched = 0
    for m in matches:
        if m.ml_box is None:
            n_unmatched += 1
            if verbose:
                print(f"  - {m.region.name}: no ML face within {max_ratio:.0%} (best ratio {m.distance_ratio:.2f})")
            continue
        n_matched += 1
        bb = m.ml_box["boundingBox"]
        cx_px = (bb["x1"] + bb["x2"]) / 2
        cy_px = (bb["y1"] + bb["y2"]) / 2
        w_px = bb["x2"] - bb["x1"]
        h_px = bb["y2"] - bb["y1"]
        new_cx = cx_px / img_w
        new_cy = cy_px / img_h
        new_w = w_px / img_w
        new_h = h_px / img_h

        # Skip if the region is already at the right position (within 0.5%).
        if (abs(new_cx - m.region.cx) < 0.005
                and abs(new_cy - m.region.cy) < 0.005
                and abs(new_w - m.region.w) < 0.01
                and abs(new_h - m.region.h) < 0.01):
            continue

        old_block = m.region.raw_match.group(0)
        new_block = rewrite_region_area(old_block, new_cx, new_cy, new_w, new_h)
        if new_block == old_block:
            continue
        # Replace the first occurrence of old_block in new_text. We use .replace
        # (single replacement) because the same name shouldn't appear twice
        # with byte-identical region payloads.
        replaced = new_text.replace(old_block, new_block, 1)
        if replaced == new_text:
            sys.stderr.write(f"[bug] could not splice region for {m.region.name} in {xmp}\n")
            continue
        new_text = replaced
        n_changed += 1
        if verbose:
            print(f"  ✓ {m.region.name}: ({m.region.cx:.3f},{m.region.cy:.3f}) -> ({new_cx:.3f},{new_cy:.3f})")

    if n_changed == 0:
        return ("no-change", n_matched, n_unmatched, len(parsed.regions))

    if dry_run:
        return ("would-fix", n_matched, n_unmatched, len(parsed.regions))

    # Backup once
    backup = xmp.with_suffix(xmp.suffix + ".bak")
    if not backup.exists():
        shutil.copy2(xmp, backup)
    xmp.write_text(new_text, encoding="utf-8")
    return ("fixed", n_matched, n_unmatched, len(parsed.regions))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Repair MWG-Region coordinates in XMP sidecars using immich's ML service.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("paths", nargs="+", type=Path, help="Directory or file(s) to scan.")
    p.add_argument("--ml-url", default=DEFAULT_ML_URL, help=f"Base URL of immich-machine-learning (default {DEFAULT_ML_URL}).")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Detection model name (default {DEFAULT_MODEL}).")
    p.add_argument("--min-score", type=float, default=DEFAULT_MIN_SCORE, help=f"ML detection min score (default {DEFAULT_MIN_SCORE}).")
    p.add_argument("--max-distance", type=float, default=DEFAULT_MAX_DISTANCE_RATIO,
                   help=f"Max region-to-ML-face center distance as fraction of image diagonal (default {DEFAULT_MAX_DISTANCE_RATIO}).")
    p.add_argument("--dry-run", action="store_true", help="Show what would change but don't write.")
    p.add_argument("-v", "--verbose", action="store_true", help="Per-region log output.")
    args = p.parse_args(argv)

    ml = MLClient(args.ml_url, args.model, args.min_score)

    summary = {"fixed": 0, "would-fix": 0, "no-change": 0, "no-regions": 0, "err-dims": 0, "err-ml": 0}
    matched_total = 0
    unmatched_total = 0
    files_total = 0

    for jpg, xmp in discover_jobs(args.paths):
        files_total += 1
        print(f"[{files_total}] {xmp}")
        status, m, u, _t = process_pair(jpg, xmp, ml, args.max_distance, args.dry_run, args.verbose)
        summary[status] = summary.get(status, 0) + 1
        matched_total += m
        unmatched_total += u

    print()
    print(f"--- summary ---")
    print(f"files scanned   : {files_total}")
    print(f"regions matched : {matched_total}")
    print(f"regions unmatched: {unmatched_total}")
    for k, v in summary.items():
        print(f"{k:16s}: {v}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
