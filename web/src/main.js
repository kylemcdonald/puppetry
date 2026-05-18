import {
  CircleDot,
  Grid,
  Move,
  Pencil,
  Pin,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  createIcons,
} from "lucide";
import cdt2d from "cdt2d";
import init, { WasmArap } from "../pkg/arap2d.js";
import "./styles.css";

const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const toolButtons = [...document.querySelectorAll(".tool[data-mode]")];
const meshToggle = document.querySelector("#meshToggle");
const resolutionSlider = document.querySelector("#resolutionSlider");
const resolutionValue = document.querySelector("#resolutionValue");
const exampleButton = document.querySelector("#exampleButton");
const clearButton = document.querySelector("#clearButton");
const DRAW_SAMPLE_SPACING = 4;
const RESOLUTION_PRESETS = [
  {
    name: "Low",
    subdivisions: 0,
    douglasPeuckerEpsilon: 7,
    boundaryMaxSegment: 34,
    maxBoundaryPoints: 48,
    interiorSpacingScale: 1.45,
  },
  {
    name: "Med",
    subdivisions: 1,
    douglasPeuckerEpsilon: 5,
    boundaryMaxSegment: 24,
    maxBoundaryPoints: 96,
    interiorSpacingScale: 1,
  },
  {
    name: "High",
    subdivisions: 2,
    douglasPeuckerEpsilon: 3.5,
    boundaryMaxSegment: 18,
    maxBoundaryPoints: 128,
    interiorSpacingScale: 0.78,
  },
];

createIcons({
  icons: {
    CircleDot,
    Grid,
    Move,
    Pencil,
    Pin,
    RotateCcw,
    SlidersHorizontal,
    Trash2,
  },
});

const state = {
  mode: "draw",
  showMesh: true,
  drawing: false,
  drawPath: [],
  mesh: null,
  deformed: [],
  anchors: new Set(),
  controls: new Set(),
  targets: new Map(),
  solver: null,
  draggingControl: null,
  wasmReady: false,
  dirtySolver: true,
  lastUpdateMs: 0,
  meshResolution: Number(resolutionSlider.value),
  sourcePath: null,
  busy: false,
};

function setStatus(text) {
  statusEl.textContent = text;
}

function resolutionPreset(value = state.meshResolution) {
  const index = Math.max(0, Math.min(RESOLUTION_PRESETS.length - 1, Math.round(value)));
  return RESOLUTION_PRESETS[index];
}

function updateResolutionDisplay() {
  const preset = resolutionPreset();
  resolutionValue.value = preset.name;
  resolutionValue.textContent = preset.name;
}

function refreshCursor() {
  if (state.busy) {
    canvas.style.cursor = "wait";
  } else if (state.draggingControl != null) {
    canvas.style.cursor = "grabbing";
  } else {
    canvas.style.cursor = state.mode === "move" ? "grab" : "crosshair";
  }
}

function setBusy(busy, message = "") {
  state.busy = busy;
  document.body.classList.toggle("busy", busy);
  resolutionSlider.disabled = busy;
  if (message) setStatus(message);
  refreshCursor();
}

function runAfterNextPaint(task, message) {
  setBusy(true, message);
  requestAnimationFrame(() => {
    setTimeout(() => {
      try {
        task();
      } catch (error) {
        console.error(error);
        setStatus("Update failed");
      } finally {
        setBusy(false);
      }
    }, 0);
  });
}

function resizeCanvas() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function pointerPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function appendDrawPoint(point) {
  const last = state.drawPath[state.drawPath.length - 1];
  if (!last) {
    state.drawPath.push(point);
    return true;
  }
  const length = dist(last, point);
  if (length < DRAW_SAMPLE_SPACING) return false;
  const steps = Math.floor(length / DRAW_SAMPLE_SPACING);
  for (let step = 1; step <= steps; step++) {
    state.drawPath.push(interpolate(last, point, (step * DRAW_SAMPLE_SPACING) / length));
  }
  return true;
}

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function polygonArea(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return area * 0.5;
}

