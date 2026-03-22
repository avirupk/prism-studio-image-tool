const state = {
  images: [],
  active: -1,
  pendingActionLabel: null,
  logo: null,
  bgTool: {
    previewCutout: null,
    view: "before",
    style: "transparent",
    customColor: "#59c5ff",
  },
  filter: {
    brightness: 100,
    contrast: 100,
    saturation: 100,
    sharpness: 0,
    blur: 0,
    denoise: 0,
    motionBlur: 0,
  },
};

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

const fileInput = document.getElementById("fileInput");
const dropzone = document.getElementById("dropzone");
const library = document.getElementById("library");
const utilOutput = document.getElementById("utilOutput");
const metadata = document.getElementById("metadata");
const changeHistoryList = document.getElementById("changeHistoryList");
const imageSizeInfo = document.getElementById("imageSizeInfo");

const origCanvas = document.getElementById("origCanvas");
const editCanvas = document.getElementById("editCanvas");
const editedWrap = document.getElementById("editedWrap");

const octx = origCanvas.getContext("2d", { willReadFrequently: true });
const ectx = editCanvas.getContext("2d", { willReadFrequently: true });

const statImages = document.getElementById("statImages");
const statActive = document.getElementById("statActive");
const statRes = document.getElementById("statRes");
const statZoom = document.getElementById("statZoom");
const simpleModeToggle = document.getElementById("simpleModeToggle");
const themeToggle = document.getElementById("themeToggle");
const themeToggleLabel = document.getElementById("themeToggleLabel");
const histCanvas = document.getElementById("histCanvas");
const bgPreviewCanvas = document.getElementById("bgPreviewCanvas");

const MAX_HISTORY = 20;
let historyLock = false;
let aiSegmenter = null;
let aiSegmenterReady = false;
let sizeRefreshTimer = null;
let sizeRefreshToken = 0;
let filterPreviewTimer = null;
let resizeFrame = null;
let drawFrame = null;

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function extFromMime(mime) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  return "bin";
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function downloadBlob(blob, filename) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function canvasToBlobAsync(canvas, mime, quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mime, quality));
}

async function refreshActiveImageSize() {
  if (!imageSizeInfo) return;
  const imgObj = activeImage();
  if (!imgObj) {
    imageSizeInfo.textContent = "-";
    return;
  }

  if (imgObj.file?.size) {
    imageSizeInfo.textContent = formatBytes(imgObj.file.size);
    return;
  }

  const token = ++sizeRefreshToken;
  imageSizeInfo.textContent = "Calculating...";

  const mime = document.getElementById("format")?.value || "image/png";
  const quality = Number(document.getElementById("quality")?.value || 90) / 100;
  const blob = await canvasToBlobAsync(imgObj.working, mime, quality);

  if (token !== sizeRefreshToken) return;
  imageSizeInfo.textContent = blob ? formatBytes(blob.size) : "-";
}

function queueActiveImageSizeRefresh(delay = 120) {
  if (sizeRefreshTimer) clearTimeout(sizeRefreshTimer);
  sizeRefreshTimer = setTimeout(() => {
    refreshActiveImageSize().catch(() => {
      if (imageSizeInfo) imageSizeInfo.textContent = "-";
    });
  }, delay);
}

async function canvasToBlobStrict(canvas, mime, quality = 0.92) {
  const blob = await canvasToBlobAsync(canvas, mime, quality);
  if (!blob) throw new Error("Failed to create image blob.");
  return blob;
}

async function blobToCanvas(blob) {
  const bitmap = await createImageBitmap(blob);
  const out = document.createElement("canvas");
  out.width = bitmap.width;
  out.height = bitmap.height;
  out.getContext("2d").drawImage(bitmap, 0, 0);
  if (typeof bitmap.close === "function") bitmap.close();
  return out;
}

function toast(msg) {
  utilOutput.textContent = msg;
}

function applyTheme(theme) {
  const isDark = theme === "dark";
  document.body.classList.toggle("theme-dark", isDark);
  if (themeToggle) themeToggle.checked = isDark;
  if (themeToggleLabel) themeToggleLabel.textContent = isDark ? "Dark Mode" : "Light Mode";
  try {
    localStorage.setItem("prismTheme", theme);
  } catch (_) {}

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta) themeMeta.setAttribute("content", isDark ? "#0f1724" : "#1565ff");
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem("prismTheme");
  } catch (_) {}
  if (saved === "dark" || saved === "light") {
    applyTheme(saved);
    return;
  }
  const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? "dark" : "light");
}

function addChangeHistory(message) {
  if (!changeHistoryList) return;
  const li = document.createElement("li");
  li.textContent = message;
  changeHistoryList.appendChild(li);

  while (changeHistoryList.children.length > 140) {
    changeHistoryList.removeChild(changeHistoryList.firstElementChild);
  }
  changeHistoryList.scrollTop = changeHistoryList.scrollHeight;
}

function safeAction(label, fn) {
  return (...args) => {
    state.pendingActionLabel = label;
    try {
      const result = fn(...args);
      if (result && typeof result.then === "function") {
        result.catch((err) => {
          console.error(err);
          toast(`${label} failed: ${err?.message || "unknown error"}`);
        }).finally(() => {
          state.pendingActionLabel = null;
        });
        return;
      }
      state.pendingActionLabel = null;
    } catch (err) {
      state.pendingActionLabel = null;
      console.error(err);
      toast(`${label} failed: ${err?.message || "unknown error"}`);
    }
  };
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = reject;
    img.src = url;
  });
}

async function addFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const { img, url } = await readImage(file);
      const base = document.createElement("canvas");
      base.width = img.width;
      base.height = img.height;
      base.getContext("2d").drawImage(img, 0, 0);

      state.images.push({
        id: uid(),
        name: file.name,
        file,
        type: file.type,
        url,
        width: img.width,
        height: img.height,
        original: canvasCopy(base),
        working: canvasCopy(base),
        undoStack: [],
        redoStack: [],
      });
      added++;
    } catch (_) {}
  }
  if (state.active === -1 && state.images.length) state.active = 0;
  renderLibrary();
  loadActive();
  if (added > 0) {
    addChangeHistory(`Uploaded ${added} image${added > 1 ? "s" : ""}.`);
  }
}

function canvasCopy(src) {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

function activeImage() {
  return state.images[state.active] || null;
}

function initHistory(imgObj) {
  imgObj.undoStack = [];
  imgObj.redoStack = [];
}

function pushUndoState(imgObj) {
  if (!imgObj || historyLock) return;
  if (!imgObj.undoStack) initHistory(imgObj);
  imgObj.undoStack.push(canvasCopy(imgObj.working));
  if (imgObj.undoStack.length > MAX_HISTORY) imgObj.undoStack.shift();
  imgObj.redoStack = [];
}

function renderLibrary() {
  library.innerHTML = "";
  state.images.forEach((item, idx) => {
    const el = document.createElement("div");
    el.className = `thumb ${idx === state.active ? "active" : ""}`;
    el.innerHTML = `<img src="${item.url}" alt="thumb" loading="lazy" decoding="async" draggable="false"><div><strong>${item.name}</strong><p>${item.width}x${item.height}</p></div><button class="thumb-delete" data-index="${idx}">Delete</button>`;
    el.onclick = () => {
      state.active = idx;
      renderLibrary();
      loadActive();
    };
    library.appendChild(el);
  });

  library.querySelectorAll(".thumb-delete").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = Number(btn.dataset.index);
      deleteImageAt(idx);
    });
  });
  statImages.textContent = String(state.images.length);
}

function deleteImageAt(idx) {
  if (Number.isNaN(idx) || idx < 0 || idx >= state.images.length) return;
  const item = state.images[idx];
  if (item?.url && typeof item.url === "string" && item.url.startsWith("blob:")) {
    try { URL.revokeObjectURL(item.url); } catch (_) {}
  }
  state.images.splice(idx, 1);
  addChangeHistory(`Deleted image: ${item?.name || "unknown"}.`);

  if (!state.images.length) {
    state.active = -1;
    library.innerHTML = "";
    statImages.textContent = "0";
    statActive.textContent = "None";
    statRes.textContent = "-";
    metadata.textContent = "";
    octx.clearRect(0, 0, origCanvas.width, origCanvas.height);
    ectx.clearRect(0, 0, editCanvas.width, editCanvas.height);
    clearBackgroundToolPreview();
    if (imageSizeInfo) imageSizeInfo.textContent = "-";
    return;
  }

  if (state.active >= state.images.length) state.active = state.images.length - 1;
  renderLibrary();
  loadActive();
}

