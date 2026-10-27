"""Runs the cards' JavaScript tests (tests/js) with Node's built-in test runner."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

JS_TESTS = Path(__file__).parent / "js"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node isn't installed")
def test_cards_js() -> None:
    result = subprocess.run(
        ["node", "--test", str(JS_TESTS / "cards.test.mjs")],
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
