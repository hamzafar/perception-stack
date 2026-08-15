from pathlib import Path
from PIL import Image

SOURCE_ROOT = Path("data")
OUTPUT_ROOT = Path("data_400x300")

CAMERAS = [
    "front",
    "rear",
    "left",
    "right",
]

TARGET_WIDTH = 400
TARGET_HEIGHT = 300

JPEG_QUALITY = 85


total_images = 0
total_original_bytes = 0
total_new_bytes = 0

print("=" * 60)
print("Camera image resize")
print("=" * 60)

for camera in CAMERAS:

    source_dir = SOURCE_ROOT / camera
    output_dir = OUTPUT_ROOT / camera

    if not source_dir.exists():
        print(f"[WARNING] Missing directory: {source_dir}")
        continue

    output_dir.mkdir(
        parents=True,
        exist_ok=True
    )

    images = sorted(
        source_dir.glob("*.jpg")
    )

    print(f"\n[{camera}] {len(images)} images")

    for source_path in images:

        output_path = (
            output_dir /
            source_path.name
        )

        original_size = source_path.stat().st_size

        try:

            with Image.open(source_path) as img:

                img = img.convert("RGB")

                resized = img.resize(
                    (
                        TARGET_WIDTH,
                        TARGET_HEIGHT
                    ),
                    Image.Resampling.LANCZOS
                )

                resized.save(
                    output_path,
                    "JPEG",
                    quality=JPEG_QUALITY,
                    optimize=True
                )

            new_size = output_path.stat().st_size

            total_images += 1
            total_original_bytes += original_size
            total_new_bytes += new_size

        except Exception as e:

            print(
                f"[ERROR] {source_path}: {e}"
            )


def mb(value):
    return value / (1024 * 1024)


print("\n" + "=" * 60)
print("COMPLETE")
print("=" * 60)

print(
    f"Images processed: {total_images}"
)

print(
    f"Original size:     {mb(total_original_bytes):.2f} MB"
)

print(
    f"New size:          {mb(total_new_bytes):.2f} MB"
)

if total_original_bytes > 0:

    reduction = 100 * (
        1 -
        total_new_bytes /
        total_original_bytes
    )

    print(
        f"Size reduction:    {reduction:.1f}%"
    )

print(
    f"Output directory:  {OUTPUT_ROOT}"
)

print("=" * 60)