function updateMetadata(imgObj) {
  if (!imgObj) {
    metadata.textContent = "";
    return;
  }
  const ratio = (imgObj.working.width / imgObj.working.height).toFixed(3);
  metadata.textContent =
    `Name: ${imgObj.name}\n` +
    `Type: ${imgObj.type || "unknown"}\n` +
    `Size: ${imgObj.file?.size || 0} bytes\n` +
    `Resolution: ${imgObj.working.width} x ${imgObj.working.height}\n` +
    `Aspect Ratio: ${ratio}:1\n` +
    `Color Mode: RGB`;
}

function fitStageSize(w, h) {
  if (!w || !h) return { w: 1, h: 1 };
  const stage = document.getElementById("canvasStage");
  const stageWidth = stage ? Math.max(240, stage.clientWidth - 24) : window.innerWidth * 0.55;
  const viewportW = window.innerWidth < 760 ? window.innerWidth * 0.9 : window.innerWidth * 0.55;
  const maxW = Math.min(stageWidth, viewportW, 980);
  const maxH = window.innerWidth < 760 ? Math.min(window.innerHeight * 0.45, 420) : Math.min(window.innerHeight * 0.62, 620);
  const ratio = Math.min(maxW / w, maxH / h, 1);
  return { w: Math.round(w * ratio), h: Math.round(h * ratio) };
}

function drawCanvases() {
  const imgObj = activeImage();
  if (!imgObj) return;

  const z = Number(document.getElementById("zoom").value) / 100;
  const { w, h } = fitStageSize(imgObj.working.width, imgObj.working.height);
  const showW = Math.round(w * z);
  const showH = Math.round(h * z);

  origCanvas.width = editCanvas.width = showW;
  origCanvas.height = editCanvas.height = showH;

  octx.clearRect(0, 0, showW, showH);
  ectx.clearRect(0, 0, showW, showH);

  octx.drawImage(imgObj.original, 0, 0, showW, showH);
  ectx.drawImage(imgObj.working, 0, 0, showW, showH);
  editedWrap.style.width = "100%";

  statActive.textContent = imgObj.name;
  statRes.textContent = `${imgObj.working.width} x ${imgObj.working.height}`;
  statZoom.textContent = `${Math.round(z * 100)}%`;
  updateMetadata(imgObj);
  drawHistogram(imgObj.working);
  renderBackgroundToolPreview();
  queueActiveImageSizeRefresh(140);

  document.getElementById("resizeW").value = imgObj.working.width;
  document.getElementById("resizeH").value = imgObj.working.height;
}

function drawHistogram(canvas) {
  if (!histCanvas) return;
  const ctx = histCanvas.getContext("2d");
  const w = histCanvas.width;
  const h = histCanvas.height;
  ctx.clearRect(0, 0, w, h);

  const binsR = new Array(64).fill(0);
  const binsG = new Array(64).fill(0);
  const binsB = new Array(64).fill(0);
  const data = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;

  for (let i = 0; i < data.length; i += 16) {
    binsR[Math.floor(data[i] / 4)]++;
    binsG[Math.floor(data[i + 1] / 4)]++;
    binsB[Math.floor(data[i + 2] / 4)]++;
  }

  const maxVal = Math.max(...binsR, ...binsG, ...binsB, 1);
  const draw = (arr, color) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    arr.forEach((v, i) => {
      const x = (i / (arr.length - 1)) * w;
      const y = h - (v / maxVal) * (h - 8);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  draw(binsR, "rgba(255,90,90,0.85)");
  draw(binsG, "rgba(80,190,120,0.85)");
  draw(binsB, "rgba(70,130,255,0.85)");
}

function clearBackgroundToolPreview() {
  state.bgTool.previewCutout = null;
  renderBackgroundToolPreview();
}

function drawCheckerboard(ctx, w, h, tile = 16) {
  for (let y = 0; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      const alt = ((x / tile + y / tile) % 2) === 0;
      ctx.fillStyle = alt ? "#eef1f8" : "#dde3f0";
      ctx.fillRect(x, y, tile, tile);
    }
  }
}

function getBackgroundFillStyle(style) {
  if (style === "white") return "#ffffff";
  if (style === "black") return "#000000";
  if (style === "purple") return "#4d28db";
  if (style === "pink") return "#f6a8aa";
  if (style === "yellow") return "#f2df80";
  return state.bgTool.customColor || "#59c5ff";
}

function drawContained(ctx, canvas, w, h) {
  const ratio = Math.min(w / canvas.width, h / canvas.height);
  const dw = Math.round(canvas.width * ratio);
  const dh = Math.round(canvas.height * ratio);
  const x = Math.round((w - dw) / 2);
  const y = Math.round((h - dh) / 2);
  ctx.drawImage(canvas, x, y, dw, dh);
}

function renderBackgroundToolPreview() {
  if (!bgPreviewCanvas) return;
  const imgObj = activeImage();
  const ctx = bgPreviewCanvas.getContext("2d", { willReadFrequently: true });
  const w = bgPreviewCanvas.width;
  const h = bgPreviewCanvas.height;
  ctx.clearRect(0, 0, w, h);

  if (!imgObj) return;
  const style = state.bgTool.style;
  const view = state.bgTool.view;
  const cutout = state.bgTool.previewCutout;
  const source = view === "after" && cutout ? cutout : imgObj.working;

  if (style === "transparent") {
    drawCheckerboard(ctx, w, h, 18);
  } else {
    ctx.fillStyle = getBackgroundFillStyle(style);
    ctx.fillRect(0, 0, w, h);
  }
  drawContained(ctx, source, w, h);
}

function loadActive() {
  const imgObj = activeImage();
  if (!imgObj) return;
  clearBackgroundToolPreview();
  if (!imgObj.undoStack || !imgObj.redoStack) initHistory(imgObj);
  state.filter = { brightness: 100, contrast: 100, saturation: 100, sharpness: 0, blur: 0, denoise: 0, motionBlur: 0 };
  setFilterInputs();
  drawCanvases();
}

function setFilterInputs() {
  document.getElementById("brightness").value = state.filter.brightness;
  document.getElementById("contrast").value = state.filter.contrast;
  document.getElementById("saturation").value = state.filter.saturation;
  document.getElementById("sharpness").value = state.filter.sharpness;
  document.getElementById("blur").value = state.filter.blur;
  document.getElementById("denoise").value = state.filter.denoise;
  document.getElementById("motionBlur").value = state.filter.motionBlur;
}

function activateTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((t) => t.classList.remove("active"));
  const btn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
  const tab = document.getElementById(tabId);
  if (btn && tab) {
    btn.classList.add("active");
    tab.classList.add("active");
  }
}

function animateStage() {
  const stage = document.getElementById("canvasStage");
  stage.classList.remove("motion");
  void stage.offsetWidth;
  stage.classList.add("motion");
}

function commit(newCanvas) {
  const imgObj = activeImage();
  if (!imgObj) return;
  pushUndoState(imgObj);
  imgObj.working = canvasCopy(newCanvas);
  imgObj.width = imgObj.working.width;
  imgObj.height = imgObj.working.height;
  imgObj.file = null;
  const action = state.pendingActionLabel || "Edit";
  addChangeHistory(`${action} applied on ${imgObj.name} (${imgObj.width}x${imgObj.height}).`);
  renderLibrary();
  drawCanvases();
  animateStage();
}

function applyAdjustmentsToCanvas(src) {
  const out = document.createElement("canvas");
  out.width = src.width;
  out.height = src.height;
  const ctx = out.getContext("2d", { willReadFrequently: true });
  const f = state.filter;

  ctx.filter = `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturation}%)`;
  ctx.drawImage(src, 0, 0);
  ctx.filter = "none";

  if (f.blur > 0) boxBlur(out, f.blur);
  if (f.sharpness > 0) unsharpMask(out, f.sharpness);
  if (f.denoise > 0) boxBlur(out, f.denoise);
  if (f.motionBlur > 0) motionBlur(out, f.motionBlur);
  return out;
}

