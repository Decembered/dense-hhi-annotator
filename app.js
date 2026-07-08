const state = {
  records: [],
  filteredRecords: [],
  annotations: new Map(),
  skeletonCache: new Map(),
  featureCache: new Map(),
  excludedIds: new Set(),
  currentId: null,
  currentSkeleton: null,
  currentFeatures: null,
  frame: 0,
  selectedSegment: 0,
  playing: false,
  preparingSegment: false,
  segmentPlaybackStart: null,
  segmentPlaybackEnd: null,
  videoPlayToken: 0,
  lastTick: 0,
  dragBoundary: null,
};

const COLORS = ["#146c78", "#7a6f2a", "#8f3d56", "#2d6f43", "#6b5ca5", "#9a5a1f"];
const ROLE_COLORS = {
  Actor: "#27aee4",
  Reactor: "#f57c00",
};
const DATA_VERSION = "20260708-source-captions-v1";
const EXCLUDED_STORAGE_KEY = "dense-hhi-interactive:guideline-v2-refined:excluded-sequences";

const els = {
  statusLine: document.getElementById("statusLine"),
  searchInput: document.getElementById("searchInput"),
  categoryFilter: document.getElementById("categoryFilter"),
  sequenceStats: document.getElementById("sequenceStats"),
  sequenceList: document.getElementById("sequenceList"),
  sequenceTitle: document.getElementById("sequenceTitle"),
  sequenceMeta: document.getElementById("sequenceMeta"),
  skeletonCanvas: document.getElementById("skeletonCanvas"),
  meshVideo: document.getElementById("meshVideo"),
  renderedClip: document.getElementById("renderedClip"),
  clipBadge: document.getElementById("clipBadge"),
  signalCanvas: document.getElementById("signalCanvas"),
  loadingOverlay: document.getElementById("loadingOverlay"),
  frameSlider: document.getElementById("frameSlider"),
  frameReadout: document.getElementById("frameReadout"),
  timeReadout: document.getElementById("timeReadout"),
  timeline: document.getElementById("timeline"),
  segmentEditor: document.getElementById("segmentEditor"),
  qualityBox: document.getElementById("qualityBox"),
  sourceCaptionPanel: document.getElementById("sourceCaptionPanel"),
  playButton: document.getElementById("playButton"),
  prevFrameButton: document.getElementById("prevFrameButton"),
  nextFrameButton: document.getElementById("nextFrameButton"),
  speedSelect: document.getElementById("speedSelect"),
  splitButton: document.getElementById("splitButton"),
  deleteSegmentButton: document.getElementById("deleteSegmentButton"),
  mergePrevButton: document.getElementById("mergePrevButton"),
  mergeNextButton: document.getElementById("mergeNextButton"),
  resetCandidateButton: document.getElementById("resetCandidateButton"),
  exportButton: document.getElementById("exportButton"),
  copyButton: document.getElementById("copyButton"),
  importButton: document.getElementById("importButton"),
  importFile: document.getElementById("importFile"),
};

function storageKey(sequenceId) {
  return `dense-hhi-interactive:guideline-v2-refined:${sequenceId}`;
}

function loadExcludedIds() {
  try {
    const stored = JSON.parse(localStorage.getItem(EXCLUDED_STORAGE_KEY) || "[]");
    state.excludedIds = new Set(Array.isArray(stored) ? stored : []);
  } catch {
    state.excludedIds = new Set();
  }
}

function saveExcludedIds() {
  localStorage.setItem(EXCLUDED_STORAGE_KEY, JSON.stringify([...state.excludedIds]));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function currentRecord() {
  return state.records.find((record) => record.sequence_id === state.currentId);
}

function currentAnnotation() {
  return state.annotations.get(state.currentId);
}

function numFramesFor(record, skeleton) {
  return Number(record?.num_frames || skeleton?.num_frames || 1);
}

function normalizeAnnotation(annotation, record) {
  const numFrames = Number(record.num_frames || annotation?.num_frames || 1);
  const base = annotation ? cloneJson(annotation) : {};
  base.sequence_id = record.sequence_id;
  base.source = record.source || "Inter-X";
  base.fps = record.fps || base.fps || 30;
  base.num_frames = numFrames;
  base.category = record.category || base.category || "";
  base.global_caption = base.global_caption || record.global_caption || "";
  base.roles = cloneJson(record.roles || base.roles || {});
  let segments = Array.isArray(base.segments) ? base.segments : [];
  segments = segments
    .map((segment) => ({
      start_frame: Number.isInteger(segment.start_frame) ? segment.start_frame : 0,
      end_frame: Number.isInteger(segment.end_frame) ? segment.end_frame : 0,
      caption: String(segment.caption || ""),
    }))
    .sort((a, b) => a.start_frame - b.start_frame);
  if (!segments.length) {
    segments = [{ start_frame: 0, end_frame: numFrames - 1, caption: "" }];
  }
  segments[0].start_frame = 0;
  for (let idx = 0; idx < segments.length; idx += 1) {
    const minStart = idx === 0 ? 0 : segments[idx - 1].end_frame + 1;
    segments[idx].start_frame = clamp(segments[idx].start_frame, minStart, numFrames - 1);
    segments[idx].end_frame = clamp(segments[idx].end_frame, segments[idx].start_frame, numFrames - 1);
    if (idx < segments.length - 1) {
      const nextStart = clamp(segments[idx + 1].start_frame, segments[idx].start_frame + 1, numFrames - 1);
      segments[idx].end_frame = nextStart - 1;
    }
  }
  segments[segments.length - 1].end_frame = numFrames - 1;
  base.segments = segments.filter((segment) => segment.start_frame <= segment.end_frame);
  base.metadata = {
    ...(base.metadata || {}),
    annotation_status: "human_review_in_progress",
    annotation_tool: "interactive_annotator",
    caption_label_contract: "A=Actor, B=Reactor",
    source_person_mapping: "See roles.caption_A_source_person and roles.caption_B_source_person",
  };
  return base;
}

function loadStoredAnnotation(record) {
  const stored = localStorage.getItem(storageKey(record.sequence_id));
  if (stored) {
    try {
      return normalizeAnnotation(JSON.parse(stored), record);
    } catch (error) {
      console.warn("Ignoring invalid stored annotation", record.sequence_id, error);
    }
  }
  return normalizeAnnotation(record.candidate, record);
}

function saveCurrentAnnotation() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  localStorage.setItem(storageKey(annotation.sequence_id), JSON.stringify(annotation));
}

