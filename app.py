import io
import itertools
import math
import zipfile
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np
import streamlit as st
from PIL import ExifTags, Image, ImageDraw, ImageEnhance, ImageFont


try:
    from sklearn.cluster import KMeans
except Exception:  # pragma: no cover
    KMeans = None

try:
    import imagehash
except Exception:  # pragma: no cover
    imagehash = None

try:
    from rembg import remove as rembg_remove
except Exception:  # pragma: no cover
    rembg_remove = None


SUPPORTED_FORMATS = ["PNG", "JPEG", "WEBP"]


@dataclass
class ProcessResult:
    image: Image.Image
    name: str


def inject_ui_styles() -> None:
    st.markdown(
        """
        <style>
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@500&display=swap');

        :root {
            --bg-1: #071420;
            --bg-2: #0b2b3a;
            --panel: rgba(255, 255, 255, 0.08);
            --panel-2: rgba(8, 27, 39, 0.72);
            --ink: #e9f4ff;
            --accent: #3dd9a1;
            --accent-2: #2cb6ff;
            --line: rgba(170, 220, 255, 0.25);
        }

        .stApp {
            font-family: 'Space Grotesk', sans-serif;
            color: var(--ink);
            background:
                radial-gradient(1200px 600px at 90% -20%, rgba(44, 182, 255, 0.35), transparent 70%),
                radial-gradient(1000px 600px at -10% 20%, rgba(61, 217, 161, 0.22), transparent 75%),
                linear-gradient(140deg, var(--bg-1), var(--bg-2));
        }

        .block-container {
            padding-top: 1.1rem;
            padding-left: clamp(0.9rem, 2.4vw, 2.2rem);
            padding-right: clamp(0.9rem, 2.4vw, 2.2rem);
        }

        [data-testid="stSidebar"] {
            background: linear-gradient(170deg, #07111a, #0e2535);
            border-right: 1px solid var(--line);
        }

        h1, h2, h3, .stMarkdown p {
            color: var(--ink);
        }

        .hero {
            border: 1px solid var(--line);
            border-radius: 18px;
            padding: 22px 24px;
            margin-bottom: 14px;
            background: linear-gradient(140deg, rgba(7, 26, 39, 0.82), rgba(10, 34, 50, 0.72));
            box-shadow: 0 14px 40px rgba(3, 8, 13, 0.35);
        }

        .hero h1 {
            margin: 0;
            font-size: 2rem;
            letter-spacing: 0.2px;
        }

        .hero p {
            margin: 0.35rem 0 0 0;
            opacity: 0.88;
        }

        .metric-card {
            border: 1px solid var(--line);
            border-radius: 14px;
            background: var(--panel);
            padding: 10px 12px;
            backdrop-filter: blur(6px);
        }

        .metric-k {
            color: #9fc4db;
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }

        .metric-v {
            font-family: 'JetBrains Mono', monospace;
            font-size: 1rem;
            margin-top: 2px;
        }

        .stTabs [data-baseweb="tab-list"] {
            gap: 0.35rem;
            background: rgba(255, 255, 255, 0.04);
            border-radius: 12px;
            padding: 0.35rem;
            border: 1px solid var(--line);
            flex-wrap: wrap;
        }

        .stTabs [data-baseweb="tab"] {
            border-radius: 10px;
            font-weight: 600;
            height: 42px;
            white-space: nowrap;
            flex: 1 1 auto;
        }

        .stTabs [aria-selected="true"] {
            background: linear-gradient(90deg, rgba(61, 217, 161, 0.2), rgba(44, 182, 255, 0.22));
            border: 1px solid rgba(110, 226, 191, 0.55);
        }

        [data-testid="stButton"] button, .stDownloadButton button {
            border-radius: 10px;
            border: 1px solid rgba(61, 217, 161, 0.6);
            background: linear-gradient(90deg, rgba(36, 154, 118, 0.9), rgba(27, 118, 170, 0.92));
            color: #eafff9;
            font-weight: 700;
        }

        [data-testid="stButton"] button:hover, .stDownloadButton button:hover {
            border-color: rgba(44, 182, 255, 0.9);
            transform: translateY(-1px);
        }

        [data-testid="stImage"] img {
            border-radius: 14px;
            border: 1px solid var(--line);
            box-shadow: 0 12px 30px rgba(4, 10, 17, 0.45);
        }

        @media (max-width: 980px) {
            .hero {
                padding: 16px 16px;
                border-radius: 14px;
            }

            .hero h1 {
                font-size: 1.5rem;
            }

            .hero p {
                font-size: 0.95rem;
            }

            .metric-card {
                padding: 9px 10px;
            }

            .metric-k {
                font-size: 0.72rem;
            }

            .metric-v {
                font-size: 0.92rem;
            }

            .stTabs [data-baseweb="tab"] {
                height: 38px;
                font-size: 0.86rem;
            }

            [data-testid="stButton"] button,
            .stDownloadButton button {
                width: 100%;
            }
        }

        @media (max-width: 640px) {
            .block-container {
                padding-left: 0.7rem;
                padding-right: 0.7rem;
            }

            .hero h1 {
                font-size: 1.25rem;
            }

            .hero p {
                font-size: 0.88rem;
            }

            .stTabs [data-baseweb="tab-list"] {
                gap: 0.25rem;
                padding: 0.25rem;
            }

            .stTabs [data-baseweb="tab"] {
                height: 34px;
                font-size: 0.8rem;
                padding-left: 0.5rem;
                padding-right: 0.5rem;
            }

            [data-testid="stImage"] img {
                border-radius: 10px;
            }
        }
        </style>
        """,
        unsafe_allow_html=True,
    )


