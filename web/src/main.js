import {
  CircleDot,
  Grid,
  Move,
  Pencil,
  Pin,
  RotateCcw,
  Trash2,
  createIcons,
} from "lucide";
import init, { WasmArap } from "../pkg/arap2d.js";
import "./styles.css";

const canvas = document.querySelector("#canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.querySelector("#status");
const toolButtons = [...document.querySelectorAll(".tool[data-mode]")];
const meshToggle = document.querySelector("#meshToggle");
const exampleButton = document.querySelector("#exampleButton");
const clearButton = document.querySelector("#clearButton");

createIcons({
  icons: {
    CircleDot,
    Grid,
    Move,
    Pencil,
    Pin,
    RotateCcw,
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
};

function setStatus(text) {
  statusEl.textContent = text;
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

function simplifyPath(points, spacing = 9) {
  const out = [];
  for (const p of points) {
    if (!out.length || dist(out[out.length - 1], p) >= spacing) {
      out.push(p);
    }
  }
  if (out.length > 2 && dist(out[0], out[out.length - 1]) < spacing * 1.5) {
    out.pop();
  }
  return out;
}

function uniquePoints(points, precision = 1000) {
  const seen = new Set();
  const out = [];
  for (const p of points) {
    const key = `${Math.round(p.x * precision)}:${Math.round(p.y * precision)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
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

function ringScales(boundaryCount) {
  if (boundaryCount <= 10) return [1, 0.7, 0.43, 0.18];
  if (boundaryCount <= 28) return [1, 0.64, 0.3];
  return [1, 0.48];
}

function buildButterflyControlMesh(boundary) {
  const center = polygonCentroid(boundary);
  const scales = ringScales(boundary.length);
  const vertices = [];
  const ringIndices = [];
  for (const scale of scales) {
    const ring = [];
    for (const p of boundary) {
      ring.push(vertices.length);
      vertices.push({
        x: center.x + (p.x - center.x) * scale,
        y: center.y + (p.y - center.y) * scale,
      });
    }
    ringIndices.push(ring);
  }
  const triangles = [];
  for (let r = 0; r < ringIndices.length - 1; r++) {
    const outer = ringIndices[r];
    const inner = ringIndices[r + 1];
    for (let i = 0; i < boundary.length; i++) {
      const next = (i + 1) % boundary.length;
      if ((i + r) % 2 === 0) {
        triangles.push([outer[i], outer[next], inner[next]]);
        triangles.push([outer[i], inner[next], inner[i]]);
      } else {
        triangles.push([outer[i], outer[next], inner[i]]);
        triangles.push([outer[next], inner[next], inner[i]]);
      }
    }
  }
  const centerIndex = vertices.length;
  vertices.push(center);
  const inner = ringIndices[ringIndices.length - 1];
  for (let i = 0; i < boundary.length; i++) {
    triangles.push([inner[i], inner[(i + 1) % boundary.length], centerIndex]);
  }
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

function butterflyIterationCount(seedTriangleCount) {
  return seedTriangleCount < 28 ? 2 : 1;
}

function triangulatePolygon(rawPath) {
  let boundary = removeNearCollinear(uniquePoints(simplifyPath(rawPath, 7)));
  if (boundary.length < 3) return null;
  if (polygonArea(boundary) < 0) boundary = boundary.slice().reverse();
  const controlMesh = buildButterflyControlMesh(boundary);
  return butterflySubdivision(controlMesh, butterflyIterationCount(controlMesh.triangles.length));
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
    setStatus(`${state.mesh.vertices.length} vertices`);
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
    `${state.mesh.vertices.length} vertices · ${state.mesh.triangles.length} triangles · ${state.lastUpdateMs.toFixed(2)} ms`,
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
  canvas.style.cursor = mode === "move" ? "grab" : "crosshair";
}

function toggleVertex(set, idx) {
  if (set.has(idx)) {
    set.delete(idx);
  } else {
    set.add(idx);
  }
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
  setStatus("");
  draw();
}

function installMesh(mesh, autoHandles = false) {
  state.mesh = mesh;
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
  }
  setMode(autoHandles ? "move" : "anchor");
  updateDeformation();
}

function loadExample() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const path = [
    { x: w * 0.2, y: h * 0.42 },
    { x: w * 0.42, y: h * 0.34 },
    { x: w * 0.72, y: h * 0.38 },
    { x: w * 0.82, y: h * 0.5 },
    { x: w * 0.68, y: h * 0.62 },
    { x: w * 0.36, y: h * 0.6 },
    { x: w * 0.18, y: h * 0.53 },
  ];
  const mesh = triangulatePolygon(path);
  if (mesh) installMesh(mesh, true);
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
  canvas.setPointerCapture(event.pointerId);
  const p = pointerPoint(event);
  if (state.mode === "draw") {
    state.drawing = true;
    state.drawPath = [p];
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
    updateDeformation();
  } else if (state.mode === "control") {
    state.anchors.delete(near);
    toggleVertex(state.controls, near);
    if (state.controls.has(near)) state.targets.set(near, state.deformed[near] || state.mesh.vertices[near]);
    state.dirtySolver = true;
    updateDeformation();
  }
});

canvas.addEventListener("pointermove", (event) => {
  const p = pointerPoint(event);
  if (state.drawing) {
    if (dist(state.drawPath[state.drawPath.length - 1], p) > 5) {
      state.drawPath.push(p);
      draw();
    }
    return;
  }
  if (state.draggingControl != null) {
    state.targets.set(state.draggingControl, p);
    updateDeformation();
  }
});

canvas.addEventListener("pointerup", (event) => {
  canvas.releasePointerCapture(event.pointerId);
  if (state.drawing) {
    state.drawing = false;
    const mesh = triangulatePolygon(state.drawPath);
    state.drawPath = [];
    if (mesh) installMesh(mesh);
    else draw();
  }
  state.draggingControl = null;
  canvas.style.cursor = state.mode === "move" ? "grab" : "crosshair";
});

toolButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

meshToggle.addEventListener("click", () => {
  state.showMesh = !state.showMesh;
  meshToggle.classList.toggle("active", state.showMesh);
  draw();
});

exampleButton.addEventListener("click", loadExample);
clearButton.addEventListener("click", clearShape);
window.addEventListener("resize", resizeCanvas);

await init();
state.wasmReady = true;
resizeCanvas();
loadExample();