function convolveInPlace(canvas, kernel) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const src = ctx.getImageData(0, 0, width, height);
  const dst = ctx.createImageData(width, height);
  const side = 3;
  const half = 1;
  const s = src.data;
  const d = dst.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < side; ky++) {
        for (let kx = 0; kx < side; kx++) {
          const px = clamp(x + kx - half, 0, width - 1);
          const py = clamp(y + ky - half, 0, height - 1);
          const poff = (py * width + px) * 4;
          const wt = kernel[ky * side + kx];
          r += s[poff] * wt;
          g += s[poff + 1] * wt;
          b += s[poff + 2] * wt;
        }
      }
      d[off] = clamp(r, 0, 255);
      d[off + 1] = clamp(g, 0, 255);
      d[off + 2] = clamp(b, 0, 255);
      d[off + 3] = s[off + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

function unsharpMask(canvas, amount) {
  const srcCanvas = canvasCopy(canvas);
  const blurCanvas = canvasCopy(canvas);
  const radius = Math.max(1, Math.round(amount / 25) + 1);
  const strength = clamp(amount / 55, 0, 1.85);
  boxBlur(blurCanvas, radius);

  const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const blurCtx = blurCanvas.getContext("2d", { willReadFrequently: true });
  const dstCtx = canvas.getContext("2d", { willReadFrequently: true });

  const srcData = srcCtx.getImageData(0, 0, canvas.width, canvas.height);
  const blurData = blurCtx.getImageData(0, 0, canvas.width, canvas.height);
  const out = dstCtx.createImageData(canvas.width, canvas.height);
  const s = srcData.data;
  const b = blurData.data;
  const d = out.data;

  for (let i = 0; i < s.length; i += 4) {
    d[i] = clamp(s[i] + (s[i] - b[i]) * strength, 0, 255);
    d[i + 1] = clamp(s[i + 1] + (s[i + 1] - b[i + 1]) * strength, 0, 255);
    d[i + 2] = clamp(s[i + 2] + (s[i + 2] - b[i + 2]) * strength, 0, 255);
    d[i + 3] = s[i + 3];
  }
  dstCtx.putImageData(out, 0, 0);
}

function boxBlur(canvas, radius) {
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  ctx.filter = `blur(${radius}px)`;
  ctx.drawImage(canvas, 0, 0);
  canvas.getContext("2d").drawImage(out, 0, 0);
}

function motionBlur(canvas, amount) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width, height } = canvas;
  const src = ctx.getImageData(0, 0, width, height);
  const dst = ctx.createImageData(width, height);
  const d = dst.data;
  const s = src.data;
  const n = Math.max(1, Math.floor(amount / 2));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      let r = 0, g = 0, b = 0, c = 0;
      for (let i = -n; i <= n; i++) {
        const px = clamp(x + i, 0, width - 1);
        const poff = (y * width + px) * 4;
        r += s[poff];
        g += s[poff + 1];
        b += s[poff + 2];
        c++;
      }
      d[off] = r / c;
      d[off + 1] = g / c;
      d[off + 2] = b / c;
      d[off + 3] = s[off + 3];
    }
  }
  ctx.putImageData(dst, 0, 0);
}

function applyFilterPreview() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const z = Number(document.getElementById("zoom").value) / 100;
  const { w, h } = fitStageSize(imgObj.working.width, imgObj.working.height);
  const showW = Math.round(w * z);
  const showH = Math.round(h * z);

  // Process a downscaled preview while dragging sliders for smoother interaction.
  const previewMaxSide = Math.max(720, Math.min(1400, Math.round(Math.max(showW, showH) * 1.7)));
  const previewBase = downscaleForAI(imgObj.working, previewMaxSide);
  const temp = applyAdjustmentsToCanvas(previewBase);

  editCanvas.width = showW;
  editCanvas.height = showH;
  ectx.clearRect(0, 0, showW, showH);
  ectx.drawImage(temp, 0, 0, showW, showH);
}

function queueFilterPreview() {
  if (filterPreviewTimer) return;
  filterPreviewTimer = setTimeout(() => {
    filterPreviewTimer = null;
    applyFilterPreview();
  }, 34);
}

function queueDrawCanvases() {
  if (drawFrame) return;
  drawFrame = requestAnimationFrame(() => {
    drawFrame = null;
    drawCanvases();
  });
}

function applyCurrentLook() {
  const imgObj = activeImage();
  if (!imgObj) return;
  commit(applyAdjustmentsToCanvas(imgObj.working));
  state.filter = { brightness: 100, contrast: 100, saturation: 100, sharpness: 0, blur: 0, denoise: 0, motionBlur: 0 };
  setFilterInputs();
}

function resizeImage() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const w = Math.max(1, Number(document.getElementById("resizeW").value || imgObj.working.width));
  const h = Math.max(1, Number(document.getElementById("resizeH").value || imgObj.working.height));
  const keep = document.getElementById("keepRatio").checked;
  let tw = w, th = h;
  if (keep) {
    const r = Math.min(w / imgObj.working.width, h / imgObj.working.height);
    tw = Math.round(imgObj.working.width * r);
    th = Math.round(imgObj.working.height * r);
  }
  const out = document.createElement("canvas");
  out.width = tw;
  out.height = th;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imgObj.working, 0, 0, tw, th);
  commit(out);
}

function resizeByPercent() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const percent = Number(document.getElementById("resizePercent").value || 100) / 100;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(imgObj.working.width * percent));
  out.height = Math.max(1, Math.round(imgObj.working.height * percent));
  out.getContext("2d").drawImage(imgObj.working, 0, 0, out.width, out.height);
  commit(out);
}

function resizeByPreset() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const val = document.getElementById("sizePreset").value;
  if (!val) return;
  const [w, h] = val.split("x").map(Number);
  if (!w || !h) return;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d").drawImage(imgObj.working, 0, 0, w, h);
  commit(out);
}

async function compressToTargetBlob(canvas, mime, targetKB) {
  const targetBytes = Math.max(1024, Math.round(targetKB * 1024));
  if (mime === "image/png") {
    let work = canvas;
    let blob = await canvasToBlobStrict(work, mime, 1);
    let guard = 0;
    while (blob.size > targetBytes && guard < 8) {
      const scaled = document.createElement("canvas");
      scaled.width = Math.max(1, Math.round(work.width * 0.92));
      scaled.height = Math.max(1, Math.round(work.height * 0.92));
      scaled.getContext("2d").drawImage(work, 0, 0, scaled.width, scaled.height);
      work = scaled;
      blob = await canvasToBlobStrict(work, mime, 1);
      guard++;
    }
    return blob;
  }

  const findClosestBlob = async (workCanvas) => {
    let lo = 0.02;
    let hi = 1;
    let bestBlob = await canvasToBlobStrict(workCanvas, mime, hi);
    let bestDiff = Math.abs(bestBlob.size - targetBytes);

    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const blob = await canvasToBlobStrict(workCanvas, mime, mid);
      const diff = Math.abs(blob.size - targetBytes);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestBlob = blob;
      }
      if (blob.size > targetBytes) hi = mid;
      else lo = mid;
    }

    const qCenter = (lo + hi) / 2;
    for (const q of [qCenter - 0.03, qCenter, qCenter + 0.03]) {
      const qq = clamp(q, 0.02, 1);
      const blob = await canvasToBlobStrict(workCanvas, mime, qq);
      const diff = Math.abs(blob.size - targetBytes);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestBlob = blob;
      }
    }
    return bestBlob;
  };

  let work = canvas;
  let bestBlob = await findClosestBlob(work);
  let guard = 0;
  while (bestBlob.size > targetBytes && guard < 8) {
    const scaled = document.createElement("canvas");
    scaled.width = Math.max(1, Math.round(work.width * 0.92));
    scaled.height = Math.max(1, Math.round(work.height * 0.92));
    scaled.getContext("2d").drawImage(work, 0, 0, scaled.width, scaled.height);
    work = scaled;
    bestBlob = await findClosestBlob(work);
    guard++;
  }

  return bestBlob;
}

