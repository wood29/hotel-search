"""Renders the app icon in every size iPhone, iPad, PC browsers and installed web apps ask for."""
import sys, io
from playwright.sync_api import sync_playwright
from PIL import Image
src, out = sys.argv[1], sys.argv[2]
svg = open(src).read()
def rounded(svg, r):  # rounded tile for places that show the icon as-is (PC, favicon)
    return svg.replace('<rect width="1024" height="1024" fill="#141414"/>', f'<rect width="1024" height="1024" rx="{r}" fill="#141414"/>')
jobs = {  # name: (size, rounded corner radius in 1024 units or None = full square, iOS rounds it itself)
    "apple-touch-icon.png": (180, None), "apple-touch-icon-167.png": (167, None),
    "apple-touch-icon-152.png": (152, None), "apple-touch-icon-120.png": (120, None),
    "icon-192.png": (192, 226), "icon-512.png": (512, 226), "maskable-512.png": (512, None),
    "favicon-16.png": (16, 200), "favicon-32.png": (32, 200), "favicon-48.png": (48, 200),
    "icon-256.png": (256, 226),
}
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, (size, r) in jobs.items():
        s = svg if r is None else rounded(svg, r)
        if name.startswith("favicon"):  # tiny sizes: let the mark fill more of the tile
            s = s.replace('fill="#141414"/>', 'fill="#141414"/><g transform="translate(512 512) scale(1.28) translate(-512 -512)">', 1).replace("</svg>", "</g></svg>")
        if name.startswith("maskable"):  # keep the mark inside the safe zone (80%)
            s = s.replace('<rect width="1024" height="1024" fill="#141414"/>', '<rect width="1024" height="1024" fill="#141414"/><g transform="translate(102 102) scale(.8)">').replace("</svg>", "</g></svg>")
        pg = b.new_page(viewport={"width": size, "height": size}, device_scale_factor=1)
        pg.set_content(f'<html><body style="margin:0;background:transparent">{s.replace("<svg ", f"<svg width={size} height={size} ")}</body></html>')
        pg.screenshot(path=f"{out}/{name}", omit_background=True)
        pg.close()
    b.close()
imgs = [Image.open(f"{out}/favicon-{n}.png") for n in (16, 32, 48)] + [Image.open(f"{out}/icon-256.png")]
imgs[-1].save(f"{out}/favicon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)], append_images=imgs[:-1])
open(f"{out}/icon.svg", "w").write(rounded(svg, 226))
print("ok")
