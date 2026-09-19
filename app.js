import { readBarcodes } from "https://cdn.jsdelivr.net/npm/zxing-wasm@2/reader/+esm";

const $ = (id) => document.getElementById(id);
const fileInput = $("file-input");
const dropzone = $("dropzone");
const statusEl = $("status");
const preview = $("preview");
const img = $("image");
const outlines = $("outlines");
const labels = $("labels");
const results = $("results");

const SVG_NS = "http://www.w3.org/2000/svg";
let currentUrl = null;
let runId = 0;

// ---------- Input: file picker, drag-and-drop, paste ----------

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  if (file) handleImage(file);
  fileInput.value = ""; // allow re-selecting the same file
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth++;
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const file = [...(e.dataTransfer?.files ?? [])].find(isImage);
  if (file) handleImage(file);
  else showStatus("That doesn't look like an image file.", true);
});

document.addEventListener("paste", (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find(
    (i) => i.kind === "file" && i.type.startsWith("image/")
  );
  if (!item) return; // let normal text pastes through untouched
  e.preventDefault();
  handleImage(item.getAsFile());
});

dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fileInput.click();
  }
});

function isImage(file) {
  return file && file.type.startsWith("image/");
}

// ---------- Core ----------

async function handleImage(blob) {
  if (!isImage(blob)) {
    showStatus("That doesn't look like an image file.", true);
    return;
  }

  const id = ++runId;
  clearResults();
  showStatus("Scanning…");

  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentUrl = URL.createObjectURL(blob);
  img.src = currentUrl;
  preview.hidden = false;

  try {
    await img.decode();
  } catch {
    if (id !== runId) return;
    preview.hidden = true;
    showStatus("Couldn't open that image.", true);
    return;
  }

  try {
    await scan(blob, id);
  } catch (err) {
    console.error(err);
    if (id !== runId) return;
    showStatus("Something went wrong while scanning the image.", true);
  }
}

// Passes are tried in order, from cheapest to most expensive, and their results
// are merged. Codes that a plain scan misses — photos of stylized codes with
// round dots or a logo, low contrast, small codes — usually need an upscale and
// a different binarizer, so the later passes supply those.
const PASSES = [
  { scale: 1, binarizer: "LocalAverage" },
  { scale: 1, binarizer: "FixedThreshold" },
  { scale: 2, binarizer: "LocalAverage" },
  { scale: 2, binarizer: "FixedThreshold" },
  { scale: 3, binarizer: "FixedThreshold" },
  { scale: 3, binarizer: "GlobalHistogram" },
];
// Keeps an upscaled canvas from blowing up memory on big screenshots.
const MAX_PIXELS = 6e6;

async function scan(blob, id) {
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const found = new Map();
  let done = 0;

  for (const pass of PASSES) {
    const scale = Math.min(pass.scale, Math.sqrt(MAX_PIXELS / (bitmap.width * bitmap.height)));
    if (scale < pass.scale && scale <= 1 && pass.scale > 1) continue; // no room to upscale

    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const results = await readBarcodes(ctx.getImageData(0, 0, canvas.width, canvas.height), {
      formats: ["QRCode"],
      tryHarder: true,
      maxNumberOfSymbols: 255,
      binarizer: pass.binarizer,
    });
    if (id !== runId) return; // a newer image replaced this one
    done++;

    const before = found.size;
    for (const code of results) {
      if (!code.isValid || !code.text) continue;
      const scaled = rescale(code, scale);
      const b = bounds(scaled);
      const key = `${code.text}|${Math.round(b.minX / 20)}|${Math.round(b.minY / 20)}`;
      if (!found.has(key)) found.set(key, scaled);
    }

    if (found.size !== before) render(sortCodes([...found.values()]));
    showStatus(
      found.size
        ? `Found ${found.size} QR code${found.size === 1 ? "" : "s"}.` +
            (done < PASSES.length ? " Still looking…" : "")
        : "Scanning harder…"
    );
    await nextFrame(); // let the page paint between passes
    if (id !== runId) return;
  }

  bitmap.close();
  if (!found.size) showStatus("No readable QR codes found.");
  else showStatus(`Found ${found.size} QR code${found.size === 1 ? "" : "s"}.`);
}

// Map corner points from the upscaled canvas back to the image's own pixels.
function rescale(code, scale) {
  if (scale === 1) return code;
  const p = code.position;
  const div = (pt) => ({ x: pt.x / scale, y: pt.y / scale });
  return {
    ...code,
    position: {
      topLeft: div(p.topLeft), topRight: div(p.topRight),
      bottomRight: div(p.bottomRight), bottomLeft: div(p.bottomLeft),
    },
  };
}

