from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import ocr_extract


class OcrExtractTest(unittest.TestCase):
    def test_empty_ocr_is_a_successful_textless_result(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "blank.png"
            output = root / "blank.md"
            source.write_bytes(b"image fixture")

            with (
                mock.patch.object(ocr_extract, "extract_text", return_value=""),
                mock.patch.object(sys, "argv", ["ocr_extract.py", str(source), str(output)]),
            ):
                result = ocr_extract.main()

            self.assertEqual(result, 0)
            self.assertEqual(
                output.read_text(encoding="utf-8"),
                f"{ocr_extract.OCR_COMPLETE_MARKER}\n",
            )


if __name__ == "__main__":
    unittest.main()
