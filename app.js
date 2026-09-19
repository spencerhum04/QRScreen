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

  let codes;
  try {
    const found = await readBarcodes(blob, {
      formats: ["QRCode"],
      tryHarder: true,
      maxNumberOfSymbols: 255,
    });
    codes = dedupe(found.filter((c) => c.isValid && c.text));
  } catch (err) {
    console.error(err);
    if (id !== runId) return;
    showStatus("Something went wrong while scanning the image.", true);
    return;
  }
  if (id !== runId) return; // a newer image replaced this one

  // Number codes in reading order: top-to-bottom, then left-to-right.
  codes.sort((a, b) => {
    const ba = bounds(a), bb = bounds(b);
    return Math.abs(ba.minY - bb.minY) > 20 ? ba.minY - bb.minY : ba.minX - bb.minX;
  });

  render(codes);
  showStatus(
    codes.length === 0
      ? "No readable QR codes found."
      : `Found ${codes.length} QR code${codes.length === 1 ? "" : "s"}.`
  );
}

function dedupe(codes) {
  const seen = new Set();
  return codes.filter((c) => {
    const b = bounds(c);
    const key = `${c.text}|${Math.round(b.minX / 10)}|${Math.round(b.minY / 10)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
// edges. On narrow screens, show only the number badge; the list has the text.
const COMPACT_BELOW = 560;
function layoutLabels() {
  const width = labels.clientWidth;
  if (!width) return;
  labels.classList.toggle("compact", width < COMPACT_BELOW);
  for (const label of labels.children) {
    const lw = label.offsetWidth;
    const left = Number(label.dataset.cx) * width - lw / 2;
    label.style.left = `${clamp(left, 0, Math.max(0, width - lw))}px`;
  }
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