async function previewCompression() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const targetKB = Math.max(5, Number(document.getElementById("compressTargetKb").value || 200));
  const mime = document.getElementById("compressFormat").value || "image/jpeg";
  const outBlob = await compressToTargetBlob(imgObj.working, mime, targetKB);
  const delta = imgObj.file?.size ? (((outBlob.size - imgObj.file.size) / imgObj.file.size) * 100).toFixed(1) : null;
  toast(
    `Compression preview: ${(outBlob.size / 1024).toFixed(1)} KB (${mime.split("/")[1].toUpperCase()})` +
      (delta ? ` | ${delta}% vs original file` : "")
  );
}

async function applyCompression() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const targetKB = Math.max(5, Number(document.getElementById("compressTargetKb").value || 200));
  const mime = document.getElementById("compressFormat").value || "image/jpeg";
  const outBlob = await compressToTargetBlob(imgObj.working, mime, targetKB);
  const outCanvas = await blobToCanvas(outBlob);
  commit(outCanvas);
  const active = activeImage();
  if (active) {
    const ext = extFromMime(mime);
    const base = active.name.replace(/\.[^.]+$/, "");
    active.name = `${base}.${ext}`;
    active.type = mime;
    active.file = new File([outBlob], active.name, { type: mime });
  }
  const exportFormat = document.getElementById("format");
  if (exportFormat) exportFormat.value = mime;
  queueActiveImageSizeRefresh(20);
  toast(`Compression applied: ${(outBlob.size / 1024).toFixed(1)} KB output.`);
}

async function increaseImageSize() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const targetKB = Math.max(20, Number(document.getElementById("increaseTargetKb").value || 400));
  const stepPercent = clamp(Number(document.getElementById("increaseStepPercent").value || 15), 5, 100);
  const scaleStep = 1 + stepPercent / 100;
  const mime = document.getElementById("compressFormat").value || "image/jpeg";
  const targetBytes = targetKB * 1024;

  let work = canvasCopy(imgObj.working);
  let blob = await canvasToBlobStrict(work, mime, 1);
  if (blob.size >= targetBytes) {
    toast(`Current image is already ${(blob.size / 1024).toFixed(1)} KB (>= target).`);
    return;
  }

  for (let i = 0; i < 12 && blob.size < targetBytes; i++) {
    const next = document.createElement("canvas");
    next.width = Math.max(1, Math.round(work.width * scaleStep));
    next.height = Math.max(1, Math.round(work.height * scaleStep));
    if (Math.max(next.width, next.height) > 9000) break;
    const ctx = next.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(work, 0, 0, next.width, next.height);
    work = next;
    blob = await canvasToBlobStrict(work, mime, 1);
  }

  const finalBlob = blob;
  commit(work);
  const active = activeImage();
  if (active) {
    const ext = extFromMime(mime);
    const base = active.name.replace(/\.[^.]+$/, "");
    active.name = `${base}.${ext}`;
    active.type = mime;
    active.file = new File([finalBlob], active.name, { type: mime });
  }
  const exportFormat = document.getElementById("format");
  if (exportFormat) exportFormat.value = mime;
  queueActiveImageSizeRefresh(20);
  toast(`Size increase complete: ${(finalBlob.size / 1024).toFixed(1)} KB (${work.width}x${work.height}).`);
}

function rotateImage() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const deg = Number(document.getElementById("rotate").value) || 0;
  const rad = (deg * Math.PI) / 180;
  const w = imgObj.working.width;
  const h = imgObj.working.height;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.ceil(w * cos + h * sin);
  const nh = Math.ceil(h * cos + w * sin);

  const out = document.createElement("canvas");
  out.width = nw;
  out.height = nh;
  const ctx = out.getContext("2d");
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(rad);
  ctx.drawImage(imgObj.working, -w / 2, -h / 2);
  commit(out);
}

function flipImage(horizontal = true) {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = document.createElement("canvas");
  out.width = imgObj.working.width;
  out.height = imgObj.working.height;
  const ctx = out.getContext("2d");
  ctx.translate(horizontal ? out.width : 0, horizontal ? 0 : out.height);
  ctx.scale(horizontal ? -1 : 1, horizontal ? 1 : -1);
  ctx.drawImage(imgObj.working, 0, 0);
  commit(out);
}

function cropImage() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const x = Math.max(0, Number(document.getElementById("cropX").value) || 0);
  const y = Math.max(0, Number(document.getElementById("cropY").value) || 0);
  const w = Math.max(1, Number(document.getElementById("cropW").value) || imgObj.working.width);
  const h = Math.max(1, Number(document.getElementById("cropH").value) || imgObj.working.height);
  if (x >= imgObj.working.width || y >= imgObj.working.height) {
    toast("Crop start point is outside image bounds.");
    return;
  }
  const cw = Math.max(1, Math.min(w, imgObj.working.width - x));
  const ch = Math.max(1, Math.min(h, imgObj.working.height - y));
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  out.getContext("2d").drawImage(imgObj.working, x, y, cw, ch, 0, 0, cw, ch);
  commit(out);
}

function effect(type) {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = canvasCopy(imgObj.working);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, out.width, out.height);
  const p = data.data;

  if (type === "blur") {
    boxBlur(out, 6);
    commit(out);
    return;
  }

  if (type === "bw" || type === "sepia" || type === "vintage") {
    for (let i = 0; i < p.length; i += 4) {
      const r = p[i], g = p[i + 1], b = p[i + 2];
      if (type === "bw") {
        const v = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        p[i] = p[i + 1] = p[i + 2] = v;
      } else {
        const nr = clamp(0.393 * r + 0.769 * g + 0.189 * b, 0, 255);
        const ng = clamp(0.349 * r + 0.686 * g + 0.168 * b, 0, 255);
        const nb = clamp(0.272 * r + 0.534 * g + 0.131 * b, 0, 255);
        p[i] = nr;
        p[i + 1] = ng;
        p[i + 2] = nb;
        if (type === "vintage") {
          const vignetteBoost = 0.94;
          p[i] = clamp(p[i] * vignetteBoost + 12, 0, 255);
          p[i + 1] = clamp(p[i + 1] * 0.9 - 4, 0, 255);
          p[i + 2] = clamp(p[i + 2] * 0.82 - 10, 0, 255);
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    if (type === "vintage") {
      const ov = ctx.createLinearGradient(0, 0, out.width, out.height);
      ov.addColorStop(0, "rgba(90,40,20,0.12)");
      ov.addColorStop(1, "rgba(20,30,50,0.16)");
      ctx.fillStyle = ov;
      ctx.fillRect(0, 0, out.width, out.height);
    }
    commit(out);
    return;
  }

  if (type === "cartoon") {
    const gray = new Float32Array(out.width * out.height);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      p[i] = Math.round(p[i] / 36) * 36;
      p[i + 1] = Math.round(p[i + 1] / 36) * 36;
      p[i + 2] = Math.round(p[i + 2] / 36) * 36;
      gray[j] = 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];
    }
    for (let y = 1; y < out.height - 1; y++) {
      for (let x = 1; x < out.width - 1; x++) {
        const i = y * out.width + x;
        const gx = -gray[i - out.width - 1] - 2 * gray[i - 1] - gray[i + out.width - 1] + gray[i - out.width + 1] + 2 * gray[i + 1] + gray[i + out.width + 1];
        const gy = -gray[i - out.width - 1] - 2 * gray[i - out.width] - gray[i - out.width + 1] + gray[i + out.width - 1] + 2 * gray[i + out.width] + gray[i + out.width + 1];
        const edge = Math.sqrt(gx * gx + gy * gy);
        if (edge > 110) {
          const off = i * 4;
          p[off] = p[off + 1] = p[off + 2] = 25;
        }
      }
    }
    ctx.putImageData(data, 0, 0);
    commit(out);
    return;
  }

  if (type === "sketch") {
    const gray = new Uint8ClampedArray(out.width * out.height);
    for (let i = 0, j = 0; i < p.length; i += 4, j++) gray[j] = clamp(0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2], 0, 255);
    const inv = gray.map((v) => 255 - v);

    const blur = new Uint8ClampedArray(inv.length);
    for (let y = 1; y < out.height - 1; y++) {
      for (let x = 1; x < out.width - 1; x++) {
        let sum = 0;
        for (let ky = -1; ky <= 1; ky++) {
          for (let kx = -1; kx <= 1; kx++) sum += inv[(y + ky) * out.width + (x + kx)];
        }
        blur[y * out.width + x] = sum / 9;
      }
    }
    for (let i = 0, j = 0; i < p.length; i += 4, j++) {
      const denom = Math.max(1, 255 - blur[j]);
      const v = clamp((gray[j] * 255) / denom, 0, 255);
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);
    commit(out);
    return;
  }

  ctx.putImageData(data, 0, 0);
  commit(out);
}