def render_hero() -> None:
    st.markdown(
        """
        <div class="hero">
            <h1>Smart Image Toolkit</h1>
            <p>Design-grade editing workspace with enhancement, effects, utility automation, and smart AI tools.</p>
        </div>
        """,
        unsafe_allow_html=True,
    )


def metric_card(title: str, value: str) -> str:
    return f'<div class="metric-card"><div class="metric-k">{title}</div><div class="metric-v">{value}</div></div>'


def pil_to_cv2(img: Image.Image) -> np.ndarray:
    arr = np.array(img.convert("RGB"))
    return cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)


def cv2_to_pil(arr: np.ndarray) -> Image.Image:
    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)


def resize_image(img: Image.Image, width: int, height: int, keep_aspect: bool) -> Image.Image:
    if keep_aspect:
        src_w, src_h = img.size
        ratio = min(width / src_w, height / src_h)
        width, height = max(1, int(src_w * ratio)), max(1, int(src_h * ratio))
    return img.resize((width, height), Image.Resampling.LANCZOS)


def rotate_image(img: Image.Image, degrees: float) -> Image.Image:
    return img.rotate(-degrees, expand=True)


def flip_image(img: Image.Image, direction: str) -> Image.Image:
    if direction == "Horizontal":
        return img.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
    if direction == "Vertical":
        return img.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
    return img


def crop_image(img: Image.Image, x1: int, y1: int, x2: int, y2: int) -> Image.Image:
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(img.width, x2), min(img.height, y2)
    if x2 <= x1 or y2 <= y1:
        return img
    return img.crop((x1, y1, x2, y2))


def adjust_enhancements(
    img: Image.Image,
    brightness: float,
    contrast: float,
    sharpness: float,
    saturation: float,
) -> Image.Image:
    out = ImageEnhance.Brightness(img).enhance(brightness)
    out = ImageEnhance.Contrast(out).enhance(contrast)
    out = ImageEnhance.Sharpness(out).enhance(sharpness)
    out = ImageEnhance.Color(out).enhance(saturation)
    return out


def auto_enhance(img: Image.Image) -> Image.Image:
    arr = pil_to_cv2(img)
    lab = cv2.cvtColor(arr, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l2 = clahe.apply(l)
    merged = cv2.merge((l2, a, b))
    out = cv2.cvtColor(merged, cv2.COLOR_LAB2BGR)
    return cv2_to_pil(out)


def denoise_image(img: Image.Image, h: int) -> Image.Image:
    arr = pil_to_cv2(img)
    out = cv2.fastNlMeansDenoisingColored(arr, None, h, h, 7, 21)
    return cv2_to_pil(out)


def bw_filter(img: Image.Image) -> Image.Image:
    return img.convert("L").convert("RGB")


def sepia_filter(img: Image.Image) -> Image.Image:
    arr = np.array(img.convert("RGB"), dtype=np.float32)
    transform = np.array(
        [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]],
        dtype=np.float32,
    )
    out = arr @ transform.T
    out = np.clip(out, 0, 255).astype(np.uint8)
    return Image.fromarray(out)


def vintage_filter(img: Image.Image) -> Image.Image:
    sep = sepia_filter(img)
    arr = np.array(sep, dtype=np.float32)
    noise = np.random.normal(0, 8, arr.shape).astype(np.float32)
    arr = np.clip(arr + noise, 0, 255)

    h, w = arr.shape[:2]
    x = np.linspace(-1, 1, w)
    y = np.linspace(-1, 1, h)
    xx, yy = np.meshgrid(x, y)
    vignette = 1 - np.clip(np.sqrt(xx * xx + yy * yy), 0, 1) * 0.45
    arr *= vignette[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def cartoon_effect(img: Image.Image) -> Image.Image:
    arr = pil_to_cv2(img)
    gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    gray = cv2.medianBlur(gray, 7)
    edges = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 9, 7)
    color = cv2.bilateralFilter(arr, 9, 200, 200)
    out = cv2.bitwise_and(color, color, mask=edges)
    return cv2_to_pil(out)


