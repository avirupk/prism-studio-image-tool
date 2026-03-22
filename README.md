# Prism Studio (HTML/CSS/JavaScript)

Premium client-side image editor with animated UI and advanced visual tools.

## Run

From this folder:

```bash
python -m http.server 8000
```

Then open:

`http://localhost:8000`

## Main Files

- `index.html` - app structure
- `styles.css` - premium visual theme, transitions, animated background
- `script.js` - full editor logic and feature pipeline

## Implemented Feature Areas

- Basic: resize, aspect ratio, rotate, flip, crop, zoom
- Enhancement: brightness, contrast, saturation, sharpness, denoise, motion blur
- Effects: black/white, sepia, vintage, cartoon, sketch, blur
- Utilities: compression/quality export, format conversion, duplicate detection, similarity search, metadata panel
- Creative: watermark (text/logo), meme generator, collage maker
- Smart: auto enhance, background remove (corner-color keying), upscaler, palette extraction

## Debug and Test

- Use the **Run Diagnostics** button in the Utilities panel after opening the app.
- It runs real in-browser test cases for:
  - resize
  - rotate
  - crop
  - effect pipeline
  - enhancement pipeline
  - duplicate hash logic
  - similarity separation
  - palette extraction
  - auto-enhance stability