// Number codes in reading order: top-to-bottom, then left-to-right.
function sortCodes(codes) {
  return codes.sort((a, b) => {
    const ba = bounds(a), bb = bounds(b);
    return Math.abs(ba.minY - bb.minY) > 20 ? ba.minY - bb.minY : ba.minX - bb.minX;
  });
}

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

function corners(code) {
  const p = code.position;
  return [p.topLeft, p.topRight, p.bottomRight, p.bottomLeft];
}

function bounds(code) {
  const pts = corners(code);
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// ---------- Rendering ----------

function clearResults() {
  outlines.replaceChildren();
  labels.replaceChildren();
  results.replaceChildren();
}

function render(codes) {
  clearResults();
  const w = img.naturalWidth, h = img.naturalHeight;
  outlines.setAttribute("viewBox", `0 0 ${w} ${h}`);
  outlines.setAttribute("preserveAspectRatio", "none");

  codes.forEach((code, i) => {
    const n = i + 1;
    const b = bounds(code);
    const link = safeUrl(code.text);

    // Yellow outline around the code
    const poly = document.createElementNS(SVG_NS, "polygon");
    poly.setAttribute("points", corners(code).map((p) => `${p.x},${p.y}`).join(" "));
    outlines.append(poly);

    // Yellow pill just below the code
    const label = document.createElement("div");
    label.className = "qr-label";
    label.dataset.cx = (b.minX + b.maxX) / 2 / w;
    label.style.top = `${(b.maxY / h) * 100}%`;
    label.append(makePill(code.text, link, n));
    labels.append(label);

    results.append(makeListItem(code.text, link, n));
  });
  layoutLabels();
}

// Center each label under its code without letting it spill past the image
// edges. Labels keep their text unless there isn't room — too narrow, or codes
// packed close enough that the labels would overlap — in which case they shrink
// to just their number and the full text stays in the list below.
const MIN_PILL_WIDTH = 220;
function layoutLabels() {
  const width = labels.clientWidth;
  if (!width) return;

  labels.classList.remove("compact");
  let place = () => {
    for (const label of labels.children) {
      const lw = label.offsetWidth;
      const left = Number(label.dataset.cx) * width - lw / 2;
      label.style.left = `${clamp(left, 0, Math.max(0, width - lw))}px`;
    }
  };
  place();

  if (width < MIN_PILL_WIDTH || labelsOverlap()) {
    labels.classList.add("compact");
    place();
  }
}

function labelsOverlap() {
  const rects = [...labels.children].map((l) => l.getBoundingClientRect());
  return rects.some((a, i) =>
    rects.some((b, j) => j > i && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
  );
}

new ResizeObserver(layoutLabels).observe(labels);

function makePill(text, link, n) {
  const el = link ? document.createElement("a") : document.createElement("button");
  el.className = "qr-pill";
  if (link) {
    el.href = link.href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.title = link.href;
  } else {
    el.type = "button";
    el.title = "Copy text";
    el.addEventListener("click", () => copy(text, el.querySelector(".text")));
  }
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = n;
  const span = document.createElement("span");
  span.className = "text";
  span.textContent = link ? shortUrl(link) : text;
  el.append(badge, span);
  return el;
}

function makeListItem(text, link, n) {
  const li = document.createElement("li");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = n;

  const body = document.createElement("div");
  body.className = "body";
  if (link) {
    const a = document.createElement("a");
    a.href = link.href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = link.href;
    body.append(a);
  } else {
    const span = document.createElement("span");
    span.className = "plain";
    span.textContent = text;
    body.append(span);
  }

  const btn = document.createElement("button");
  btn.className = "copy";
  btn.type = "button";
  btn.textContent = "Copy";
  btn.addEventListener("click", () => copy(text, btn));

  li.append(badge, body, btn);
  return li;
}

// ---------- Helpers ----------

// Only http(s) becomes a clickable link; javascript:, data:, etc. stay plain text.
function safeUrl(text) {
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function shortUrl(url) {
  const path = url.pathname === "/" ? "" : url.pathname;
  return url.host.replace(/^www\./, "") + path + url.search;
}

async function copy(text, feedbackEl) {
  const original = feedbackEl.textContent;
  try {
    await navigator.clipboard.writeText(text);
    feedbackEl.textContent = "Copied!";
  } catch {
    feedbackEl.textContent = "Copy failed";
  }
  setTimeout(() => (feedbackEl.textContent = original), 1200);
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function showStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}
