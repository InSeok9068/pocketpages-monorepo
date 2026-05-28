from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image


MAX_NARROW_WIDTH = 320
MIN_SPLIT_HEIGHT = 1600
MIN_SPLIT_RATIO = 4.2
TARGET_SLICE_WIDTH = 864
SLICE_OVERLAP_RATIO = 0.12


def should_split(width: int, height: int) -> bool:
    return width <= MAX_NARROW_WIDTH and height >= MIN_SPLIT_HEIGHT and (height / width) >= MIN_SPLIT_RATIO


def resolve_slice_count(height: int) -> int:
    if height >= 2200:
        return 4
    return 3


def build_slice_bounds(height: int, slice_count: int) -> list[tuple[int, int]]:
    bounds: list[tuple[int, int]] = []
    base_slice_height = -(-height // slice_count)
    overlap_height = round(base_slice_height * SLICE_OVERLAP_RATIO)

    for index in range(slice_count):
        top = max(0, index * base_slice_height - overlap_height)
        bottom = min(height, (index + 1) * base_slice_height + (0 if index == slice_count - 1 else overlap_height))
        bounds.append((top, bottom))

    return bounds


def build_source_token(source_index_text: str) -> str:
    source_index = int(source_index_text)
    return f"ppsrc_{source_index:02d}"


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: split_tall_capture.py <input> <output_dir> [source_index]", file=sys.stderr)
        return 1

    input_path = Path(sys.argv[1])
    output_dir = Path(sys.argv[2])
    output_dir.mkdir(parents=True, exist_ok=True)
    source_token = build_source_token(sys.argv[3]) if len(sys.argv) == 4 else "ppsrc_01"

    image = Image.open(input_path)
    width, height = image.size

    if not should_split(width, height):
        output_path = output_dir / input_path.name
        image.save(output_path)
        print(output_path)
        return 0

    slice_count = resolve_slice_count(height)
    base_name = input_path.stem

    for index, (top, bottom) in enumerate(build_slice_bounds(height, slice_count), start=1):
        cropped = image.crop((0, top, width, bottom))
        target_height = max(1, round((cropped.size[1] * TARGET_SLICE_WIDTH) / width))
        resized = cropped.resize((TARGET_SLICE_WIDTH, target_height), Image.Resampling.LANCZOS)
        output_path = output_dir / f"{base_name}__{source_token}__ppslice_{index:02d}of{slice_count:02d}.jpg"
        resized.save(output_path, quality=94)
        print(output_path)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