function autoEnhance() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = canvasCopy(imgObj.working);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const d = image.data;
  let min = 255, max = 0;

  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    min = Math.min(min, l);
    max = Math.max(max, l);
  }
  const range = Math.max(1, max - min);
  for (let i = 0; i < d.length; i += 4) {
    d[i] = clamp(((d[i] - min) / range) * 255, 0, 255);
    d[i + 1] = clamp(((d[i + 1] - min) / range) * 255, 0, 255);
    d[i + 2] = clamp(((d[i + 2] - min) / range) * 255, 0, 255);
  }
  ctx.putImageData(image, 0, 0);
  commit(out);
}

function extractPalette() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const ctx = imgObj.working.getContext("2d", { willReadFrequently: true });
  const data = ctx.getImageData(0, 0, imgObj.working.width, imgObj.working.height).data;
  const bins = new Map();
  for (let i = 0; i < data.length; i += 4 * 5) {
    const r = data[i] >> 4;
    const g = data[i + 1] >> 4;
    const b = data[i + 2] >> 4;
    const k = `${r},${g},${b}`;
    bins.set(k, (bins.get(k) || 0) + 1);
  }
  const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const wrap = document.getElementById("palette");
  wrap.innerHTML = "";
  top.forEach(([k]) => {
    const [r, g, b] = k.split(",").map((x) => Number(x) * 16);
    const el = document.createElement("div");
    const hex = `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
    el.className = "swatch";
    el.title = hex;
    el.style.background = hex;
    wrap.appendChild(el);
  });
}

function applyWatermark() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = canvasCopy(imgObj.working);
  const ctx = out.getContext("2d");
  const text = document.getElementById("wmText").value.trim();
  const alpha = Number(document.getElementById("wmOpacity").value) / 100;

  if (state.logo) {
    const w = Math.round(out.width * 0.18);
    const h = Math.round((state.logo.height / state.logo.width) * w);
    ctx.globalAlpha = alpha;
    ctx.drawImage(state.logo, out.width - w - 18, out.height - h - 16, w, h);
    ctx.globalAlpha = 1;
  }
  if (text) {
    ctx.globalAlpha = alpha;
    ctx.font = `700 ${Math.max(18, out.width * 0.03)}px Arial`;
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.fillStyle = "white";
    const x = 18;
    const y = out.height - 22;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    ctx.globalAlpha = 1;
  }
  commit(out);
}

function createMeme() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const top = document.getElementById("memeTop").value.toUpperCase();
  const bottom = document.getElementById("memeBottom").value.toUpperCase();
  const out = canvasCopy(imgObj.working);
  const ctx = out.getContext("2d");
  const size = Math.max(24, out.width * 0.065);
  ctx.font = `900 ${size}px Impact, Arial Black, sans-serif`;
  ctx.fillStyle = "white";
  ctx.strokeStyle = "black";
  ctx.lineWidth = Math.max(2, size * 0.08);
  ctx.textAlign = "center";
  if (top) {
    ctx.strokeText(top, out.width / 2, size + 14);
    ctx.fillText(top, out.width / 2, size + 14);
  }
  if (bottom) {
    ctx.strokeText(bottom, out.width / 2, out.height - 20);
    ctx.fillText(bottom, out.width / 2, out.height - 20);
  }
  commit(out);
}

function addTextOverlay() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const text = document.getElementById("addText").value.trim();
  if (!text) {
    toast("Enter text first.");
    return;
  }
  const size = Number(document.getElementById("textSize").value || 48);
  const color = document.getElementById("textColor").value || "#ffffff";

  const out = canvasCopy(imgObj.working);
  const ctx = out.getContext("2d");
  ctx.font = `700 ${size}px Sora, Arial, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = Math.max(2, size * 0.06);
  ctx.strokeText(text, out.width / 2, out.height / 2);
  ctx.fillText(text, out.width / 2, out.height / 2);
  commit(out);
}

async function ensureAISegmenter() {
  if (aiSegmenter) return aiSegmenter;
  if (typeof SelfieSegmentation === "undefined") {
    throw new Error("AI segmentation library not available");
  }
  aiSegmenter = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
  });
  aiSegmenter.setOptions({ modelSelection: 1 });
  return aiSegmenter;
}

async function warmupAISegmenter(segmenter) {
  if (aiSegmenterReady) return;
  const tiny = document.createElement("canvas");
  tiny.width = 64;
  tiny.height = 64;
  const tctx = tiny.getContext("2d");
  tctx.fillStyle = "#ffffff";
  tctx.fillRect(0, 0, 64, 64);
  const tinyImg = await canvasToImageEl(tiny);
  await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("AI warmup timeout")), 45000);
    segmenter.onResults(() => {
      clearTimeout(to);
      aiSegmenterReady = true;
      resolve();
    });
    segmenter.send({ image: tinyImg }).catch((err) => {
      clearTimeout(to);
      reject(err);
    });
  });
}

function downscaleForAI(canvas, maxSide = 1280) {
  const w = canvas.width;
  const h = canvas.height;
  const maxDim = Math.max(w, h);
  if (maxDim <= maxSide) return canvas;
  const scale = maxSide / maxDim;
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return out;
}

function canvasToImageEl(canvas) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = canvas.toDataURL("image/png");
  });
}

