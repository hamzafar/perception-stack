from pathlib import Path
from PIL import Image


ROOT = Path("data_400x300")

CAMERAS = [
    "rear",
    "left",
    "right",
]

TARGET_WIDTH = 200
TARGET_HEIGHT = 150

JPEG_QUALITY = 85


total_images = 0
total_original_bytes = 0
total_new_bytes = 0


print("=" * 60)
print("Resize LEFT / REAR / RIGHT camera images")
print("=" * 60)

for camera in CAMERAS:

    camera_dir = ROOT / camera

    if not camera_dir.exists():
        print(
            f"[WARNING] Missing directory: "
            f"{camera_dir}"
        )
        continue

    images = sorted(
        camera_dir.glob("*.jpg")
    )

    print(
        f"\n[{camera}] "
        f"{len(images)} images"
    )

    success = 0

    for image_path in images:

        original_size_bytes = (
            image_path.stat().st_size
        )

        try:

            # -------------------------------------------------
            # Read image
            # -------------------------------------------------

            with Image.open(image_path) as img:

                original_dimensions = img.size

                img = img.convert("RGB")

                resized = img.resize(
                    (
                        TARGET_WIDTH,
                        TARGET_HEIGHT
                    ),
                    Image.Resampling.LANCZOS
                )

                # -------------------------------------------------
                # Save to temporary file
                # -------------------------------------------------
                # This prevents corruption if something goes
                # wrong while replacing the original.
                # -------------------------------------------------

                temp_path = (
                    image_path.parent /
                    (
                        image_path.stem +
                        "_tmp.jpg"
                    )
                )

                resized.save(
                    temp_path,
                    "JPEG",
                    quality=JPEG_QUALITY,
                    optimize=True
                )

            # -------------------------------------------------
            # Verify temporary image before replacement
            # -------------------------------------------------

            with Image.open(temp_path) as check:

                new_dimensions = check.size

                if new_dimensions != (
                    TARGET_WIDTH,
                    TARGET_HEIGHT
                ):

                    raise RuntimeError(
                        f"Verification failed: "
                        f"{new_dimensions}"
                    )

            # -------------------------------------------------
            # Replace original
            # -------------------------------------------------

            temp_path.replace(
                image_path
            )

            # -------------------------------------------------
            # Verify replaced image
            # -------------------------------------------------

            with Image.open(image_path) as check:

                final_dimensions = check.size

            if final_dimensions != (
                TARGET_WIDTH,
                TARGET_HEIGHT
            ):

                raise RuntimeError(
                    f"Final verification failed: "
                    f"{final_dimensions}"
                )

            new_size_bytes = (
                image_path.stat().st_size
            )

            total_images += 1

            total_original_bytes += (
                original_size_bytes
            )

            total_new_bytes += (
                new_size_bytes
            )

            success += 1

        except Exception as e:

            print(
                f"[ERROR] "
                f"{image_path.name}: {e}"
            )

    print(
        f"Verified: {success}/{len(images)}"
    )


def mb(value):

    return value / (
        1024 * 1024
    )


print("\n" + "=" * 60)
print("COMPLETE")
print("=" * 60)

print(
    f"Images processed: {total_images}"
)

print(
    f"Original size:     "
    f"{mb(total_original_bytes):.2f} MB"
)

print(
    f"New size:          "
    f"{mb(total_new_bytes):.2f} MB"
)

if total_original_bytes > 0:

    reduction = 100 * (
        1 -
        total_new_bytes /
        total_original_bytes
    )

    print(
        f"Size reduction:    "
        f"{reduction:.1f}%"
    )

print(
    f"Output directory:  "
    f"{ROOT}"
)

print(
    f"Target dimensions:  "
    f"{TARGET_WIDTH}x{TARGET_HEIGHT}"
)

print("=" * 60)