function statusFor(annotation) {
  const warnings = warningsForAnnotation(annotation);
  if (!annotation || !Array.isArray(annotation.segments)) return "issue";
  if (warnings.length) return "issue";
  return "done";
}

function wordCount(text) {
  const matches = String(text || "").match(/[A-Za-z']+/g);
  return matches ? matches.length : 0;
}

function hasActor(caption, actor) {
  return String(caption || "").split(/[^A-Za-z]+/).includes(actor);
}

const uncertainPattern = /\b(maybe|probably|seems?|appears?)\b/i;
const genericPattern = /^\s*(a moves|a walks forward|two people interact|they interact|they do something together)\.?\s*$/i;
const relationPattern = /\b(while|toward|towards|away from|with|against|around|between|beside|near|facing|faces|contact|respond|receive|receives|follow|follows|each other|one another|together|joined|side-by-side|same direction|close|distance|by the hand|holds|pushes|pulls|hugs|embraces|shakes)\b/i;

function warningsForSegment(segment, idx, segments, numFrames) {
  const warnings = [];
  if (!Number.isInteger(segment.start_frame) || !Number.isInteger(segment.end_frame)) {
    warnings.push("bad frame range");
  } else {
    if (segment.start_frame < 0 || segment.end_frame >= numFrames || segment.end_frame < segment.start_frame) {
      warnings.push("invalid boundary");
    }
    if (idx > 0 && segment.start_frame !== segments[idx - 1].end_frame + 1) {
      warnings.push("gap or overlap");
    }
  }
  const caption = String(segment.caption || "").trim();
  if (!caption) warnings.push("missing caption");
  if (caption && !hasActor(caption, "A")) warnings.push("missing A");
  if (caption && !hasActor(caption, "B")) warnings.push("missing B");
  if (caption && !relationPattern.test(caption)) warnings.push("weak interaction relation");
  if (uncertainPattern.test(caption)) warnings.push("uncertain wording");
  if (genericPattern.test(caption)) warnings.push("generic caption");
  const words = wordCount(caption);
  if (caption && words < 6) warnings.push("too short");
  if (words > 28) warnings.push("too long");
  return warnings;
}

function warningsForAnnotation(annotation) {
  if (!annotation) return ["missing annotation"];
  const segments = annotation.segments || [];
  const warnings = [];
  if (segments.length < 2 || segments.length > 6) warnings.push("segment count should be 2-6");
  if (segments[0]?.start_frame !== 0) warnings.push("first segment should start at 0");
  if (segments.at(-1)?.end_frame !== annotation.num_frames - 1) warnings.push("last segment should end at final frame");
  segments.forEach((segment, idx) => {
    warnings.push(...warningsForSegment(segment, idx, segments, annotation.num_frames).map((item) => `S${idx + 1}: ${item}`));
  });
  return warnings;
}

async function fetchJson(url) {
  const separator = url.includes("?") ? "&" : "?";
  const response = await fetch(`${url}${separator}v=${DATA_VERSION}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Failed to load ${url}`);
  return response.json();
}

async function loadIndex() {
  const data = await fetchJson("data/index.json");
  state.records = data.records;
  loadExcludedIds();
  for (const record of state.records) {
    state.annotations.set(record.sequence_id, loadStoredAnnotation(record));
  }
  buildCategoryFilter();
  applyFilters();
  if (state.filteredRecords.length) {
    await selectSequence(state.filteredRecords[0].sequence_id);
  } else {
    els.statusLine.textContent = `${state.records.length} sequences loaded · all removed from active annotation`;
  }
  if (state.filteredRecords.length) {
    els.statusLine.textContent = `${state.filteredRecords.length} active sequences ready for visual annotation`;
  }
}

function buildCategoryFilter() {
  const categories = [...new Set(state.records.map((record) => record.category))].sort();
  els.categoryFilter.innerHTML = '<option value="">All categories</option>';
  for (const category of categories) {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    els.categoryFilter.appendChild(option);
  }
}

function applyFilters() {
  const query = els.searchInput.value.trim().toLowerCase();
  const category = els.categoryFilter.value;
  state.filteredRecords = state.records.filter((record) => {
    if (state.excludedIds.has(record.sequence_id)) return false;
    const matchesQuery = !query || record.sequence_id.toLowerCase().includes(query) || record.category.toLowerCase().includes(query);
    const matchesCategory = !category || record.category === category;
    return matchesQuery && matchesCategory;
  });
  renderSequenceList();
}

function renderSequenceList() {
  const activeRecords = state.records.filter((record) => !state.excludedIds.has(record.sequence_id));
  const done = activeRecords.filter((record) => statusFor(state.annotations.get(record.sequence_id)) === "done").length;
  const removed = state.excludedIds.size;
  els.sequenceStats.innerHTML = `
    <div>${done}/${activeRecords.length} active clean after local checks</div>
    <div>${removed} removed from export</div>
    <button id="restoreRemovedButton" class="ghost restore-removed-button" type="button" ${removed ? "" : "disabled"}>Restore removed</button>
  `;
  els.sequenceStats.querySelector("#restoreRemovedButton").addEventListener("click", restoreRemovedSequences);
  els.sequenceList.innerHTML = "";
  for (const record of state.filteredRecords) {
    const annotation = state.annotations.get(record.sequence_id);
    const status = statusFor(annotation);
    const item = document.createElement("div");
    item.className = `sequence-item ${record.sequence_id === state.currentId ? "active" : ""}`;
    item.innerHTML = `
      <button class="sequence-select" type="button">
        <span>
        <span class="sequence-id">${record.sequence_id}</span>
        <span class="sequence-sub">${record.category} · ${record.num_frames}f · ${annotation.segments.length} segments</span>
        </span>
        <span class="status-pill ${status === "done" ? "done" : "issue"}">${status}</span>
      </button>
      <button class="sequence-remove-button" type="button" title="Remove from annotation export" aria-label="Remove ${record.sequence_id} from export">x</button>
    `;
    item.querySelector(".sequence-select").addEventListener("click", () => selectSequence(record.sequence_id));
    item.querySelector(".sequence-remove-button").addEventListener("click", () => excludeSequence(record.sequence_id));
    els.sequenceList.appendChild(item);
  }
}

function nextAvailableSequenceId(removedId) {
  const visible = state.records.filter((record) => !state.excludedIds.has(record.sequence_id));
  if (!visible.length) return null;
  const oldIndex = state.records.findIndex((record) => record.sequence_id === removedId);
  return visible.find((record) => state.records.indexOf(record) >= oldIndex)?.sequence_id || visible.at(-1).sequence_id;
}

async function excludeSequence(sequenceId) {
  state.excludedIds.add(sequenceId);
  saveExcludedIds();
  applyFilters();
  if (state.currentId === sequenceId) {
    const nextId = nextAvailableSequenceId(sequenceId);
    if (nextId) {
      await selectSequence(nextId);
    } else {
      state.currentId = null;
      els.sequenceTitle.textContent = "No active sequence selected";
      els.sequenceMeta.textContent = "Restore removed sequences to continue annotation.";
      els.segmentEditor.innerHTML = "";
      els.qualityBox.textContent = "";
      renderSourceCaptions(null);
    }
  } else {
    renderSequenceList();
  }
  els.statusLine.textContent = `${sequenceId} removed from export`;
}

function restoreRemovedSequences() {
  state.excludedIds.clear();
  saveExcludedIds();
  applyFilters();
  if (!state.currentId && state.filteredRecords.length) {
    selectSequence(state.filteredRecords[0].sequence_id);
  }
  els.statusLine.textContent = "Restored removed sequences";
}

async function selectSequence(sequenceId) {
  state.currentId = sequenceId;
  state.frame = 0;
  state.selectedSegment = 0;
  state.playing = false;
  state.segmentPlaybackEnd = null;
  els.playButton.textContent = "Play";
  const record = currentRecord();
  els.loadingOverlay.hidden = false;
  els.sequenceTitle.textContent = record.sequence_id;
  const roles = record.roles || { actor_person: "A", reactor_person: "B" };
  els.sequenceMeta.textContent = `${record.category} · ${record.num_frames} frames · ${record.fps} fps · Caption A=Actor/source ${roles.actor_person} · Caption B=Reactor/source ${roles.reactor_person}`;
  renderSourceCaptions(record);
  try {
    state.currentSkeleton = await getSkeleton(record);
    state.currentFeatures = await getFeatures(record);
    await loadRenderedMedia(record);
  } finally {
    els.loadingOverlay.hidden = true;
  }
  const annotation = normalizeAnnotation(state.annotations.get(sequenceId), record);
  state.annotations.set(sequenceId, annotation);
  els.frameSlider.max = String(Math.max(0, numFramesFor(record, state.currentSkeleton) - 1));
  updateFrame(0);
  renderAll();
}

async function loadRenderedMedia(record) {
  els.meshVideo.pause();
  els.meshVideo.removeAttribute("src");
  els.meshVideo.load();
  els.meshVideo.hidden = true;
  els.renderedClip.hidden = true;
  els.clipBadge.hidden = true;
  els.skeletonCanvas.hidden = false;

  if (record.mesh_video_url && await assetExists(record.mesh_video_url)) {
    els.meshVideo.src = `${record.mesh_video_url}?v=${Date.now()}`;
    els.meshVideo.hidden = false;
    els.skeletonCanvas.hidden = true;
    els.clipBadge.textContent = "SMPL-X mesh video";
    els.clipBadge.hidden = false;
    return;
  }

  if (record.rendered_clip_url && await imageExists(record.rendered_clip_url)) {
    els.renderedClip.src = `${record.rendered_clip_url}?v=${Date.now()}`;
    els.renderedClip.hidden = false;
    els.skeletonCanvas.hidden = true;
    els.clipBadge.textContent = "Pre-rendered human clip";
    els.clipBadge.hidden = false;
  }
}

async function assetExists(url) {
  try {
    const response = await fetch(`${url}?check=${Date.now()}`, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
}

function imageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `${url}?check=${Date.now()}`;
  });
}

async function getSkeleton(record) {
  if (!state.skeletonCache.has(record.sequence_id)) {
    state.skeletonCache.set(record.sequence_id, await fetchJson(record.skeleton_url));
  }
  return state.skeletonCache.get(record.sequence_id);
}

async function getFeatures(record) {
  if (!state.featureCache.has(record.sequence_id)) {
    try {
      state.featureCache.set(record.sequence_id, await fetchJson(record.features_url));
    } catch {
      state.featureCache.set(record.sequence_id, { signals: {} });
    }
  }
  return state.featureCache.get(record.sequence_id);
}

function renderAll() {
  renderSequenceList();
  renderSkeleton();
  renderSignals();
  renderTimeline();
  renderSegmentEditor();
  renderQuality();
  updateButtons();
}

function sourceCaptionEntries(record) {
  if (!record) return [];
  if (Array.isArray(record.source_captions) && record.source_captions.length) {
    return record.source_captions;
  }
  const fallback = String(record.global_caption || "").trim();
  return fallback ? [{ index: 1, label: "Merged original caption", en: fallback, zh: "" }] : [];
}

function renderSourceCaptions(record) {
  const panel = els.sourceCaptionPanel;
  panel.innerHTML = "";
  const entries = sourceCaptionEntries(record);
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "source-caption-empty";
    empty.textContent = "No original captions available.";
    panel.appendChild(empty);
    return;
  }

  const language = record?.source_caption_language || {};
  const note = document.createElement("div");
  note.className = "source-caption-note";
  note.textContent = language.zh || "Chinese text is for annotation reference only.";
  panel.appendChild(note);

  const recordNotes = Array.isArray(record?.source_caption_notes) ? record.source_caption_notes : [];
  if (recordNotes.length) {
    const warning = document.createElement("div");
    warning.className = "source-caption-warning";
    warning.textContent = `Source note: ${recordNotes.join(", ")}`;
    panel.appendChild(warning);
  }

  for (const entry of entries) {
    const card = document.createElement("article");
    card.className = "source-caption-card";

    const title = document.createElement("div");
    title.className = "source-caption-title";
    title.textContent = entry.label || `Original annotation ${entry.index || ""}`.trim();
    card.appendChild(title);

    const english = document.createElement("p");
    english.className = "source-caption-en";
    english.textContent = entry.en || "";
    card.appendChild(english);

    const chinese = document.createElement("p");
    chinese.className = "source-caption-zh";
    chinese.textContent = entry.zh || "中文参考暂缺。";
    card.appendChild(chinese);

    if (Array.isArray(entry.notes) && entry.notes.length) {
      const entryNote = document.createElement("div");
      entryNote.className = "source-caption-entry-note";
      entryNote.textContent = `Note: ${entry.notes.join(", ")}`;
      card.appendChild(entryNote);
    }

    panel.appendChild(card);
  }
}

function resizeCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function project(point) {
  const x = point[0];
  const depth = point[1];
  const up = point[2];
  return [x - depth * 0.42, -up + depth * 0.18];
}

function projectedBounds(skeleton) {
  const corners = [];
  const lo = skeleton.bounds.min;
  const hi = skeleton.bounds.max;
  for (const x of [lo[0], hi[0]]) {
    for (const y of [lo[1], hi[1]]) {
      for (const z of [lo[2], hi[2]]) {
        corners.push(project([x, y, z]));
      }
    }
  }
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

function makeProjector(width, height, skeleton) {
  const bounds = projectedBounds(skeleton);
  const spanX = Math.max(0.001, bounds.maxX - bounds.minX);
  const spanY = Math.max(0.001, bounds.maxY - bounds.minY);
  const pad = 42;
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return (point) => {
    const [px, py] = project(point);
    return [width / 2 + (px - cx) * scale, height / 2 + (py - cy) * scale];
  };
}

function drawCheckerFloor(ctx, width, height) {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const horizon = height * 0.53;
  const vanishX = width * 0.5;
  const floorBottom = height;
  const rows = 15;
  const cols = 18;
  const bottomLeft = -width * 0.65;
  const bottomRight = width * 1.65;
  const bottomStep = (bottomRight - bottomLeft) / cols;

  function yAt(row) {
    const t = row / rows;
    return horizon + (floorBottom - horizon) * Math.pow(t, 1.75);
  }

  function xAt(bottomX, y) {
    const t = clamp((y - horizon) / Math.max(1, floorBottom - horizon), 0, 1);
    return vanishX + (bottomX - vanishX) * t;
  }

  ctx.fillStyle = "#fafafa";
  ctx.fillRect(0, horizon, width, height - horizon);

  for (let r = 0; r < rows; r += 1) {
    const y0 = yAt(r);
    const y1 = yAt(r + 1);
    for (let c = 0; c < cols; c += 1) {
      const bx0 = bottomLeft + c * bottomStep;
      const bx1 = bottomLeft + (c + 1) * bottomStep;
      const x00 = xAt(bx0, y0);
      const x10 = xAt(bx1, y0);
      const x11 = xAt(bx1, y1);
      const x01 = xAt(bx0, y1);
      ctx.beginPath();
      ctx.moveTo(x00, y0);
      ctx.lineTo(x10, y0);
      ctx.lineTo(x11, y1);
      ctx.lineTo(x01, y1);
      ctx.closePath();
      ctx.fillStyle = (r + c) % 2 === 0 ? "#eeeeee" : "#ffffff";
      ctx.fill();
    }
  }

  ctx.strokeStyle = "rgba(210, 216, 222, 0.7)";
  ctx.lineWidth = 1;
  for (let r = 0; r <= rows; r += 1) {
    const y = yAt(r);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (let c = 0; c <= cols; c += 1) {
    const bottomX = bottomLeft + c * bottomStep;
    ctx.beginPath();
    ctx.moveTo(vanishX, horizon);
    ctx.lineTo(bottomX, floorBottom);
    ctx.stroke();
  }

  const gradient = ctx.createLinearGradient(0, horizon - 60, 0, horizon + 18);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "rgba(255,255,255,0.62)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, horizon - 60, width, 82);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function joint2d(points, projector, index) {
  if (!points[index]) return null;
  return projector(points[index]);
}

function distance2d(a, b) {
  if (!a || !b) return 0;
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function drawCapsule(ctx, a, b, width, color, alpha = 0.9) {
  if (!a || !b) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = rgba(color, alpha);
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
  ctx.restore();
}

function drawJointBubble(ctx, point, radius, color, alpha = 0.92) {
  if (!point) return;
  ctx.save();
  ctx.fillStyle = rgba(color, alpha);
  ctx.beginPath();
  ctx.arc(point[0], point[1], radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawTorso(ctx, points, projector, color) {
  const leftHip = joint2d(points, projector, 1);
  const rightHip = joint2d(points, projector, 2);
  const leftShoulder = joint2d(points, projector, 13);
  const rightShoulder = joint2d(points, projector, 14);
  const chest = joint2d(points, projector, 12);
  const pelvis = joint2d(points, projector, 0);
  if (!leftHip || !rightHip || !leftShoulder || !rightShoulder) {
    drawCapsule(ctx, pelvis, chest, 24, color, 0.92);
    return;
  }
  ctx.save();
  ctx.fillStyle = rgba(color, 0.94);
  ctx.strokeStyle = rgba(color, 0.98);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(leftShoulder[0], leftShoulder[1]);
  ctx.quadraticCurveTo(chest?.[0] ?? leftShoulder[0], chest?.[1] ?? leftShoulder[1], rightShoulder[0], rightShoulder[1]);
  ctx.lineTo(rightHip[0], rightHip[1]);
  ctx.quadraticCurveTo(pelvis?.[0] ?? rightHip[0], pelvis?.[1] ?? rightHip[1], leftHip[0], leftHip[1]);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawHead(ctx, points, projector, color) {
  const head = joint2d(points, projector, 15);
  const neck = joint2d(points, projector, 12);
  const leftShoulder = joint2d(points, projector, 13);
  const rightShoulder = joint2d(points, projector, 14);
  const shoulderSpan = Math.max(12, distance2d(leftShoulder, rightShoulder));
  const radius = clamp(shoulderSpan * 0.34, 8, 20);
  drawCapsule(ctx, neck, head, Math.max(8, radius * 0.7), color, 0.9);
  drawJointBubble(ctx, head, radius, color, 0.96);
  if (head) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(head[0], head[1], radius * 0.98, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

function drawHandFoot(ctx, points, projector, color) {
  for (const index of [10, 11]) {
    drawJointBubble(ctx, joint2d(points, projector, index), 7, color, 0.94);
  }
  for (const index of [20, 21]) {
    drawJointBubble(ctx, joint2d(points, projector, index), 6, color, 0.98);
  }
}

function topPoint(points, projector) {
  let best = null;
  for (const point of points) {
    const projected = projector(point);
    if (!best || projected[1] < best[1]) best = projected;
  }
  return best;
}

function footCenter(points, projector) {
  const left = joint2d(points, projector, 10);
  const right = joint2d(points, projector, 11);
  if (left && right) return [(left[0] + right[0]) / 2, Math.max(left[1], right[1])];
  return left || right || joint2d(points, projector, 0);
}

function drawGroundShadow(ctx, points, projector, color) {
  const feet = footCenter(points, projector);
  if (!feet) return;
  ctx.save();
  ctx.fillStyle = rgba(color, 0.18);
  ctx.beginPath();
  ctx.ellipse(feet[0], feet[1] + 8, 38, 9, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawRoleLabel(ctx, points, projector, color, role, person) {
  const top = topPoint(points, projector);
  if (!top) return;
  const text = `${person} ${role}`;
  ctx.save();
  ctx.font = "700 13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  const metrics = ctx.measureText(text);
  const padX = 8;
  const boxW = metrics.width + padX * 2;
  const boxH = 24;
  const x = top[0] - boxW / 2;
  const y = top[1] - 34;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.strokeStyle = rgba(color, 0.9);
  ctx.lineWidth = 1.5;
  roundedRectPath(ctx, x, y, boxW, boxH, 8);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillText(text, x + padX, y + 16);
  ctx.restore();
}

function drawHumanoid(ctx, points, projector, color, role, person) {
  const root = joint2d(points, projector, 0);
  drawGroundShadow(ctx, points, projector, color);
  ctx.save();
  ctx.shadowColor = "rgba(24, 32, 42, 0.18)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 3;

  // Legs first, then torso and arms, so the body reads as a human figure.
  for (const [a, b, width] of [
    [1, 4, 16], [4, 7, 13], [7, 10, 10],
    [2, 5, 16], [5, 8, 13], [8, 11, 10],
  ]) {
    drawCapsule(ctx, joint2d(points, projector, a), joint2d(points, projector, b), width, color, 0.94);
  }

  drawTorso(ctx, points, projector, color);

  for (const [a, b, width] of [
    [13, 16, 12], [16, 18, 10], [18, 20, 8],
    [14, 17, 12], [17, 19, 10], [19, 21, 8],
  ]) {
    drawCapsule(ctx, joint2d(points, projector, a), joint2d(points, projector, b), width, color, 0.95);
  }

  drawHead(ctx, points, projector, color);
  drawHandFoot(ctx, points, projector, color);
  ctx.restore();

  ctx.save();
  if (root) {
    ctx.fillStyle = color;
    ctx.font = "700 15px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
    ctx.fillText(person, root[0] + 10, root[1] - 10);
  }
  ctx.restore();
  drawRoleLabel(ctx, points, projector, color, role, person);
}

function drawActiveSegment(ctx, width, annotation) {
  const segment = annotation.segments[state.selectedSegment];
  if (!segment) return;
  ctx.fillStyle = "rgba(20, 108, 120, 0.08)";
  ctx.fillRect(0, 0, width, 32);
  ctx.fillStyle = "#46525f";
  ctx.font = "13px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  const text = `S${state.selectedSegment + 1}: ${segment.start_frame}-${segment.end_frame}  ${segment.caption || "caption pending"}`;
  ctx.fillText(text, 14, 21);
}

function captionPersonForSource(sourcePerson, roles) {
  if (sourcePerson === roles.actor_person) return "A";
  if (sourcePerson === roles.reactor_person) return "B";
  return sourcePerson;
}

function renderSkeleton() {
  if (els.skeletonCanvas.hidden) {
    syncVisibleVideo();
    return;
  }
  const skeleton = state.currentSkeleton;
  const annotation = currentAnnotation();
  const record = currentRecord();
  const { ctx, width, height } = resizeCanvas(els.skeletonCanvas);
  drawCheckerFloor(ctx, width, height);
  if (!skeleton) return;
  const frame = clamp(state.frame, 0, skeleton.num_frames - 1);
  const projector = makeProjector(width, height, skeleton);
  const roles = record?.roles || { A_role: "Actor", B_role: "Reactor" };
  const roleA = roles.A_role || "Actor";
  const roleB = roles.B_role || "Reactor";
  drawHumanoid(ctx, skeleton.persons.A[frame], projector, ROLE_COLORS[roleA] || ROLE_COLORS.Actor, roleA, captionPersonForSource("A", roles));
  drawHumanoid(ctx, skeleton.persons.B[frame], projector, ROLE_COLORS[roleB] || ROLE_COLORS.Reactor, roleB, captionPersonForSource("B", roles));
  if (annotation) drawActiveSegment(ctx, width, annotation);
  ctx.fillStyle = "#66727f";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText(`Frame ${frame} / ${skeleton.num_frames - 1}`, 14, height - 14);
}

function syncVisibleVideo() {
  if (els.meshVideo.hidden || !Number.isFinite(els.meshVideo.duration)) return;
  seekMeshVideoToFrame(state.frame);
}

function seekMeshVideoToFrame(frame) {
  if (els.meshVideo.hidden || !Number.isFinite(els.meshVideo.duration)) return;
  const annotation = currentAnnotation();
  const fps = Number(annotation?.fps || 30);
  const target = frame / fps;
  if (Math.abs(els.meshVideo.currentTime - target) > 0.035) {
    const clamped = clamp(target, 0, Math.max(0, els.meshVideo.duration - 0.001));
    els.meshVideo.currentTime = clamped;
  }
}

function playMeshVideoFromFrame(frame) {
  if (els.meshVideo.hidden || !Number.isFinite(els.meshVideo.duration)) return;
  const annotation = currentAnnotation();
  const fps = Number(annotation?.fps || 30);
  const target = frame / fps;
  const clamped = clamp(target, 0, Math.max(0, els.meshVideo.duration - 0.001));
  const token = state.videoPlayToken + 1;
  state.videoPlayToken = token;
  const chosenRate = Number(els.speedSelect.value || 1);
  const startVideo = () => {
    if (!state.playing || token !== state.videoPlayToken) return;
    state.preparingSegment = false;
    els.meshVideo.style.visibility = "visible";
    els.loadingOverlay.hidden = true;
    els.meshVideo.playbackRate = chosenRate;
    els.meshVideo.play().catch(() => {
      // Muted local videos should play, but the canvas fallback remains usable.
    });
  };
  if (clamped <= 0.04 || Math.abs(els.meshVideo.currentTime - clamped) <= 0.05) {
    startVideo();
    return;
  }
  state.preparingSegment = true;
  els.loadingOverlay.textContent = "Seeking segment...";
  els.loadingOverlay.hidden = false;
  els.meshVideo.style.visibility = "hidden";
  els.meshVideo.pause();
  els.meshVideo.playbackRate = 4;

  const monitorFastForward = () => {
    if (!state.playing || token !== state.videoPlayToken) return;
    if (els.meshVideo.currentTime >= Math.max(0, clamped - 0.03)) {
      startVideo();
      return;
    }
    requestAnimationFrame(monitorFastForward);
  };

  let fastForwardStarted = false;
  const startFastForward = () => {
    if (!state.playing || token !== state.videoPlayToken) return;
    if (fastForwardStarted) return;
    fastForwardStarted = true;
    els.meshVideo.play().then(() => {
      requestAnimationFrame(monitorFastForward);
    }).catch(() => {
      els.loadingOverlay.textContent = "Click Play again to start this segment";
    });
  };

  if (els.meshVideo.currentTime > clamped || els.meshVideo.currentTime > 0.15) {
    els.meshVideo.addEventListener("canplay", startFastForward, { once: true });
    els.meshVideo.load();
    window.setTimeout(() => {
      if (els.meshVideo.readyState >= 2) startFastForward();
    }, 180);
  } else {
    startFastForward();
  }
}

function updateFrameReadout(frame) {
  const annotation = currentAnnotation();
  const maxFrame = Math.max(0, Number(annotation?.num_frames || state.currentSkeleton?.num_frames || 1) - 1);
  state.frame = clamp(frame, 0, maxFrame);
  els.frameSlider.max = String(maxFrame);
  els.frameSlider.value = String(state.frame);
  const fps = Number(annotation?.fps || 30);
  els.frameReadout.textContent = `Frame ${state.frame}`;
  els.timeReadout.textContent = `${(state.frame / fps).toFixed(2)}s`;
}

function renderSignals() {
  const { ctx, width, height } = resizeCanvas(els.signalCanvas);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  const features = state.currentFeatures;
  if (!features?.signals) return;
  const series = [
    ["boundary_score", "#9a6b00"],
    ["contact_proxy", "#1d6f42"],
    ["root_distance", "#2166ac"],
  ];
  ctx.strokeStyle = "#edf1f4";
  ctx.lineWidth = 1;
  for (let y = 20; y < height; y += 28) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  for (const [name, color] of series) {
    const values = features.signals[name];
    if (!values?.length) continue;
    const finite = values.filter((value) => Number.isFinite(value));
    const min = Math.min(...finite);
    const max = Math.max(...finite);
    const span = Math.max(0.0001, max - min);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    values.forEach((value, idx) => {
      if (!Number.isFinite(value)) return;
      const x = values.length === 1 ? 0 : (idx / (values.length - 1)) * width;
      const y = height - 16 - ((value - min) / span) * (height - 34);
      if (idx === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  const maxFrame = Math.max(1, Number(currentAnnotation()?.num_frames || 1) - 1);
  const playX = (state.frame / maxFrame) * width;
  ctx.strokeStyle = "#9a6b00";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(playX, 0);
  ctx.lineTo(playX, height);
  ctx.stroke();
  ctx.fillStyle = "#46525f";
  ctx.font = "12px -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif";
  ctx.fillText("boundary_score", 10, 16);
  ctx.fillStyle = "#1d6f42";
  ctx.fillText("contact", 130, 16);
  ctx.fillStyle = "#2166ac";
  ctx.fillText("distance", 196, 16);
}

function renderTimeline() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  const maxFrame = Math.max(1, annotation.num_frames - 1);
  const trackLeft = 12;
  const trackRight = 12;
  els.timeline.innerHTML = `
    <div class="timeline-track"></div>
    <div class="playhead"></div>
    <div class="timeline-labels"><span>0</span><span>${maxFrame}</span></div>
  `;
  const track = els.timeline.querySelector(".timeline-track");
  annotation.segments.forEach((segment, idx) => {
    const div = document.createElement("div");
    div.className = `timeline-segment ${idx === state.selectedSegment ? "selected" : ""}`;
    div.style.left = `${(segment.start_frame / maxFrame) * 100}%`;
    div.style.width = `${((segment.end_frame - segment.start_frame + 1) / (maxFrame + 1)) * 100}%`;
    div.style.background = COLORS[idx % COLORS.length];
    div.textContent = `S${idx + 1}`;
    div.addEventListener("click", (event) => {
      event.stopPropagation();
      state.selectedSegment = idx;
      updateFrame(segment.start_frame);
      renderAll();
    });
    track.appendChild(div);
  });
  for (let idx = 1; idx < annotation.segments.length; idx += 1) {
    const frame = annotation.segments[idx].start_frame;
    const handle = document.createElement("div");
    handle.className = "boundary-handle";
    handle.style.left = `${(frame / maxFrame) * 100}%`;
    handle.title = `Boundary at frame ${frame}`;
    handle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      state.dragBoundary = idx;
      handle.setPointerCapture(event.pointerId);
    });
    track.appendChild(handle);
  }
  const playhead = els.timeline.querySelector(".playhead");
  playhead.style.left = `calc(${trackLeft}px + ${(state.frame / maxFrame) * (100)}% - ${(trackRight * state.frame) / maxFrame}px)`;
  track.addEventListener("click", (event) => {
    const frame = frameFromPointer(event, track, maxFrame);
    updateFrame(frame);
    selectSegmentByFrame(frame);
    renderAll();
  });
}

function frameFromPointer(event, element, maxFrame) {
  const rect = element.getBoundingClientRect();
  const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
  return clamp(Math.round(ratio * maxFrame), 0, maxFrame);
}

function moveBoundary(boundaryIndex, frame) {
  const annotation = currentAnnotation();
  if (!annotation || boundaryIndex <= 0 || boundaryIndex >= annotation.segments.length) return;
  const prev = annotation.segments[boundaryIndex - 1];
  const next = annotation.segments[boundaryIndex];
  const minFrame = prev.start_frame + 1;
  const maxFrame = next.end_frame;
  const nextStart = clamp(frame, minFrame, maxFrame);
  prev.end_frame = nextStart - 1;
  next.start_frame = nextStart;
  state.selectedSegment = boundaryIndex;
  updateFrame(nextStart);
  saveCurrentAnnotation();
}

function updateFrame(frame) {
  updateFrameReadout(frame);
  syncVisibleVideo();
  renderSkeleton();
  renderSignals();
}

function selectSegmentByFrame(frame) {
  const annotation = currentAnnotation();
  if (!annotation) return;
  const idx = annotation.segments.findIndex((segment) => frame >= segment.start_frame && frame <= segment.end_frame);
  if (idx >= 0) state.selectedSegment = idx;
}

function renderSegmentEditor() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  els.segmentEditor.innerHTML = "";
  annotation.segments.forEach((segment, idx) => {
    const warnings = warningsForSegment(segment, idx, annotation.segments, annotation.num_frames);
    const isSegmentPlaying = state.playing && state.segmentPlaybackEnd === segment.end_frame && idx === state.selectedSegment;
    const card = document.createElement("div");
    card.className = `segment-card ${idx === state.selectedSegment ? "selected" : ""}`;
    card.innerHTML = `
      <div class="segment-head">
        <div class="segment-index">${idx + 1}</div>
        <div class="segment-range-label">${segment.end_frame - segment.start_frame + 1} frames</div>
        <button class="segment-play-button" type="button">${isSegmentPlaying ? "Playing" : "Play"}</button>
        <input class="frame-input start-input" type="number" min="0" max="${annotation.num_frames - 1}" value="${segment.start_frame}" ${idx === 0 ? "disabled" : ""}>
        <input class="frame-input end-input" type="number" min="0" max="${annotation.num_frames - 1}" value="${segment.end_frame}" ${idx === annotation.segments.length - 1 ? "disabled" : ""}>
      </div>
      <textarea class="caption-input" placeholder="Write one joint A/B interaction caption">${escapeHtml(segment.caption)}</textarea>
      <div class="segment-warning">${warnings.length ? warnings.join(", ") : "ok"}</div>
    `;
    card.addEventListener("click", (event) => {
      if (event.target.closest("textarea, input, button")) return;
      state.selectedSegment = idx;
      updateFrame(annotation.segments[idx].start_frame);
      renderAll();
    });
    card.querySelector(".segment-play-button").addEventListener("click", (event) => {
      event.stopPropagation();
      playSegment(idx);
    });
    card.querySelectorAll("textarea, input").forEach((control) => {
      control.addEventListener("click", (event) => event.stopPropagation());
      control.addEventListener("pointerdown", (event) => event.stopPropagation());
    });
    card.querySelector(".caption-input").addEventListener("input", (event) => {
      annotation.segments[idx].caption = event.target.value;
      saveCurrentAnnotation();
      renderQuality();
      renderSequenceList();
      renderSkeleton();
    });
    card.querySelector(".start-input").addEventListener("change", (event) => {
      event.stopPropagation();
      if (idx > 0) moveBoundary(idx, Number(event.target.value));
      renderAll();
    });
    card.querySelector(".end-input").addEventListener("change", (event) => {
      event.stopPropagation();
      if (idx < annotation.segments.length - 1) moveBoundary(idx + 1, Number(event.target.value) + 1);
      renderAll();
    });
    els.segmentEditor.appendChild(card);
  });
}

function isEditingSegmentControl() {
  return Boolean(document.activeElement && els.segmentEditor.contains(document.activeElement));
}

function stopPlayback() {
  state.playing = false;
  state.preparingSegment = false;
  state.segmentPlaybackStart = null;
  state.segmentPlaybackEnd = null;
  state.videoPlayToken += 1;
  if (!els.meshVideo.hidden) {
    els.meshVideo.pause();
    els.meshVideo.style.visibility = "visible";
    els.meshVideo.playbackRate = Number(els.speedSelect.value || 1);
  }
  els.loadingOverlay.hidden = true;
  els.playButton.textContent = "Play";
}

function startPlayback(segmentEnd = null) {
  state.playing = true;
  state.segmentPlaybackStart = state.frame;
  state.segmentPlaybackEnd = Number.isInteger(segmentEnd) ? segmentEnd : null;
  state.lastTick = 0;
  els.playButton.textContent = "Pause";
  if (!els.meshVideo.hidden) {
    playMeshVideoFromFrame(state.frame);
  }
}

function playSegment(idx) {
  const annotation = currentAnnotation();
  if (!annotation) return;
  const segment = annotation.segments[idx];
  if (!segment) return;
  state.selectedSegment = idx;
  updateFrame(segment.start_frame);
  startPlayback(segment.end_frame);
  renderAll();
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderQuality() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  const warnings = warningsForAnnotation(annotation);
  const totalWords = annotation.segments.reduce((sum, segment) => sum + wordCount(segment.caption), 0);
  const avgWords = annotation.segments.length ? (totalWords / annotation.segments.length).toFixed(1) : "0";
  const issueText = warnings.length ? `<span class="bad">${warnings.length} local warnings</span>` : '<span class="good">local checks clean</span>';
  els.qualityBox.innerHTML = `
    <strong>${annotation.segments.length}</strong> segments · avg caption <strong>${avgWords}</strong> words · ${issueText}
  `;
}

function splitAtCurrentFrame() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  if (annotation.segments.length >= 6) return;
  const idx = annotation.segments.findIndex((segment) => state.frame > segment.start_frame && state.frame <= segment.end_frame);
  if (idx < 0) return;
  const current = annotation.segments[idx];
  const newSegment = {
    start_frame: state.frame,
    end_frame: current.end_frame,
    caption: "",
  };
  current.end_frame = state.frame - 1;
  annotation.segments.splice(idx + 1, 0, newSegment);
  state.selectedSegment = idx + 1;
  saveCurrentAnnotation();
  renderAll();
}

function deleteSelectedSegment() {
  const annotation = currentAnnotation();
  if (!annotation || annotation.segments.length <= 1) return;
  const idx = state.selectedSegment;
  if (idx > 0) {
    annotation.segments[idx - 1].end_frame = annotation.segments[idx].end_frame;
  } else {
    annotation.segments[1].start_frame = 0;
  }
  annotation.segments.splice(idx, 1);
  state.selectedSegment = clamp(idx - 1, 0, annotation.segments.length - 1);
  saveCurrentAnnotation();
  renderAll();
}

function mergeSelected(direction) {
  const annotation = currentAnnotation();
  if (!annotation || annotation.segments.length <= 1) return;
  const idx = state.selectedSegment;
  const target = direction === "prev" ? idx - 1 : idx + 1;
  if (target < 0 || target >= annotation.segments.length) return;
  const first = annotation.segments[Math.min(idx, target)];
  const second = annotation.segments[Math.max(idx, target)];
  first.end_frame = second.end_frame;
  first.caption = [first.caption, second.caption].filter(Boolean).join(" ");
  annotation.segments.splice(Math.max(idx, target), 1);
  state.selectedSegment = Math.min(idx, target);
  saveCurrentAnnotation();
  renderAll();
}

function resetCandidate() {
  const record = currentRecord();
  if (!record) return;
  state.annotations.set(record.sequence_id, normalizeAnnotation(record.candidate, record));
  state.selectedSegment = 0;
  state.frame = 0;
  saveCurrentAnnotation();
  renderAll();
}

function updateButtons() {
  const annotation = currentAnnotation();
  if (!annotation) return;
  els.splitButton.disabled = annotation.segments.length >= 6;
  els.deleteSegmentButton.disabled = annotation.segments.length <= 1;
  els.mergePrevButton.disabled = state.selectedSegment <= 0;
  els.mergeNextButton.disabled = state.selectedSegment >= annotation.segments.length - 1;
}

function exportJsonl() {
  const lines = state.records
    .filter((record) => !state.excludedIds.has(record.sequence_id))
    .map((record) => JSON.stringify(state.annotations.get(record.sequence_id)));
  return `${lines.join("\n")}\n`;
}

function downloadJsonl() {
  const blob = new Blob([exportJsonl()], { type: "application/jsonl" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "dense_hhi_interactive_export.jsonl";
  link.click();
  URL.revokeObjectURL(url);
}

async function copyJsonl() {
  await navigator.clipboard.writeText(exportJsonl());
  els.statusLine.textContent = "Copied JSONL export to clipboard";
}

async function importJsonlFile(file) {
  const text = await file.text();
  const rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  let imported = 0;
  for (const row of rows) {
    const record = state.records.find((item) => item.sequence_id === row.sequence_id);
    if (!record) continue;
    state.annotations.set(record.sequence_id, normalizeAnnotation(row, record));
    localStorage.setItem(storageKey(record.sequence_id), JSON.stringify(state.annotations.get(record.sequence_id)));
    imported += 1;
  }
  els.statusLine.textContent = `Imported ${imported} annotations`;
  if (state.currentId) {
    state.selectedSegment = 0;
    renderAll();
  }
}

function tick(timestamp) {
  if (state.playing && state.currentSkeleton) {
    if (!els.meshVideo.hidden && Number.isFinite(els.meshVideo.duration)) {
      syncFrameFromVideo();
      requestAnimationFrame(tick);
      return;
    }
    if (!state.lastTick) state.lastTick = timestamp;
    const elapsed = timestamp - state.lastTick;
    const annotation = currentAnnotation();
    const fps = Number(annotation?.fps || 30) * Number(els.speedSelect.value || 1);
    const frameAdvance = Math.floor((elapsed / 1000) * fps);
    if (frameAdvance > 0) {
      state.lastTick = timestamp;
      const maxFrame = Number(annotation?.num_frames || state.currentSkeleton.num_frames) - 1;
      const segmentEnd = state.segmentPlaybackEnd;
      let nextFrame = state.frame >= maxFrame ? 0 : Math.min(maxFrame, state.frame + frameAdvance);
      if (Number.isInteger(segmentEnd) && nextFrame >= segmentEnd) {
        nextFrame = segmentEnd;
      }
      updateFrame(nextFrame);
      syncVisibleVideo();
      selectSegmentByFrame(nextFrame);
      if (Number.isInteger(segmentEnd) && nextFrame >= segmentEnd) {
        stopPlayback();
      }
      renderTimeline();
      if (!isEditingSegmentControl()) renderSegmentEditor();
      renderQuality();
    }
  } else {
    state.lastTick = timestamp;
  }
  requestAnimationFrame(tick);
}

function syncFrameFromVideo() {
  if (els.meshVideo.hidden || !Number.isFinite(els.meshVideo.currentTime)) return;
  const annotation = currentAnnotation();
  if (!annotation) return;
  const fps = Number(annotation.fps || 30);
  const frame = clamp(Math.round(els.meshVideo.currentTime * fps), 0, annotation.num_frames - 1);
  if (state.preparingSegment && Number.isInteger(state.segmentPlaybackStart) && frame < state.segmentPlaybackStart) {
    updateFrameReadout(state.segmentPlaybackStart);
    return;
  }
  updateFrameReadout(frame);
  selectSegmentByFrame(frame);
  const segmentEnd = state.segmentPlaybackEnd;
  if (Number.isInteger(segmentEnd) && frame >= segmentEnd) {
    updateFrameReadout(segmentEnd);
    stopPlayback();
  }
  renderTimeline();
  renderSegmentEditor();
  renderSignals();
  renderQuality();
}

function bindEvents() {
  els.searchInput.addEventListener("input", applyFilters);
  els.categoryFilter.addEventListener("change", applyFilters);
  els.frameSlider.addEventListener("input", (event) => {
    stopPlayback();
    updateFrame(Number(event.target.value));
    selectSegmentByFrame(state.frame);
    renderTimeline();
    renderSegmentEditor();
    renderQuality();
  });
  els.playButton.addEventListener("click", () => {
    if (state.playing) {
      stopPlayback();
    } else {
      startPlayback(null);
    }
  });
  els.prevFrameButton.addEventListener("click", () => {
    stopPlayback();
    updateFrame(state.frame - 1);
    selectSegmentByFrame(state.frame);
    renderAll();
  });
  els.nextFrameButton.addEventListener("click", () => {
    stopPlayback();
    updateFrame(state.frame + 1);
    selectSegmentByFrame(state.frame);
    renderAll();
  });
  els.meshVideo.addEventListener("timeupdate", syncFrameFromVideo);
  els.meshVideo.addEventListener("ended", stopPlayback);
  els.splitButton.addEventListener("click", splitAtCurrentFrame);
  els.deleteSegmentButton.addEventListener("click", deleteSelectedSegment);
  els.mergePrevButton.addEventListener("click", () => mergeSelected("prev"));
  els.mergeNextButton.addEventListener("click", () => mergeSelected("next"));
  els.resetCandidateButton.addEventListener("click", resetCandidate);
  els.exportButton.addEventListener("click", downloadJsonl);
  els.copyButton.addEventListener("click", copyJsonl);
  els.importButton.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importJsonlFile(file);
    event.target.value = "";
  });
  window.addEventListener("pointermove", (event) => {
    if (state.dragBoundary == null) return;
    const track = els.timeline.querySelector(".timeline-track");
    const annotation = currentAnnotation();
    if (!track || !annotation) return;
    const frame = frameFromPointer(event, track, annotation.num_frames - 1);
    moveBoundary(state.dragBoundary, frame);
    renderTimeline();
    if (!isEditingSegmentControl()) renderSegmentEditor();
    renderQuality();
  });
  window.addEventListener("pointerup", () => {
    state.dragBoundary = null;
  });
  window.addEventListener("resize", renderAll);
  window.addEventListener("keydown", (event) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (event.code === "Space") {
      event.preventDefault();
      els.playButton.click();
    } else if (event.key === "ArrowLeft") {
      updateFrame(state.frame - 1);
      selectSegmentByFrame(state.frame);
      renderAll();
    } else if (event.key === "ArrowRight") {
      updateFrame(state.frame + 1);
      selectSegmentByFrame(state.frame);
      renderAll();
    } else if (event.key.toLowerCase() === "s") {
      splitAtCurrentFrame();
    }
  });
}

bindEvents();
loadIndex().catch((error) => {
  console.error(error);
  els.statusLine.textContent = error.message;
  els.loadingOverlay.hidden = true;
});
requestAnimationFrame(tick);