function removeClosingDuplicate(points, epsilon = 1) {
  if (points.length > 2 && dist(points[0], points[points.length - 1]) <= epsilon) {
    return points.slice(0, -1);
  }
  return points;
}

function dedupeConsecutivePoints(points, epsilon = 0.5) {
  const out = [];
  for (const p of points) {
    if (!out.length || dist(out[out.length - 1], p) > epsilon) {
      out.push(p);
    }
  }
  return removeClosingDuplicate(out, epsilon);
}

function interpolate(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function densifyClosedPath(points, spacing) {
  if (points.length < 2) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = dist(a, b);
    const steps = Math.max(1, Math.ceil(length / spacing));
    out.push(a);
    for (let step = 1; step < steps; step++) {
      out.push(interpolate(a, b, step / steps));
    }
  }
  return out;
}

function perpendicularDistanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq < 1e-9) return dist(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
  return dist(p, { x: a.x + dx * t, y: a.y + dy * t });
}

function douglasPeuckerOpen(points, epsilon) {
  if (points.length <= 2) return points;
  let maxDistance = -1;
  let splitIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistanceToSegment(points[i], first, last);
    if (d > maxDistance) {
      maxDistance = d;
      splitIndex = i;
    }
  }
  if (maxDistance <= epsilon) return [first, last];
  const left = douglasPeuckerOpen(points.slice(0, splitIndex + 1), epsilon);
  const right = douglasPeuckerOpen(points.slice(splitIndex), epsilon);
  return left.slice(0, -1).concat(right);
}

function douglasPeuckerClosed(points, epsilon) {
  if (points.length <= 3) return points;
  const center = polygonCentroid(points);
  let startIndex = 0;
  let startDistance = -1;
  points.forEach((p, i) => {
    const d = dist(p, center);
    if (d > startDistance) {
      startDistance = d;
      startIndex = i;
    }
  });
  const rotated = points.slice(startIndex).concat(points.slice(0, startIndex));
  const simplified = douglasPeuckerOpen([...rotated, rotated[0]], epsilon);
  const closed = removeClosingDuplicate(simplified, 1e-6);
  return closed.length >= 3 ? closed : points;
}

function subdivideLongBoundarySegments(points, maxSegmentLength, maxPoints) {
  if (points.length < 2) return points;
  const out = [];
  const perimeter = points.reduce((sum, p, i) => sum + dist(p, points[(i + 1) % points.length]), 0);
  const scale = Math.max(1, perimeter / (maxSegmentLength * maxPoints));
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const steps = Math.max(1, Math.ceil(dist(a, b) / (maxSegmentLength * scale)));
    out.push(a);
    for (let step = 1; step < steps; step++) {
      out.push(interpolate(a, b, step / steps));
    }
  }
  return out;
}

function simplifyDrawnBoundary(points, preset) {
  const cleaned = dedupeConsecutivePoints(points);
  if (cleaned.length < 3) return cleaned;
  const dense = densifyClosedPath(cleaned, DRAW_SAMPLE_SPACING);
  const simplified = removeNearCollinear(douglasPeuckerClosed(dense, preset.douglasPeuckerEpsilon));
  return subdivideLongBoundarySegments(simplified, preset.boundaryMaxSegment, preset.maxBoundaryPoints);
}

function removeNearCollinear(points, epsilon = 0.015) {
  if (points.length < 4) return points;
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[(i - 1 + points.length) % points.length];
    const curr = points[i];
    const next = points[(i + 1) % points.length];
    const ux = curr.x - prev.x;
    const uy = curr.y - prev.y;
    const vx = next.x - curr.x;
    const vy = next.y - curr.y;
    const cross = Math.abs(ux * vy - uy * vx);
    const scale = Math.max(1, Math.hypot(ux, uy) * Math.hypot(vx, vy));
    if (cross / scale > epsilon || dist(prev, next) < 1) out.push(curr);
  }
  return out.length >= 3 ? out : points;
}