async function buildAICutoutCanvas(srcCanvas) {
  if (!srcCanvas) throw new Error("No source image");
  const segmenter = await ensureAISegmenter();
  await warmupAISegmenter(segmenter);
  const inferenceCanvas = downscaleForAI(srcCanvas, 1280);
  const imageEl = await canvasToImageEl(inferenceCanvas);
  const results = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("AI segmentation timed out")), 45000);
    segmenter.onResults((res) => {
      clearTimeout(timeout);
      resolve(res);
    });
    segmenter.send({ image: imageEl }).catch((err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  const out = canvasCopy(srcCanvas);
  const outCtx = out.getContext("2d", { willReadFrequently: true });
  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = out.width;
  maskCanvas.height = out.height;
  const mctx = maskCanvas.getContext("2d", { willReadFrequently: true });
  mctx.drawImage(results.segmentationMask, 0, 0, maskCanvas.width, maskCanvas.height);

  const imgData = outCtx.getImageData(0, 0, out.width, out.height);
  const maskData = mctx.getImageData(0, 0, out.width, out.height).data;
  for (let i = 0; i < imgData.data.length; i += 4) {
    const score = maskData[i];
    imgData.data[i + 3] = score > 120 ? 255 : 0;
  }
  outCtx.putImageData(imgData, 0, 0);
  return out;
}

async function removeBackgroundAI(apply = true) {
  const imgObj = activeImage();
  if (!imgObj) return;
  toast("Running AI background remover...");

  try {
    const out = await buildAICutoutCanvas(imgObj.working);
    state.bgTool.previewCutout = out;
    renderBackgroundToolPreview();
    if (apply) {
      commit(out);
      toast("AI background removal complete.");
    } else {
      toast("Cutout preview ready.");
    }
  } catch (err) {
    console.warn("AI remover failed, using fallback:", err);
    const out = removeBackgroundHeuristicCanvas(imgObj.working);
    state.bgTool.previewCutout = out;
    renderBackgroundToolPreview();
    if (apply) {
      commit(out);
      toast(`AI remover failed (${err?.message || "unknown"}). Fallback remover applied.`);
    } else {
      toast(`AI remover failed (${err?.message || "unknown"}). Fallback preview ready.`);
    }
  }
}

function removeBackgroundHeuristicCanvas(srcCanvas) {
  const out = canvasCopy(srcCanvas);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  const image = ctx.getImageData(0, 0, out.width, out.height);
  const d = image.data;
  const w = out.width;
  const h = out.height;
  const visited = new Uint8Array(w * h);
  const queue = new Uint32Array(w * h);
  let head = 0;
  let tail = 0;

  // Build border color model for adaptive thresholding
  const border = [];
  const stepX = Math.max(1, Math.floor(w / 80));
  const stepY = Math.max(1, Math.floor(h / 80));
  for (let x = 0; x < w; x += stepX) {
    border.push((0 * w + x) * 4, ((h - 1) * w + x) * 4);
  }
  for (let y = 0; y < h; y += stepY) {
    border.push((y * w + 0) * 4, (y * w + (w - 1)) * 4);
  }
  let sr = 0, sg = 0, sb = 0;
  for (const off of border) {
    sr += d[off];
    sg += d[off + 1];
    sb += d[off + 2];
  }
  const n = Math.max(1, border.length);
  const mr = sr / n, mg = sg / n, mb = sb / n;
  let vr = 0, vg = 0, vb = 0;
  for (const off of border) {
    vr += (d[off] - mr) ** 2;
    vg += (d[off + 1] - mg) ** 2;
    vb += (d[off + 2] - mb) ** 2;
  }
  const sigma = Math.sqrt((vr + vg + vb) / n);
  const tolSq = clamp((sigma * 2.5 + 34) ** 2, 35 ** 2, 120 ** 2);

  const push = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return;
    const idx = y * w + x;
    if (visited[idx]) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < w; x += Math.max(1, Math.floor(w / 40))) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 40))) {
    push(0, y);
    push(w - 1, y);
  }

  while (head < tail) {
    const idx = queue[head++];
    const x = idx % w;
    const y = Math.floor(idx / w);
    const off = idx * 4;
    const r = d[off];
    const g = d[off + 1];
    const b = d[off + 2];

    const distSq = (r - mr) * (r - mr) + (g - mg) * (g - mg) + (b - mb) * (b - mb);
    if (distSq > tolSq) continue;
    d[off + 3] = 0;

    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  // Keep only the largest connected opaque component as foreground.
  const fgVisited = new Uint8Array(w * h);
  let bestStart = -1;
  let bestSize = 0;
  const q2 = new Uint32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (fgVisited[i]) continue;
    if (d[i * 4 + 3] === 0) {
      fgVisited[i] = 1;
      continue;
    }
    let h2 = 0, t2 = 0, size = 0;
    q2[t2++] = i;
    fgVisited[i] = 1;
    while (h2 < t2) {
      const id = q2[h2++];
      size++;
      const x = id % w;
      const y = Math.floor(id / w);
      const nbr = [id - 1, id + 1, id - w, id + w];
      if (x === 0) nbr[0] = -1;
      if (x === w - 1) nbr[1] = -1;
      if (y === 0) nbr[2] = -1;
      if (y === h - 1) nbr[3] = -1;
      for (const nb of nbr) {
        if (nb < 0 || nb >= w * h || fgVisited[nb]) continue;
        fgVisited[nb] = 1;
        if (d[nb * 4 + 3] !== 0) q2[t2++] = nb;
      }
    }
    if (size > bestSize) {
      bestSize = size;
      bestStart = i;
    }
  }

  if (bestStart >= 0) {
    const keep = new Uint8Array(w * h);
    let h3 = 0, t3 = 0;
    q2[t3++] = bestStart;
    keep[bestStart] = 1;
    while (h3 < t3) {
      const id = q2[h3++];
      const x = id % w;
      const y = Math.floor(id / w);
      const nbr = [id - 1, id + 1, id - w, id + w];
      if (x === 0) nbr[0] = -1;
      if (x === w - 1) nbr[1] = -1;
      if (y === 0) nbr[2] = -1;
      if (y === h - 1) nbr[3] = -1;
      for (const nb of nbr) {
        if (nb < 0 || nb >= w * h || keep[nb] || d[nb * 4 + 3] === 0) continue;
        keep[nb] = 1;
        q2[t3++] = nb;
      }
    }
    for (let i = 0; i < w * h; i++) if (!keep[i]) d[i * 4 + 3] = 0;
  }

  ctx.putImageData(image, 0, 0);
  return out;
}

function removeBackgroundHeuristic() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = removeBackgroundHeuristicCanvas(imgObj.working);
  state.bgTool.previewCutout = out;
  renderBackgroundToolPreview();
  commit(out);
}

function applyPreset(name) {
  const imgObj = activeImage();
  if (!imgObj) {
    toast("Upload and select an image first.");
    return;
  }

  if (name === "bw") {
    effect("bw");
    return;
  }

  const preset = {
    clean: { brightness: 105, contrast: 108, saturation: 104, sharpness: 16, blur: 0, denoise: 1, motionBlur: 0 },
    vivid: { brightness: 108, contrast: 114, saturation: 132, sharpness: 12, blur: 0, denoise: 0, motionBlur: 0 },
    cinematic: { brightness: 94, contrast: 124, saturation: 88, sharpness: 10, blur: 1, denoise: 1, motionBlur: 0 },
    soft: { brightness: 106, contrast: 92, saturation: 96, sharpness: 0, blur: 2, denoise: 3, motionBlur: 0 },
  }[name];

  if (!preset) return;
  state.filter = { ...preset };
  setFilterInputs();
  commit(applyAdjustmentsToCanvas(imgObj.working));
  state.filter = { brightness: 100, contrast: 100, saturation: 100, sharpness: 0, blur: 0, denoise: 0, motionBlur: 0 };
  setFilterInputs();
  toast(`Preset applied: ${name}`);
}

function setSimpleMode(enabled) {
  document.body.classList.toggle("simple-mode", enabled);
  if (enabled) {
    const activeTab = document.querySelector(".tab-btn.active")?.dataset.tab;
    if (activeTab === "creative" || activeTab === "smart") activateTab("basic");
  }
  toast(enabled ? "Simple mode enabled: focused essential controls." : "Advanced mode enabled.");
}

function undo() {
  const imgObj = activeImage();
  if (!imgObj || !imgObj.undoStack || imgObj.undoStack.length === 0) {
    toast("Nothing to undo.");
    return;
  }
  historyLock = true;
  imgObj.redoStack = imgObj.redoStack || [];
  imgObj.redoStack.push(canvasCopy(imgObj.working));
  imgObj.working = imgObj.undoStack.pop();
  imgObj.width = imgObj.working.width;
  imgObj.height = imgObj.working.height;
  imgObj.file = null;
  historyLock = false;
  renderLibrary();
  drawCanvases();
  queueActiveImageSizeRefresh(20);
  addChangeHistory(`Undo on ${imgObj.name}.`);
}

function redo() {
  const imgObj = activeImage();
  if (!imgObj || !imgObj.redoStack || imgObj.redoStack.length === 0) {
    toast("Nothing to redo.");
    return;
  }
  historyLock = true;
  imgObj.undoStack = imgObj.undoStack || [];
  imgObj.undoStack.push(canvasCopy(imgObj.working));
  imgObj.working = imgObj.redoStack.pop();
  imgObj.width = imgObj.working.width;
  imgObj.height = imgObj.working.height;
  imgObj.file = null;
  historyLock = false;
  renderLibrary();
  drawCanvases();
  queueActiveImageSizeRefresh(20);
  addChangeHistory(`Redo on ${imgObj.name}.`);
}

function upscale2x() {
  const imgObj = activeImage();
  if (!imgObj) return;
  const out = document.createElement("canvas");
  out.width = imgObj.working.width * 2;
  out.height = imgObj.working.height * 2;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(imgObj.working, 0, 0, out.width, out.height);
  commit(out);
}

