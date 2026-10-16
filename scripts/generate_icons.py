#!/usr/bin/env python3
"""SVG を正本として、ホーム画面・ブラウザー用 PNG を再生成する。"""
from pathlib import Path
import shutil
import subprocess


def main() -> None:
    magick = shutil.which("magick")
    if not magick:
        raise SystemExit("ImageMagick の magick コマンドが必要です。")
    icon_dir = Path(__file__).resolve().parent.parent / "icons"
    source = icon_dir / "app-icon.svg"
    for name, size in (
        ("apple-touch-icon.png", 180),
        ("icon-192.png", 192),
        ("icon-512.png", 512),
        ("favicon.png", 48),
    ):
        subprocess.run(
            [
                magick, "-background", "#0f0f1a", "-density", "384",
                str(source), "-resize", f"{size}x{size}",
                "-alpha", "remove", "-alpha", "off", "-strip",
                f"PNG24:{icon_dir / name}",
            ],
            check=True,
        )
        print(f"{name}: {size} × {size}")


if __name__ == "__main__":
    main()