function polygonCentroid(points) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const cross = a.x * b.y - b.x * a.y;
    area2 += cross;
    cx += (a.x + b.x) * cross;
    cy += (a.y + b.y) * cross;
  }
  if (Math.abs(area2) < 1e-7) {
    return {
      x: points.reduce((sum, p) => sum + p.x, 0) / points.length,
      y: points.reduce((sum, p) => sum + p.y, 0) / points.length,
    };
  }
  return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y)) {
      const x = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
      if (point.x < x) inside = !inside;
    }
  }
  return inside;
}

function distanceToBoundary(point, boundary) {
  let best = Infinity;
  for (let i = 0; i < boundary.length; i++) {
    best = Math.min(best, perpendicularDistanceToSegment(point, boundary[i], boundary[(i + 1) % boundary.length]));
  }
  return best;
}

function boundaryBounds(boundary) {
  return boundary.reduce(
    (box, p) => ({
      minX: Math.min(box.minX, p.x),
      minY: Math.min(box.minY, p.y),
      maxX: Math.max(box.maxX, p.x),
      maxY: Math.max(box.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}

function interiorSampleSpacing(boundary, preset) {
  const area = Math.max(1, Math.abs(polygonArea(boundary)));
  return Math.max(30, Math.min(68, (Math.sqrt(area) / 6) * preset.interiorSpacingScale));
}

function addInteriorSamples(vertices, boundary, preset) {
  const box = boundaryBounds(boundary);
  const spacing = interiorSampleSpacing(boundary, preset);
  const rowHeight = spacing * Math.sqrt(3) * 0.5;
  const clearance = spacing * 0.38;
  let row = 0;
  for (let y = box.minY + rowHeight * 0.5; y <= box.maxY - rowHeight * 0.25; y += rowHeight) {
    const offset = row % 2 === 0 ? spacing * 0.5 : 0;
    for (let x = box.minX + offset; x <= box.maxX; x += spacing) {
      const p = { x, y };
      if (pointInPolygon(p, boundary) && distanceToBoundary(p, boundary) > clearance) {
        vertices.push(p);
      }
    }
    row += 1;
  }
}

function buildButterflyControlMesh(boundary, preset) {
  const vertices = boundary.map((p) => ({ x: p.x, y: p.y }));
  addInteriorSamples(vertices, boundary, preset);
  const points = vertices.map((p) => [p.x, p.y]);
  const edges = boundary.map((_, i) => [i, (i + 1) % boundary.length]);
  const triangles = cdt2d(points, edges, { exterior: false, delaunay: true });
  return {
    vertices,
    triangles,
    polygon: boundary,
    boundaryCount: boundary.length,
  };
}

function edgeKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function buildEdgeInfo(triangles) {
  const edges = new Map();
  triangles.forEach((tri) => {
    for (const [a, b, opposite] of [
      [tri[0], tri[1], tri[2]],
      [tri[1], tri[2], tri[0]],
      [tri[2], tri[0], tri[1]],
    ]) {
      const key = edgeKey(a, b);
      if (!edges.has(key)) edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), opposites: [] });
      edges.get(key).opposites.push(opposite);
    }
  });
  const boundaryNeighbors = new Map();
  for (const edge of edges.values()) {
    if (edge.opposites.length !== 1) continue;
    if (!boundaryNeighbors.has(edge.a)) boundaryNeighbors.set(edge.a, []);
    if (!boundaryNeighbors.has(edge.b)) boundaryNeighbors.set(edge.b, []);
    boundaryNeighbors.get(edge.a).push(edge.b);
    boundaryNeighbors.get(edge.b).push(edge.a);
  }
  return { edges, boundaryNeighbors };
}

function oppositeAcross(edges, a, b, exclude) {
  const edge = edges.get(edgeKey(a, b));
  if (!edge) return null;
  return edge.opposites.find((idx) => idx !== exclude) ?? null;
}

function addScaled(out, point, scale) {
  out.x += point.x * scale;
  out.y += point.y * scale;
}

function boundaryButterflyPoint(vertices, boundaryNeighbors, a, b) {
  const va = vertices[a];
  const vb = vertices[b];
  const prev = (boundaryNeighbors.get(a) || []).find((idx) => idx !== b);
  const next = (boundaryNeighbors.get(b) || []).find((idx) => idx !== a);
  if (prev == null || next == null) {
    return { x: (va.x + vb.x) * 0.5, y: (va.y + vb.y) * 0.5 };
  }
  const vp = vertices[prev];
  const vn = vertices[next];
  return {
    x: (9 * va.x + 9 * vb.x - vp.x - vn.x) / 16,
    y: (9 * va.y + 9 * vb.y - vp.y - vn.y) / 16,
  };
}

function butterflyPoint(vertices, topology, a, b) {
  const { edges, boundaryNeighbors } = topology;
  const edge = edges.get(edgeKey(a, b));
  const va = vertices[a];
  const vb = vertices[b];
  if (!edge || edge.opposites.length !== 2) {
    return boundaryButterflyPoint(vertices, boundaryNeighbors, a, b);
  }
  const [c, d] = edge.opposites;
  const outer = [
    oppositeAcross(edges, a, c, b),
    oppositeAcross(edges, b, c, a),
    oppositeAcross(edges, a, d, b),
    oppositeAcross(edges, b, d, a),
  ];
  if (outer.some((idx) => idx == null)) {
    return { x: (va.x + vb.x) * 0.5, y: (va.y + vb.y) * 0.5 };
  }
  const out = { x: 0, y: 0 };
  addScaled(out, va, 0.5);
  addScaled(out, vb, 0.5);
  addScaled(out, vertices[c], 0.125);
  addScaled(out, vertices[d], 0.125);
  outer.forEach((idx) => addScaled(out, vertices[idx], -0.0625));
  return out;
}

function butterflySubdivision(mesh, iterations = 1) {
  let vertices = mesh.vertices.map((p) => ({ x: p.x, y: p.y }));
  let triangles = mesh.triangles.map((tri) => [...tri]);
  for (let iteration = 0; iteration < iterations; iteration++) {
    const topology = buildEdgeInfo(triangles);
    const edgeVertices = new Map();
    const nextVertices = vertices.map((p) => ({ x: p.x, y: p.y }));
    const getEdgeVertex = (a, b) => {
      const key = edgeKey(a, b);
      if (!edgeVertices.has(key)) {
        edgeVertices.set(key, nextVertices.length);
        nextVertices.push(butterflyPoint(vertices, topology, a, b));
      }
      return edgeVertices.get(key);
    };
    const nextTriangles = [];
    for (const [a, b, c] of triangles) {
      const ab = getEdgeVertex(a, b);
      const bc = getEdgeVertex(b, c);
      const ca = getEdgeVertex(c, a);
      nextTriangles.push([a, ab, ca]);
      nextTriangles.push([ab, b, bc]);
      nextTriangles.push([ca, bc, c]);
      nextTriangles.push([ab, bc, ca]);
    }
    vertices = nextVertices;
    triangles = nextTriangles;
  }
  return { vertices, triangles, polygon: mesh.polygon, boundaryCount: mesh.boundaryCount };
}

function triangulatePolygon(rawPath, resolution = state.meshResolution) {
  const preset = resolutionPreset(resolution);
  let boundary = simplifyDrawnBoundary(rawPath, preset);
  if (boundary.length < 3) return null;
  if (polygonArea(boundary) < 0) boundary = boundary.slice().reverse();
  const controlMesh = buildButterflyControlMesh(boundary, preset);
  const mesh = butterflySubdivision(controlMesh, preset.subdivisions);
  mesh.sourcePath = rawPath.map((p) => ({ x: p.x, y: p.y }));
  mesh.resolution = resolution;
  mesh.resolutionName = preset.name;
  return mesh;
}

function flattenVertices(vertices) {
  const data = new Float64Array(vertices.length * 2);
  vertices.forEach((p, i) => {
    data[2 * i] = p.x;
    data[2 * i + 1] = p.y;
  });
  return data;
}

function flattenTriangles(triangles) {
  const data = new Uint32Array(triangles.length * 3);
  triangles.forEach((tri, i) => {
    data[3 * i] = tri[0];
    data[3 * i + 1] = tri[1];
    data[3 * i + 2] = tri[2];
  });
  return data;
}

function orderedConstraints() {
  return [...new Set([...state.anchors, ...state.controls])].sort((a, b) => a - b);
}

function compileSolver() {
  if (!state.mesh || !state.wasmReady) return false;
  const constrained = orderedConstraints();
  if (constrained.length < 2) {
    state.solver = null;
    return false;
  }
  const vertices = flattenVertices(state.mesh.vertices);
  const triangles = flattenTriangles(state.mesh.triangles);
  state.solver = new WasmArap(vertices, triangles, new Uint32Array(constrained));
  state.dirtySolver = false;
  return true;
}

function targetFor(idx) {
  if (state.anchors.has(idx)) return state.mesh.vertices[idx];
  return state.targets.get(idx) || state.mesh.vertices[idx];
}

function updateDeformation() {
  if (!state.mesh) return;
  if (state.dirtySolver && !compileSolver()) {
    state.deformed = state.mesh.vertices.map((p) => ({ ...p }));
    setStatus(`${state.mesh.vertices.length} vertices · ${state.mesh.resolutionName || resolutionPreset().name}`);
    draw();
    return;
  }
  if (!state.solver) {
    state.deformed = state.mesh.vertices.map((p) => ({ ...p }));
    draw();
    return;
  }
  const constrained = orderedConstraints();
  const targets = new Float64Array(constrained.length * 2);
  constrained.forEach((idx, i) => {
    const p = targetFor(idx);
    targets[2 * i] = p.x;
    targets[2 * i + 1] = p.y;
  });
  const t0 = performance.now();
  const result = state.solver.deform(targets, true);
  state.lastUpdateMs = performance.now() - t0;
  state.deformed = [];
  for (let i = 0; i < result.length; i += 2) {
    state.deformed.push({ x: result[i], y: result[i + 1] });
  }
  setStatus(
    `${state.mesh.vertices.length} vertices · ${state.mesh.triangles.length} triangles · ${state.mesh.resolutionName || resolutionPreset().name} · ${state.lastUpdateMs.toFixed(2)} ms`,
  );
  draw();
}

function nearestVertex(point, maxDistance = 16) {
  if (!state.mesh) return null;
  let best = null;
  let bestDistance = maxDistance;
  const vertices = state.deformed.length ? state.deformed : state.mesh.vertices;
  vertices.forEach((p, index) => {
    const d = dist(point, p);
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return best;
}

function setMode(mode) {
  state.mode = mode;
  toolButtons.forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  refreshCursor();
}

function toggleVertex(set, idx) {
  if (set.has(idx)) {
    set.delete(idx);
  } else {
    set.add(idx);
  }
}

function nearestIndexIn(vertices, point, used) {
  let best = null;
  let bestDistance = Infinity;
  vertices.forEach((p, index) => {
    if (used?.has(index)) return;
    const d = dist(point, p);
    if (d < bestDistance) {
      bestDistance = d;
      best = index;
    }
  });
  return best;
}

function captureHandleSnapshot() {
  if (!state.mesh) return null;
  return {
    anchors: [...state.anchors].map((idx) => ({ ...state.mesh.vertices[idx] })),
    controls: [...state.controls].map((idx) => ({
      rest: { ...state.mesh.vertices[idx] },
      target: { ...(state.targets.get(idx) || state.mesh.vertices[idx]) },
    })),
  };
}

function restoreHandleSnapshot(mesh, snapshot) {
  if (!snapshot) return;
  const used = new Set();
  for (const point of snapshot.anchors) {
    const idx = nearestIndexIn(mesh.vertices, point, used);
    if (idx == null) continue;
    used.add(idx);
    state.anchors.add(idx);
  }
  for (const control of snapshot.controls) {
    const idx = nearestIndexIn(mesh.vertices, control.rest, used);
    if (idx == null) continue;
    used.add(idx);
    state.controls.add(idx);
    state.targets.set(idx, control.target);
  }
}

function buildAndInstallMesh(path, autoHandles = false, handleSnapshot = null) {
  const mesh = triangulatePolygon(path);
  if (mesh) installMesh(mesh, autoHandles, handleSnapshot);
  else draw();
}

function scheduleMeshBuild(path, autoHandles = false, handleSnapshot = null) {
  const pathCopy = path.map((p) => ({ x: p.x, y: p.y }));
  runAfterNextPaint(() => buildAndInstallMesh(pathCopy, autoHandles, handleSnapshot), "Tessellating mesh...");
}

function scheduleDeformationUpdate() {
  runAfterNextPaint(updateDeformation, "Updating constraints...");
}

function clearShape() {
  state.mesh = null;
  state.deformed = [];
  state.anchors.clear();
  state.controls.clear();
  state.targets.clear();
  state.solver = null;
  state.dirtySolver = true;
  state.drawPath = [];
  state.sourcePath = null;
  setStatus("");
  draw();
}

function installMesh(mesh, autoHandles = false, handleSnapshot = null) {
  state.mesh = mesh;
  state.sourcePath = (mesh.sourcePath || mesh.polygon).map((p) => ({ x: p.x, y: p.y }));
  state.deformed = mesh.vertices.map((p) => ({ ...p }));
  state.anchors.clear();
  state.controls.clear();
  state.targets.clear();
  state.solver = null;
  state.dirtySolver = true;
  if (autoHandles) {
    const candidates = mesh.vertices
      .slice(0, mesh.boundaryCount || mesh.vertices.length)
      .map((p, i) => ({ p, i }));
    const left = [...candidates]
      .sort((a, b) => a.p.x - b.p.x)
      .slice(0, 3)
      .map(({ i }) => i);
    const right = [...candidates]
      .sort((a, b) => b.p.x - a.p.x)
      .slice(0, 3)
      .map(({ i }) => i);
    left.forEach((idx) => state.anchors.add(idx));
    right.forEach((idx) => {
      state.controls.add(idx);
      const p = mesh.vertices[idx];
      state.targets.set(idx, { x: p.x + 90, y: p.y - 35 + (p.y % 40) * 0.35 });
    });
  } else {
    restoreHandleSnapshot(mesh, handleSnapshot);
  }
  setMode(autoHandles ? "move" : handleSnapshot ? state.mode : "anchor");
  updateDeformation();
}

function examplePath() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return [
    { x: w * 0.2, y: h * 0.42 },
    { x: w * 0.42, y: h * 0.34 },
    { x: w * 0.72, y: h * 0.38 },
    { x: w * 0.82, y: h * 0.5 },
    { x: w * 0.68, y: h * 0.62 },
    { x: w * 0.36, y: h * 0.6 },
    { x: w * 0.18, y: h * 0.53 },
  ];
}

function loadExample(defer = true) {
  const path = examplePath();
  if (defer) scheduleMeshBuild(path, true);
  else buildAndInstallMesh(path, true);
}

function drawTriangleMesh(vertices, color, fill) {
  if (!state.mesh) return;
  ctx.lineJoin = "round";
  for (const tri of state.mesh.triangles) {
    const a = vertices[tri[0]];
    const b = vertices[tri[1]];
    const c = vertices[tri[2]];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

function drawHandles() {
  if (!state.mesh) return;
  const vertices = state.deformed.length ? state.deformed : state.mesh.vertices;
  for (const idx of state.anchors) {
    const p = vertices[idx];
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--anchor");
    ctx.fillRect(p.x - 5, p.y - 5, 10, 10);
  }
  for (const idx of state.controls) {
    const p = targetFor(idx);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--control");
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

function drawDrawPath() {
  if (!state.drawPath.length) return;
  ctx.beginPath();
  ctx.moveTo(state.drawPath[0].x, state.drawPath[0].y);
  for (const p of state.drawPath.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  ctx.lineWidth = 2.5;
  ctx.stroke();
}

function draw() {
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (state.mesh) {
    const rest = state.mesh.vertices;
    const deformed = state.deformed.length ? state.deformed : rest;
    drawTriangleMesh(deformed, state.showMesh ? "#4f6f8a" : "rgba(0,0,0,0)", "rgba(238, 243, 244, 0.72)");
    if (state.showMesh) drawTriangleMesh(rest, "rgba(32,34,37,0.16)", null);
    drawHandles();
  }
  drawDrawPath();
}

canvas.addEventListener("pointerdown", (event) => {
  if (state.busy) return;
  canvas.setPointerCapture(event.pointerId);
  const p = pointerPoint(event);
  if (state.mode === "draw") {
    state.drawing = true;
    state.drawPath = [];
    appendDrawPoint(p);
    draw();
    return;
  }
  const near = nearestVertex(p);
  if (near == null) return;
  if (state.controls.has(near)) {
    state.draggingControl = near;
    canvas.style.cursor = "grabbing";
    return;
  }
  if (state.mode === "anchor") {
    state.controls.delete(near);
    state.targets.delete(near);
    toggleVertex(state.anchors, near);
    state.dirtySolver = true;
    draw();
    scheduleDeformationUpdate();
  } else if (state.mode === "control") {
    state.anchors.delete(near);
    toggleVertex(state.controls, near);
    if (state.controls.has(near)) state.targets.set(near, state.deformed[near] || state.mesh.vertices[near]);
    state.dirtySolver = true;
    draw();
    scheduleDeformationUpdate();
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (state.busy) return;
  const p = pointerPoint(event);
  if (state.drawing) {
    if (appendDrawPoint(p)) draw();
    return;
  }
  if (state.draggingControl != null) {
    state.targets.set(state.draggingControl, p);
    updateDeformation();
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (state.busy) return;
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  if (state.drawing) {
    state.drawing = false;
    appendDrawPoint(pointerPoint(event));
    const path = state.drawPath.map((p) => ({ x: p.x, y: p.y }));
    state.drawPath = [];
    draw();
    scheduleMeshBuild(path);
  }
  state.draggingControl = null;
  refreshCursor();
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (!state.busy) setMode(button.dataset.mode);
  });
});

meshToggle.addEventListener("click", () => {
  if (state.busy) return;
  state.showMesh = !state.showMesh;
  meshToggle.classList.toggle("active", state.showMesh);
  draw();
});

resolutionSlider.addEventListener("input", () => {
  state.meshResolution = Number(resolutionSlider.value);
  updateResolutionDisplay();
});

resolutionSlider.addEventListener("change", () => {
  if (!state.sourcePath || state.busy) return;
  scheduleMeshBuild(state.sourcePath, false, captureHandleSnapshot());
});

exampleButton.addEventListener("click", () => {
  if (!state.busy) loadExample(true);
});
clearButton.addEventListener("click", () => {
  if (!state.busy) clearShape();
});
window.addEventListener("resize", resizeCanvas);

updateResolutionDisplay();
await init();
state.wasmReady = true;
resizeCanvas();
loadExample(false);