function buildCollage() {
  if (!state.images.length) return;
  const cols = Math.ceil(Math.sqrt(state.images.length));
  const cellW = 320;
  const cellH = 220;
  const rows = Math.ceil(state.images.length / cols);
  const out = document.createElement("canvas");
  out.width = cols * cellW;
  out.height = rows * cellH;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#0e2230";
  ctx.fillRect(0, 0, out.width, out.height);

  state.images.forEach((imgObj, i) => {
    const x = (i % cols) * cellW;
    const y = Math.floor(i / cols) * cellH;
    ctx.drawImage(imgObj.working, x + 4, y + 4, cellW - 8, cellH - 8);
  });

  state.images.push({
    id: uid(),
    name: `collage-${Date.now()}.png`,
    file: null,
    type: "image/png",
    url: out.toDataURL("image/png"),
    width: out.width,
    height: out.height,
    original: canvasCopy(out),
    working: canvasCopy(out),
    undoStack: [],
    redoStack: [],
  });
  state.active = state.images.length - 1;
  renderLibrary();
  loadActive();
  toast("Collage image added to library.");
}

function imageHash(canvas) {
  const size = 9;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const cx = c.getContext("2d", { willReadFrequently: true });
  cx.drawImage(canvas, 0, 0, size, size);
  const d = cx.getImageData(0, 0, size, size).data;
  const gray = [];
  for (let i = 0; i < d.length; i += 4) gray.push((d[i] + d[i + 1] + d[i + 2]) / 3);
  let bits = "";
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const a = gray[y * size + x];
      const b = gray[y * size + x + 1];
      bits += a > b ? "1" : "0";
    }
  }
  return bits;
}

function hamming(a, b) {
  let dist = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) dist++;
  return dist;
}

function detectDuplicates() {
  if (state.images.length < 2) {
    toast("Need at least 2 images.");
    return;
  }
  const hashes = state.images.map((img) => ({
    name: img.name,
    hash: imageHash(img.working),
    w: img.working.width,
    h: img.working.height,
  }));
  const out = [];
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      const dist = hamming(hashes[i].hash, hashes[j].hash);
      const areaRatio = (hashes[i].w * hashes[i].h) / (hashes[j].w * hashes[j].h);
      const nearSize = areaRatio > 0.75 && areaRatio < 1.25;
      if (dist <= 10 && nearSize) out.push(`${hashes[i].name} ~ ${hashes[j].name} (distance ${dist})`);
    }
  }
  toast(out.length ? `Possible duplicates:\n${out.join("\n")}` : "No duplicates detected.");
}

function histogram(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const bins = new Array(24).fill(0);
  for (let i = 0; i < d.length; i += 4 * 4) {
    bins[Math.floor(d[i] / 32)]++;
    bins[8 + Math.floor(d[i + 1] / 32)]++;
    bins[16 + Math.floor(d[i + 2] / 32)]++;
  }
  const norm = Math.sqrt(bins.reduce((s, v) => s + v * v, 0)) || 1;
  return bins.map((v) => v / norm);
}