def pencil_sketch(img: Image.Image) -> Image.Image:
    arr = pil_to_cv2(img)
    gray = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)
    inv = 255 - gray
    blur = cv2.GaussianBlur(inv, (21, 21), 0)
    sketch = cv2.divide(gray, 255 - blur, scale=256)
    return Image.fromarray(sketch).convert("RGB")


def blur_effect(img: Image.Image, ksize: int) -> Image.Image:
    arr = pil_to_cv2(img)
    k = max(1, ksize // 2 * 2 + 1)
    out = cv2.GaussianBlur(arr, (k, k), 0)
    return cv2_to_pil(out)


def remove_background(img: Image.Image) -> Image.Image:
    if rembg_remove is not None:
        return rembg_remove(img)

    # Fallback: rough grabcut segmentation
    arr = pil_to_cv2(img)
    mask = np.zeros(arr.shape[:2], np.uint8)
    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    rect = (10, 10, max(1, arr.shape[1] - 20), max(1, arr.shape[0] - 20))
    cv2.grabCut(arr, mask, rect, bgd_model, fgd_model, 5, cv2.GC_INIT_WITH_RECT)
    alpha = np.where((mask == 2) | (mask == 0), 0, 255).astype("uint8")
    rgba = cv2.cvtColor(arr, cv2.COLOR_BGR2BGRA)
    rgba[:, :, 3] = alpha
    return Image.fromarray(cv2.cvtColor(rgba, cv2.COLOR_BGRA2RGBA))


def add_watermark(
    img: Image.Image,
    text: str,
    logo: Optional[Image.Image],
    opacity: int,
    scale: float,
    position: str,
) -> Image.Image:
    base = img.convert("RGBA")
    layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    w, h = base.size
    margin = max(10, int(min(w, h) * 0.02))

    if logo is not None:
        logo_rgba = logo.convert("RGBA")
        lw = max(1, int(w * scale))
        ratio = lw / logo_rgba.width
        lh = max(1, int(logo_rgba.height * ratio))
        logo_rgba = logo_rgba.resize((lw, lh), Image.Resampling.LANCZOS)
        alpha = logo_rgba.split()[-1].point(lambda p: int(p * opacity / 255))
        logo_rgba.putalpha(alpha)
        x, y = pick_position(position, w, h, lw, lh, margin)
        layer.paste(logo_rgba, (x, y), logo_rgba)

    if text.strip():
        font_size = max(16, int(min(w, h) * 0.05))
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", font_size)
        except Exception:
            font = ImageFont.load_default()
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x, y = pick_position(position, w, h, tw, th, margin)
        draw.text((x, y), text, fill=(255, 255, 255, opacity), font=font, stroke_width=2, stroke_fill=(0, 0, 0, opacity))

    return Image.alpha_composite(base, layer).convert("RGB")


def pick_position(position: str, w: int, h: int, tw: int, th: int, margin: int) -> Tuple[int, int]:
    mapping = {
        "Top-Left": (margin, margin),
        "Top-Right": (w - tw - margin, margin),
        "Bottom-Left": (margin, h - th - margin),
        "Bottom-Right": (w - tw - margin, h - th - margin),
        "Center": ((w - tw) // 2, (h - th) // 2),
    }
    return mapping.get(position, mapping["Bottom-Right"])


def meme_generator(img: Image.Image, top_text: str, bottom_text: str) -> Image.Image:
    out = img.convert("RGB")
    draw = ImageDraw.Draw(out)
    w, h = out.size
    size = max(20, int(h * 0.08))
    try:
        font = ImageFont.truetype("DejaVuSans-Bold.ttf", size)
    except Exception:
        font = ImageFont.load_default()

    def draw_centered(text: str, y: int) -> None:
        if not text:
            return
        text = text.upper()
        bbox = draw.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        x = (w - tw) // 2
        draw.text((x, y), text, fill="white", font=font, stroke_width=3, stroke_fill="black")

    draw_centered(top_text, int(h * 0.04))
    draw_centered(bottom_text, int(h * 0.84))
    return out


def make_collage(images: Sequence[Image.Image], cols: int, gap: int, bg: Tuple[int, int, int]) -> Image.Image:
    if not images:
        return Image.new("RGB", (800, 600), bg)
    thumbs = [img.copy().convert("RGB") for img in images]
    max_w = max(i.width for i in thumbs)
    max_h = max(i.height for i in thumbs)
    for i in range(len(thumbs)):
        thumbs[i] = ImageOps_fit(thumbs[i], (max_w, max_h))

    rows = math.ceil(len(thumbs) / cols)
    canvas_w = cols * max_w + (cols + 1) * gap
    canvas_h = rows * max_h + (rows + 1) * gap
    canvas = Image.new("RGB", (canvas_w, canvas_h), bg)

    for idx, img in enumerate(thumbs):
        r, c = divmod(idx, cols)
        x = gap + c * (max_w + gap)
        y = gap + r * (max_h + gap)
        canvas.paste(img, (x, y))
    return canvas


def ImageOps_fit(img: Image.Image, size: Tuple[int, int]) -> Image.Image:
    target_w, target_h = size
    src_w, src_h = img.size
    scale = max(target_w / src_w, target_h / src_h)
    nw, nh = max(1, int(src_w * scale)), max(1, int(src_h * scale))
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - target_w) // 2
    top = (nh - target_h) // 2
    return resized.crop((left, top, left + target_w, top + target_h))


def extract_palette(img: Image.Image, k: int) -> List[Tuple[int, int, int]]:
    arr = np.array(img.convert("RGB"))
    pixels = arr.reshape(-1, 3)
    if len(pixels) > 25000:
        idx = np.random.choice(len(pixels), 25000, replace=False)
        pixels = pixels[idx]

    if KMeans is not None:
        model = KMeans(n_clusters=k, n_init=10, random_state=42)
        model.fit(pixels)
        centers = model.cluster_centers_.astype(int)
        return [tuple(int(c) for c in center) for center in centers]

    # Fallback without sklearn
    uniq, counts = np.unique(pixels, axis=0, return_counts=True)
    top_idx = np.argsort(counts)[-k:][::-1]
    return [tuple(int(v) for v in uniq[i]) for i in top_idx]


def image_hash(img: Image.Image) -> Optional["imagehash.ImageHash"]:
    if imagehash is None:
        return None
    return imagehash.phash(img.convert("RGB"))


def detect_duplicates(images: Sequence[Tuple[str, Image.Image]], threshold: int = 8) -> List[Tuple[str, str, int]]:
    hashes = [(name, image_hash(img)) for name, img in images]
    hashes = [(n, h) for n, h in hashes if h is not None]
    dupes = []
    for (n1, h1), (n2, h2) in itertools.combinations(hashes, 2):
        dist = h1 - h2
        if dist <= threshold:
            dupes.append((n1, n2, dist))
    return sorted(dupes, key=lambda x: x[2])


def feature_vector(img: Image.Image) -> np.ndarray:
    arr = pil_to_cv2(img)
    hsv = cv2.cvtColor(arr, cv2.COLOR_BGR2HSV)
    hist = cv2.calcHist([hsv], [0, 1, 2], None, [8, 8, 8], [0, 180, 0, 256, 0, 256]).flatten()
    hist = hist / (np.linalg.norm(hist) + 1e-8)

    if imagehash is not None:
        h = np.array(imagehash.phash(img).hash, dtype=np.float32).flatten()
    else:
        h = cv2.resize(cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY), (16, 16)).flatten().astype(np.float32)
        h = h / (np.linalg.norm(h) + 1e-8)
    return np.concatenate([hist, h])


