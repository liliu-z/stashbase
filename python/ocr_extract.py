#!/usr/bin/env python
"""Image → OCR text note.

Invoked by `server/image.ts` after the user drops / pastes an image
into a folder. Runs RapidOCR (ONNX, bundled Chinese+English models, no
system binary like tesseract) over the image and writes a derived
AppData note. The image itself stays on disk as the user-facing file;
the derived note is indexed under the image source path so a
screenshot's text becomes searchable.

Unlike `pdf_extract.py` there is no image bundle. Empty OCR is a normal,
completed result: some images simply contain no readable text. The completion
marker prevents futile retries without claiming that searchable text exists.

Args: ``<image> <out_note>``.

Exits 0 on success, non-zero on failure with a diagnostic on stderr.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

OCR_COMPLETE_MARKER = "<!-- stashbase-ocr-conversion: complete -->"


def load_image(path: Path):
    """Decode the image to a BGR ndarray via Pillow so formats OpenCV
    can be flaky on (notably webp) decode reliably. Falls back to handing
    RapidOCR the raw path if Pillow / numpy aren't importable for some
    reason — RapidOCR can read common formats itself."""
    try:
        import numpy as np
        from PIL import Image

        with Image.open(path) as im:
            rgb = im.convert("RGB")
            arr = np.asarray(rgb)
        # RapidOCR is OpenCV-oriented (BGR); flip the channel order.
        return arr[:, :, ::-1]
    except Exception:
        return str(path)


def extract_text(image_path: Path) -> str:
    """Run RapidOCR and return the recognised text, one region per line,
    in reading order as RapidOCR emits it. Empty string when nothing is
    found."""
    try:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-not-found]
    except ModuleNotFoundError as err:
        if err.name == "rapidocr_onnxruntime":
            raise RuntimeError(
                "OCR dependency rapidocr_onnxruntime is missing. "
                "Run `pnpm setup:python` from the StashBase project, then restart the app."
            ) from err
        raise

    engine = RapidOCR()
    result, _elapse = engine(load_image(image_path))
    if not result:
        return ""
    # Each entry is [box, text, score]; keep the text in emit order.
    lines = [str(item[1]).strip() for item in result if len(item) >= 2 and item[1]]
    return "\n".join(line for line in lines if line).strip()


def main() -> int:
    parser = argparse.ArgumentParser(description="Image → OCR text note for StashBase.")
    parser.add_argument("image")
    parser.add_argument("out_path", help="Target note path (`.<stem>.md`).")
    args = parser.parse_args()

    image_path = Path(args.image).resolve()
    out_path = Path(args.out_path).resolve()
    if not image_path.is_file():
        print(f"[ocr_extract] not a file: {image_path}", file=sys.stderr)
        return 2

    try:
        text = extract_text(image_path)
    except Exception as err:
        print(f"[ocr_extract] OCR failed: {err}", file=sys.stderr)
        return 1

    content = f"{text}\n\n" if text else ""
    out_path.write_text(f"{content}{OCR_COMPLETE_MARKER}\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
