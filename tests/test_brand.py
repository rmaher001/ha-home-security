"""The integration's own icon (#3, Integration has no icon in HA and HACS). Home Assistant
2026.3 and later serve a custom integration's brand/ images in place of the brands
repository's: icon.png is 256 px square and icon@2x.png 512 px, both PNG with transparency."""

import struct
from pathlib import Path

BRAND = Path(__file__).parents[1] / "custom_components" / "home_security" / "brand"


def _png_size(path: Path) -> tuple[int, int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    width, height, _, colour = struct.unpack(">IIBB", data[16:26])
    return width, height, colour


def test_the_icon_is_there_in_both_sizes():
    for name, side in (("icon.png", 256), ("icon@2x.png", 512)):
        width, height, colour = _png_size(BRAND / name)
        assert (width, height) == (side, side), name
        assert colour == 6, f"{name} needs transparency (RGBA)"