def similarity_search(images: Sequence[Tuple[str, Image.Image]], query_name: str) -> List[Tuple[str, float]]:
    feats = {name: feature_vector(img) for name, img in images}
    q = feats.get(query_name)
    if q is None:
        return []
    qn = np.linalg.norm(q) + 1e-8
    out = []
    for name, v in feats.items():
        if name == query_name:
            continue
        score = float(np.dot(q, v) / (qn * (np.linalg.norm(v) + 1e-8)))
        out.append((name, score))
    return sorted(out, key=lambda x: x[1], reverse=True)


def ai_upscale(img: Image.Image, scale: int) -> Image.Image:
    arr = pil_to_cv2(img)
    out = cv2.resize(arr, (arr.shape[1] * scale, arr.shape[0] * scale), interpolation=cv2.INTER_CUBIC)
    return cv2_to_pil(out)


def compress_and_export(img: Image.Image, fmt: str, quality: int) -> bytes:
    buf = io.BytesIO()
    params = {}
    if fmt == "JPEG":
        params = {"quality": quality, "optimize": True}
    elif fmt == "WEBP":
        params = {"quality": quality, "method": 6}
    img.convert("RGB").save(buf, format=fmt, **params)
    return buf.getvalue()


def compress_to_target_kb(img: Image.Image, fmt: str, target_kb: int) -> Tuple[bytes, int]:
    target_bytes = max(1, int(target_kb * 1024))
    if fmt == "PNG":
        return compress_and_export(img, fmt, 100), 100

    lo, hi = 1, 100
    best_quality = 1
    best_data = compress_and_export(img, fmt, best_quality)

    while lo <= hi:
        mid = (lo + hi) // 2
        data = compress_and_export(img, fmt, mid)
        if len(data) <= target_bytes:
            best_data = data
            best_quality = mid
            lo = mid + 1
        else:
            hi = mid - 1

    return best_data, best_quality