function similaritySearch() {
  if (state.images.length < 2 || state.active < 0) {
    toast("Need active image + at least one more image.");
    return;
  }
  const q = histogram(activeImage().working);
  const sims = state.images
    .map((img, idx) => {
      if (idx === state.active) return null;
      const h = histogram(img.working);
      let score = 0;
      for (let i = 0; i < q.length; i++) score += q[i] * h[i];
      return { name: img.name, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  if (!sims.length) {
    toast("No similar images found.");
    return;
  }
  toast(`Most similar to ${activeImage().name}:\n${sims.map((s) => `${s.name}: ${s.score.toFixed(3)}`).join("\n")}`);
}

function downloadCurrent() {
  const imgObj = activeImage();
  if (!imgObj) return;

  const format = document.getElementById("format").value;
  const ext = extFromMime(format);
  const quality = Number(document.getElementById("quality").value) / 100;
  const scale = Number(document.getElementById("exportScale").value || 1); // FIX
  const baseName = imgObj.name.replace(/\.[^.]+$/, "");

  // If the image was already compressed and no further transform/export change is requested,
  // download the exact stored bytes so size remains identical.
  if (imgObj.file && imgObj.type === format && scale === 1) {
    downloadBlob(imgObj.file, `${baseName}-edited.${ext}`);
    return;
  }

  const withLook = applyAdjustmentsToCanvas(imgObj.working);

  const exportCanvas = document.createElement("canvas");
  exportCanvas.width = Math.max(1, Math.round(withLook.width * scale));
  exportCanvas.height = Math.max(1, Math.round(withLook.height * scale));

  const ctx = exportCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  ctx.drawImage(withLook, 0, 0, exportCanvas.width, exportCanvas.height);

  exportCanvas.toBlob((blob) => {
    if (!blob) return;

    const a = document.createElement("a");
    const url = URL.createObjectURL(blob);

    a.href = url;
    a.download = `${baseName}-edited.${ext}`;

    a.click();
    URL.revokeObjectURL(url);

  }, format, quality);
}

function resetActive() {
  const imgObj = activeImage();
  if (!imgObj) return;
  pushUndoState(imgObj);
  imgObj.working = canvasCopy(imgObj.original);
  imgObj.width = imgObj.working.width;
  imgObj.height = imgObj.working.height;
  imgObj.file = null;
  state.filter = { brightness: 100, contrast: 100, saturation: 100, sharpness: 0, blur: 0, denoise: 0, motionBlur: 0 };
  setFilterInputs();
  renderLibrary();
  drawCanvases();
  queueActiveImageSizeRefresh(20);
  addChangeHistory(`Reset image: ${imgObj.name}.`);
}

function runDiagnostics() {
  const results = [];
  const test = (name, ok, detail = "") => results.push({ name, ok, detail });
  const mk = (w, h, color = "#808080") => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d");
    cx.fillStyle = color;
    cx.fillRect(0, 0, w, h);
    return c;
  };

  try {
    const base = mk(120, 80, "#6699cc");
    state.images.push({
      id: uid(),
      name: `diag-${Date.now()}.png`,
      file: null,
      type: "image/png",
      url: base.toDataURL("image/png"),
      width: base.width,
      height: base.height,
      original: canvasCopy(base),
      working: canvasCopy(base),
      undoStack: [],
      redoStack: [],
    });
    state.active = state.images.length - 1;
    renderLibrary();
    loadActive();

    document.getElementById("resizeW").value = 60;
    document.getElementById("resizeH").value = 40;
    document.getElementById("keepRatio").checked = false;
    resizeImage();
    test("Resize", activeImage().working.width === 60 && activeImage().working.height === 40, `${activeImage().working.width}x${activeImage().working.height}`);

    document.getElementById("rotate").value = 90;
    rotateImage();
    test("Rotate 90", activeImage().working.width === 40 && activeImage().working.height === 60, `${activeImage().working.width}x${activeImage().working.height}`);

    document.getElementById("cropX").value = 5;
    document.getElementById("cropY").value = 5;
    document.getElementById("cropW").value = 20;
    document.getElementById("cropH").value = 30;
    cropImage();
    test("Crop", activeImage().working.width === 20 && activeImage().working.height === 30, `${activeImage().working.width}x${activeImage().working.height}`);

    const beforeHash = imageHash(activeImage().working);
    effect("sepia");
    const afterHash = imageHash(activeImage().working);
    test("Effect Apply", beforeHash !== afterHash);

    state.filter.brightness = 125;
    const temp = applyAdjustmentsToCanvas(activeImage().working);
    test("Enhancement Pipeline", temp.width === activeImage().working.width && temp.height === activeImage().working.height);

    const a = mk(64, 64, "#111111");
    const b = mk(64, 64, "#111111");
    const c = mk(64, 64, "#ff0000");
    test("Duplicate Hash", hamming(imageHash(a), imageHash(b)) <= 2);
    test("Similarity Separation", hamming(imageHash(a), imageHash(c)) >= 3);

    extractPalette();
    test("Palette Extraction", document.getElementById("palette").children.length > 0);

    autoEnhance();
    test("Auto Enhance", activeImage().working.width > 0 && activeImage().working.height > 0);
  } catch (err) {
    test("Diagnostics Runtime", false, err?.message || "unknown");
  }

  const failed = results.filter((r) => !r.ok);
  toast(
    `Diagnostics complete: ${results.length - failed.length}/${results.length} passed.\n` +
      results.map((r) => `${r.ok ? "PASS" : "FAIL"} | ${r.name}${r.detail ? ` (${r.detail})` : ""}`).join("\n")
  );
}

function bindEvents() {
  fileInput.addEventListener("change", (e) => addFiles([...e.target.files]));

  ["dragenter", "dragover"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    });
  });
  ["dragleave", "drop"].forEach((evt) => {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    });
  });
  dropzone.addEventListener("drop", (e) => {
    addFiles([...e.dataTransfer.files]);
  });

  simpleModeToggle.addEventListener("change", () => setSimpleMode(simpleModeToggle.checked));
  if (themeToggle) {
    themeToggle.addEventListener("change", () => {
      applyTheme(themeToggle.checked ? "dark" : "light");
    });
  }

  document.getElementById("zoom").addEventListener("input", queueDrawCanvases);
  document.getElementById("format").addEventListener("change", () => queueActiveImageSizeRefresh(20));
  document.getElementById("quality").addEventListener("input", () => queueActiveImageSizeRefresh(120));
  document.getElementById("resizeW").addEventListener("input", () => {
    if (!document.getElementById("keepRatio").checked) return;
    const imgObj = activeImage();
    if (!imgObj) return;
    const rw = Number(document.getElementById("resizeW").value);
    if (!rw || rw < 1) return;
    const rh = Math.round((rw / imgObj.working.width) * imgObj.working.height);
    document.getElementById("resizeH").value = rh;
  });
  document.getElementById("resizeH").addEventListener("input", () => {
    if (!document.getElementById("keepRatio").checked) return;
    const imgObj = activeImage();
    if (!imgObj) return;
    const rh = Number(document.getElementById("resizeH").value);
    if (!rh || rh < 1) return;
    const rw = Math.round((rh / imgObj.working.height) * imgObj.working.width);
    document.getElementById("resizeW").value = rw;
  });

  ["brightness", "contrast", "saturation", "sharpness", "blur", "denoise", "motionBlur"].forEach((id) => {
    document.getElementById(id).addEventListener("input", (e) => {
      state.filter[id] = Number(e.target.value);
      queueFilterPreview();
    });
  });

  document.getElementById("applyAllBtn").onclick = safeAction("Apply look", applyCurrentLook);
  document.getElementById("resizeBtn").onclick = safeAction("Resize", resizeImage);
  document.getElementById("resizePercentBtn").onclick = safeAction("Resize percent", resizeByPercent);
  document.getElementById("sizePresetBtn").onclick = safeAction("Resize preset", resizeByPreset);
  document.getElementById("compressPreviewBtn").onclick = safeAction("Compression preview", previewCompression);
  document.getElementById("compressApplyBtn").onclick = safeAction("Compress image", applyCompression);
  document.getElementById("increaseApplyBtn").onclick = safeAction("Increase image size", increaseImageSize);
  document.getElementById("rotateBtn").onclick = safeAction("Rotate", rotateImage);
  document.getElementById("flipHBtn").onclick = safeAction("Flip horizontal", () => flipImage(true));
  document.getElementById("flipVBtn").onclick = safeAction("Flip vertical", () => flipImage(false));
  document.getElementById("cropBtn").onclick = safeAction("Crop", cropImage);

  document.querySelectorAll("[data-effect]").forEach((btn) => {
    btn.addEventListener("click", safeAction("Effect", () => effect(btn.dataset.effect)));
  });

  document.getElementById("autoEnhanceBtn").onclick = safeAction("Auto enhance", autoEnhance);
  document.getElementById("paletteBtn").onclick = safeAction("Palette", extractPalette);
  document.getElementById("histBtn").onclick = safeAction("Histogram", () => {
    const imgObj = activeImage();
    if (!imgObj) return;
    drawHistogram(imgObj.working);
    toast("Histogram refreshed.");
  });

  document.getElementById("wmBtn").onclick = safeAction("Watermark", applyWatermark);
  document.getElementById("addTextBtn").onclick = safeAction("Text overlay", addTextOverlay);
  document.getElementById("memeBtn").onclick = safeAction("Meme", createMeme);
  document.getElementById("logoInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const { img } = await readImage(file);
    state.logo = img;
  });

  document.getElementById("bgRemoveBtn").onclick = safeAction("Background remove", removeBackgroundAI);
  const bgPreviewBtn = document.getElementById("bgPreviewBtn");
  const bgApplyBtn = document.getElementById("bgApplyBtn");
  const bgDownloadBtn = document.getElementById("bgDownloadBtn");
  const bgPreviewToggle = document.getElementById("bgPreviewToggle");
  const bgCustomColor = document.getElementById("bgCustomColor");

  if (bgPreviewBtn) {
    bgPreviewBtn.onclick = safeAction("Cutout preview", () => removeBackgroundAI(false));
  }
  if (bgApplyBtn) {
    bgApplyBtn.onclick = safeAction("Apply cutout", () => {
      if (state.bgTool.previewCutout) {
        commit(state.bgTool.previewCutout);
        toast("Cutout applied.");
      } else {
        return removeBackgroundAI(true);
      }
    });
  }
  if (bgDownloadBtn) {
    bgDownloadBtn.onclick = safeAction("Download cutout", () => {
      if (!state.bgTool.previewCutout) {
        toast("Generate cutout preview first.");
        return;
      }
      state.bgTool.previewCutout.toBlob((blob) => {
        if (!blob) return;
        const imgObj = activeImage();
        const baseName = (imgObj?.name || "image").replace(/\.[^.]+$/, "");
        const a = document.createElement("a");
        const url = URL.createObjectURL(blob);
        a.href = url;
        a.download = `${baseName}-cutout.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, "image/png");
    });
  }
  document.querySelectorAll(".bg-swatch").forEach((sw) => {
    sw.addEventListener("click", () => {
      document.querySelectorAll(".bg-swatch").forEach((x) => x.classList.remove("active"));
      sw.classList.add("active");
      state.bgTool.style = sw.dataset.bgStyle || "transparent";
      renderBackgroundToolPreview();
    });
  });
  if (bgCustomColor) {
    bgCustomColor.addEventListener("input", (e) => {
      state.bgTool.customColor = e.target.value;
      state.bgTool.style = "custom";
      document.querySelectorAll(".bg-swatch").forEach((x) => x.classList.remove("active"));
      renderBackgroundToolPreview();
    });
  }
  if (bgPreviewToggle) {
    bgPreviewToggle.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        bgPreviewToggle.querySelectorAll("button").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        state.bgTool.view = btn.dataset.bgView || "before";
        renderBackgroundToolPreview();
      });
    });
  }
  document.getElementById("upscaleBtn").onclick = safeAction("Upscale", upscale2x);
  document.getElementById("collageBtn").onclick = safeAction("Collage", buildCollage);
  document.getElementById("dupeBtn").onclick = safeAction("Duplicate detection", detectDuplicates);
  document.getElementById("similarBtn").onclick = safeAction("Similarity search", similaritySearch);
  document.getElementById("diagnosticsBtn").onclick = safeAction("Diagnostics", runDiagnostics);

  document.getElementById("downloadBtn").onclick = safeAction("Download", downloadCurrent);
  document.getElementById("undoBtn").onclick = safeAction("Undo", undo);
  document.getElementById("redoBtn").onclick = safeAction("Redo", redo);
  document.getElementById("resetBtn").onclick = safeAction("Reset", resetActive);
  document.querySelectorAll("[data-preset]").forEach((btn) => {
    btn.addEventListener("click", safeAction("Preset", () => applyPreset(btn.dataset.preset)));
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.onclick = () => activateTab(btn.dataset.tab);
  });

  window.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) {
      e.preventDefault();
      redo();
    }
  });

  window.addEventListener("resize", () => {
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = null;
      drawCanvases();
    });
  });
}

bindEvents();
initTheme();
addChangeHistory("Session started. Upload images to begin editing.");
toast("Upload images to start editing.");

const footerYear = document.getElementById("footerYear");
if (footerYear) footerYear.textContent = String(new Date().getFullYear());