def checkerboard_background(width: int, height: int, tile: int = 20) -> Image.Image:
    board = Image.new("RGB", (width, height), (238, 240, 245))
    draw = ImageDraw.Draw(board)
    alt = (218, 222, 230)
    for y in range(0, height, tile):
        for x in range(0, width, tile):
            if ((x // tile) + (y // tile)) % 2:
                draw.rectangle((x, y, x + tile - 1, y + tile - 1), fill=alt)
    return board


def preview_with_background(img: Image.Image, bg_style: str, custom_hex: str) -> Image.Image:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    if bg_style == "Transparent":
        base = checkerboard_background(w, h).convert("RGBA")
    elif bg_style == "White":
        base = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    elif bg_style == "Black":
        base = Image.new("RGBA", (w, h), (0, 0, 0, 255))
    elif bg_style == "Blue":
        base = Image.new("RGBA", (w, h), (66, 103, 255, 255))
    elif bg_style == "Pink":
        base = Image.new("RGBA", (w, h), (246, 161, 176, 255))
    elif bg_style == "Yellow":
        base = Image.new("RGBA", (w, h), (244, 223, 122, 255))
    else:
        rgb = tuple(int(custom_hex.strip("#")[i : i + 2], 16) for i in (0, 2, 4))
        base = Image.new("RGBA", (w, h), (*rgb, 255))
    return Image.alpha_composite(base, rgba).convert("RGB")


def image_metadata(img: Image.Image) -> Dict[str, str]:
    exif_data: Dict[str, str] = {}
    exif = img.getexif()
    if not exif:
        return exif_data
    tag_map = {v: k for k, v in ExifTags.TAGS.items()}
    for tag_id, value in exif.items():
        tag = ExifTags.TAGS.get(tag_id, str(tag_id))
        if isinstance(value, bytes):
            continue
        exif_data[str(tag)] = str(value)

    if "DateTimeOriginal" in exif_data:
        exif_data["CapturedAt"] = exif_data["DateTimeOriginal"]
    if "Model" in exif_data and "Make" in exif_data:
        exif_data["Camera"] = f"{exif_data['Make']} {exif_data['Model']}".strip()
    if "Orientation" in tag_map:
        pass
    return exif_data


def apply_selected_ops_batch(images: Sequence[Tuple[str, Image.Image]], options: Dict) -> List[ProcessResult]:
    outputs: List[ProcessResult] = []
    for name, img in images:
        out = img.copy().convert("RGB")

        if options.get("auto_enhance"):
            out = auto_enhance(out)
        if options.get("brightness") != 1.0 or options.get("contrast") != 1.0:
            out = adjust_enhancements(
                out,
                options.get("brightness", 1.0),
                options.get("contrast", 1.0),
                options.get("sharpness", 1.0),
                options.get("saturation", 1.0),
            )
        if options.get("bw"):
            out = bw_filter(out)
        if options.get("sepia"):
            out = sepia_filter(out)
        if options.get("resize"):
            out = resize_image(out, options["width"], options["height"], options["keep_aspect"])

        outputs.append(ProcessResult(image=out, name=name))
    return outputs


def to_zip_bytes(results: Sequence[ProcessResult], fmt: str, quality: int) -> bytes:
    buf = io.BytesIO()
    ext = fmt.lower().replace("jpeg", "jpg")
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for result in results:
            image_bytes = compress_and_export(result.image, fmt, quality)
            stem = result.name.rsplit(".", 1)[0]
            zf.writestr(f"{stem}.{ext}", image_bytes)
    return buf.getvalue()


def load_uploaded_images(files) -> List[Tuple[str, Image.Image]]:
    images: List[Tuple[str, Image.Image]] = []
    for f in files:
        try:
            img = Image.open(f).convert("RGB")
            images.append((f.name, img))
        except Exception:
            continue
    return images


def main() -> None:
    st.set_page_config(page_title="Smart Image Toolkit", page_icon="🖼️", layout="wide")
    inject_ui_styles()
    render_hero()
    if "bg_removed_applied_preview" not in st.session_state:
        st.session_state["bg_removed_applied_preview"] = None
    if "bg_removed_preview" not in st.session_state:
        st.session_state["bg_removed_preview"] = None
    if "bg_preview_source" not in st.session_state:
        st.session_state["bg_preview_source"] = None

    files = st.sidebar.file_uploader(
        "Upload Images",
        type=["png", "jpg", "jpeg", "webp", "bmp"],
        accept_multiple_files=True,
    )

    if not files:
        st.info("Upload one or more images to start.")
        return

    images = load_uploaded_images(files)
    names = [name for name, _ in images]
    selected_name = st.sidebar.selectbox("Select Active Image", names)
    base_img = next(img for name, img in images if name == selected_name)
    if st.session_state.get("bg_preview_source") != selected_name:
        st.session_state["bg_removed_preview"] = None
        st.session_state["bg_removed_applied_preview"] = None
        st.session_state["bg_preview_source"] = selected_name

    zoom = st.sidebar.slider("Zoom Viewer", 0.1, 3.0, 1.0, 0.1)

    top1, top2, top3, top4 = st.columns(4)
    top1.markdown(metric_card("Uploaded", str(len(images))), unsafe_allow_html=True)
    top2.markdown(metric_card("Active", selected_name), unsafe_allow_html=True)
    top3.markdown(metric_card("Resolution", f"{base_img.width} x {base_img.height}"), unsafe_allow_html=True)
    top4.markdown(metric_card("Formats", "PNG • JPG • WEBP"), unsafe_allow_html=True)

    tabs = st.tabs([
        "Basic Edit",
        "Enhancement",
        "Filters & FX",
        "Utility",
        "Creative",
        "Smart AI",
        "Export",
    ])

    working = base_img.copy().convert("RGB")

    with tabs[0]:
        st.subheader("Basic Image Adjustment")
        col1, col2, col3 = st.columns(3)

        with col1:
            w = st.number_input("Width", 1, 10000, working.width)
            h = st.number_input("Height", 1, 10000, working.height)
            keep = st.checkbox("Maintain Aspect Ratio", value=True)
            if st.button("Apply Resize"):
                working = resize_image(working, int(w), int(h), keep)

        with col2:
            rotate_type = st.selectbox("Rotate", ["None", "90", "180", "270", "Custom"])
            if rotate_type == "Custom":
                angle = st.slider("Custom Angle", -360.0, 360.0, 0.0, 1.0)
            elif rotate_type == "None":
                angle = 0.0
            else:
                angle = float(rotate_type)
            flip_dir = st.selectbox("Flip", ["None", "Horizontal", "Vertical"])
            rotate_preview = rotate_image(working, angle) if abs(angle) > 1e-9 else working
            if flip_dir != "None":
                rotate_preview = flip_image(rotate_preview, flip_dir)
            st.caption("Rotate / Flip Preview")
            st.image(rotate_preview, use_container_width=True)
            if st.button("Apply Rotation / Flip"):
                working = rotate_preview

        with col3:
            x1 = st.number_input("Crop X1", 0, working.width, 0)
            y1 = st.number_input("Crop Y1", 0, working.height, 0)
            x2 = st.number_input("Crop X2", 0, working.width, working.width)
            y2 = st.number_input("Crop Y2", 0, working.height, working.height)
            if st.button("Apply Crop"):
                working = crop_image(working, int(x1), int(y1), int(x2), int(y2))

    with tabs[1]:
        st.subheader("Image Enhancement")
        b = st.slider("Brightness", 0.0, 3.0, 1.0, 0.05)
        c = st.slider("Contrast", 0.0, 3.0, 1.0, 0.05)
        s = st.slider("Sharpness", 0.0, 5.0, 1.0, 0.05)
        sat = st.slider("Saturation", 0.0, 3.0, 1.0, 0.05)
        denoise = st.slider("Denoise Strength", 0, 30, 0)
        use_auto = st.checkbox("Auto Enhance")

        if st.button("Apply Enhancement"):
            working = adjust_enhancements(working, b, c, s, sat)
            if denoise > 0:
                working = denoise_image(working, denoise)
            if use_auto:
                working = auto_enhance(working)

    with tabs[2]:
        st.subheader("Filters & Effects")
        effect = st.selectbox(
            "Choose Effect",
            ["None", "Black & White", "Sepia", "Vintage", "Cartoon", "Pencil Sketch", "Blur"],
        )
        blur_k = st.slider("Blur Intensity", 1, 51, 15, 2)
        if st.button("Apply Effect"):
            if effect == "Black & White":
                working = bw_filter(working)
            elif effect == "Sepia":
                working = sepia_filter(working)
            elif effect == "Vintage":
                working = vintage_filter(working)
            elif effect == "Cartoon":
                working = cartoon_effect(working)
            elif effect == "Pencil Sketch":
                working = pencil_sketch(working)
            elif effect == "Blur":
                working = blur_effect(working, blur_k)

    with tabs[3]:
        st.subheader("Image Utility Tools")
        u1, u2 = st.columns(2)

        with u1:
            st.markdown("### Quick Resizer")
            util_keep = st.checkbox("Keep Aspect Ratio", value=True, key="util_keep_aspect")
            util_w = st.number_input("Resize Width", 1, 10000, working.width, key="util_w")
            util_h = st.number_input("Resize Height", 1, 10000, working.height, key="util_h")
            if st.button("Apply Utility Resize", key="apply_util_resize"):
                working = resize_image(working, int(util_w), int(util_h), util_keep)

        with u2:
            st.markdown("### Image Compressor")
            util_fmt = st.selectbox("Compression Format", SUPPORTED_FORMATS, key="util_compress_fmt")
            use_target_kb = st.checkbox("Compress to Target Size (KB)", key="util_target_kb_mode")
            applied_quality = 80
            if use_target_kb:
                target_kb = st.number_input("Target Size (KB)", 1, 50000, 200, key="util_target_kb")
                compressed_data, applied_quality = compress_to_target_kb(working, util_fmt, int(target_kb))
                if util_fmt == "PNG":
                    st.caption("PNG does not use quality compression; target size may not be exact.")
                st.caption(
                    f"Compressed Size: {len(compressed_data) / 1024:.1f} KB (used quality {applied_quality})"
                )
            else:
                util_quality = st.slider("Compression Quality", 1, 100, 80, key="util_compress_quality")
                applied_quality = util_quality
                compressed_data = compress_and_export(working, util_fmt, util_quality)
                st.caption(f"Estimated Output Size: {len(compressed_data) / 1024:.1f} KB")
            util_ext = util_fmt.lower().replace("jpeg", "jpg")
            st.download_button(
                "Download Compressed Image",
                data=compressed_data,
                file_name=f"compressed_{selected_name.rsplit('.', 1)[0]}.{util_ext}",
                mime=f"image/{util_ext}",
                key="download_compressed",
            )

        st.markdown("### Metadata Viewer")
        meta = image_metadata(working)
        if meta:
            st.json(meta)
        else:
            st.write("No EXIF metadata found.")

        st.markdown("### Duplicate Image Detector")
        if st.button("Find Duplicates"):
            dupes = detect_duplicates(images)
            if dupes:
                for a, bname, dist in dupes:
                    st.write(f"- {a} and {bname} (distance={dist})")
            else:
                st.write("No likely duplicates found.")

        st.markdown("### Image Similarity Search")
        query = st.selectbox("Query Image", names, key="similarity_query")
        if st.button("Find Similar Images"):
            sims = similarity_search(images, query)
            if sims:
                for name, score in sims[:10]:
                    st.write(f"- {name}: {score:.3f}")
            else:
                st.write("No results.")

    with tabs[4]:
        st.subheader("Creative Editing Tools")
        c1, c2 = st.columns(2)

        with c1:
            st.markdown("### Watermark")
            wm_text = st.text_input("Watermark Text", "")
            wm_logo = st.file_uploader("Optional Logo", type=["png", "jpg", "jpeg"], key="wm_logo")
            wm_opacity = st.slider("Opacity", 10, 255, 140)
            wm_scale = st.slider("Logo Scale", 0.05, 0.5, 0.2, 0.01)
            wm_pos = st.selectbox("Position", ["Top-Left", "Top-Right", "Bottom-Left", "Bottom-Right", "Center"])
            if st.button("Apply Watermark"):
                logo_img = Image.open(wm_logo).convert("RGBA") if wm_logo else None
                working = add_watermark(working, wm_text, logo_img, wm_opacity, wm_scale, wm_pos)

            st.markdown("### Meme Generator")
            top = st.text_input("Top Text", "")
            bottom = st.text_input("Bottom Text", "")
            if st.button("Create Meme"):
                working = meme_generator(working, top, bottom)

        with c2:
            st.markdown("### Collage Maker")
            cols = st.slider("Columns", 1, 6, 3)
            gap = st.slider("Gap", 0, 40, 8)
            bg_hex = st.color_picker("Background", "#202020")
            if st.button("Build Collage"):
                rgb = tuple(int(bg_hex.strip("#")[i : i + 2], 16) for i in (0, 2, 4))
                working = make_collage([img for _, img in images], cols, gap, rgb)

    with tabs[5]:
        st.subheader("Smart / Advanced Tools")
        st.markdown("### Background Remover")
        bg_style = st.radio(
            "Background Style",
            ["Transparent", "White", "Black", "Blue", "Pink", "Yellow", "Custom"],
            horizontal=True,
            key="bg_style",
        )
        custom_bg = "#7fd7ff"
        if bg_style == "Custom":
            custom_bg = st.color_picker("Custom Background Color", "#7fd7ff", key="bg_custom")
        view_mode = st.radio("Preview Mode", ["Before", "After"], horizontal=True, key="bg_view_mode")

        if st.button("Generate Cutout Preview", key="bg_generate_preview"):
            st.session_state["bg_removed_preview"] = remove_background(working)

        bg_removed_preview = st.session_state.get("bg_removed_preview")
        br1, br2 = st.columns(2)
        with br1:
            st.caption("Original")
            st.image(working, use_container_width=True)
        with br2:
            st.caption("After Background Removal")
            if bg_removed_preview is not None:
                shown_after = preview_with_background(bg_removed_preview, bg_style, custom_bg)
                st.image(shown_after, use_container_width=True)
            else:
                st.info("Click 'Generate Cutout Preview' to create preview.")

        if view_mode == "Before":
            st.caption("Focused View: Before")
            st.image(working, use_container_width=True)
        else:
            st.caption("Focused View: After")
            if bg_removed_preview is not None:
                st.image(preview_with_background(bg_removed_preview, bg_style, custom_bg), use_container_width=True)
            else:
                st.info("No cutout preview yet.")

        if st.button("Remove Background", key="bg_apply"):
            if bg_removed_preview is None:
                bg_removed_preview = remove_background(working)
                st.session_state["bg_removed_preview"] = bg_removed_preview
            working = bg_removed_preview
            st.session_state["bg_removed_applied_preview"] = bg_removed_preview

        applied_bg_removed = st.session_state.get("bg_removed_applied_preview")
        if applied_bg_removed is not None:
            st.caption("After Background Remover (Applied)")
            st.image(preview_with_background(applied_bg_removed, bg_style, custom_bg), use_container_width=True)
            out_buf = io.BytesIO()
            applied_bg_removed.save(out_buf, format="PNG")
            st.download_button(
                "Download Cutout (PNG)",
                data=out_buf.getvalue(),
                file_name=f"cutout_{selected_name.rsplit('.', 1)[0]}.png",
                mime="image/png",
                key="bg_download_png",
            )

        st.markdown("---")
        a2, a3 = st.columns(2)
        with a2:
            scale = st.selectbox("Upscale", [2, 3, 4], index=0)
            if st.button("AI Upscale"):
                working = ai_upscale(working, int(scale))

        with a3:
            k = st.slider("Palette Colors", 2, 12, 5)
            if st.button("Extract Palette"):
                palette = extract_palette(working, k)
                sw = st.columns(len(palette))
                for i, c in enumerate(palette):
                    sw[i].color_picker(f"Color {i + 1}", f"#{c[0]:02x}{c[1]:02x}{c[2]:02x}", key=f"palette_{i}")

    with tabs[6]:
        st.subheader("Export + Batch Processing")
        fmt = st.selectbox("Output Format", SUPPORTED_FORMATS)
        quality = st.slider("Compression Quality", 1, 100, 90)

        st.markdown("### Batch Process")
        batch_resize = st.checkbox("Resize")
        bw = st.checkbox("Black & White", key="batch_bw")
        sep = st.checkbox("Sepia", key="batch_sep")
        bat_auto = st.checkbox("Auto Enhance", key="batch_auto")

        bwid, bhei, keep = working.width, working.height, True
        if batch_resize:
            bwid = st.number_input("Batch Width", 1, 10000, working.width, key="batch_w")
            bhei = st.number_input("Batch Height", 1, 10000, working.height, key="batch_h")
            keep = st.checkbox("Batch Keep Aspect", True, key="batch_keep")

        if st.button("Run Batch + Download ZIP"):
            opts = {
                "auto_enhance": bat_auto,
                "brightness": 1.0,
                "contrast": 1.0,
                "sharpness": 1.0,
                "saturation": 1.0,
                "bw": bw,
                "sepia": sep,
                "resize": batch_resize,
                "width": int(bwid),
                "height": int(bhei),
                "keep_aspect": keep,
            }
            processed = apply_selected_ops_batch(images, opts)
            zip_bytes = to_zip_bytes(processed, fmt, quality)
            st.download_button(
                "Download Batch ZIP",
                data=zip_bytes,
                file_name="batch_output.zip",
                mime="application/zip",
            )

    view_w = max(1, int(working.width * zoom))
    view_h = max(1, int(working.height * zoom))
    preview = working.resize((view_w, view_h), Image.Resampling.LANCZOS)

    st.markdown("## Preview Studio")
    p1, p2 = st.columns(2)
    with p1:
        st.caption("Original")
        st.image(base_img, use_container_width=True)
    with p2:
        st.caption("Edited (Current Session)")
        st.image(preview, use_container_width=True)

    fmt = st.sidebar.selectbox("Quick Export Format", SUPPORTED_FORMATS, key="quick_fmt")
    quality = st.sidebar.slider("Quick Export Quality", 1, 100, 90, key="quick_q")
    data = compress_and_export(working, fmt, quality)
    ext = fmt.lower().replace("jpeg", "jpg")
    st.sidebar.download_button(
        "Download Current Image",
        data=data,
        file_name=f"edited_{selected_name.rsplit('.', 1)[0]}.{ext}",
        mime=f"image/{ext}",
    )


if __name__ == "__main__":
    main()
