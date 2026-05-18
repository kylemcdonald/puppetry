from __future__ import annotations

from dataclasses import dataclass
from math import cos, sin, sqrt
from typing import Dict, Iterable, List, Sequence, Tuple


Vec2 = Tuple[float, float]
Tri = Tuple[int, int, int]


@dataclass(frozen=True)
class Mesh:
    vertices: List[Vec2]
    triangles: List[Tri]


@dataclass
class EdgeInfo:
    i: int
    j: int
    context: List[int]
    c_coeffs: List[Tuple[int, float]]
    s_coeffs: List[Tuple[int, float]]
    weight: float = 1.0


def _dot(a: Vec2, b: Vec2) -> float:
    return a[0] * b[0] + a[1] * b[1]


def _sub(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] - b[0], a[1] - b[1])


def _add(a: Vec2, b: Vec2) -> Vec2:
    return (a[0] + b[0], a[1] + b[1])


def _mul(a: Vec2, s: float) -> Vec2:
    return (a[0] * s, a[1] * s)


def _length(a: Vec2) -> float:
    return sqrt(_dot(a, a))


def _mat_transpose(a: List[List[float]]) -> List[List[float]]:
    if not a:
        return []
    return [list(col) for col in zip(*a)]


def _mat_mul(a: List[List[float]], b: List[List[float]]) -> List[List[float]]:
    rows = len(a)
    inner = len(b)
    cols = len(b[0]) if b else 0
    out = [[0.0 for _ in range(cols)] for _ in range(rows)]
    for r in range(rows):
        for k in range(inner):
            av = a[r][k]
            if av == 0.0:
                continue
            brow = b[k]
            for c in range(cols):
                out[r][c] += av * brow[c]
    return out


def _invert_small(a: List[List[float]]) -> List[List[float]]:
    n = len(a)
    aug = [row[:] + [1.0 if i == j else 0.0 for j in range(n)] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(aug[r][col]))
        if abs(aug[pivot][col]) < 1e-12:
            raise ValueError("singular matrix")
        if pivot != col:
            aug[col], aug[pivot] = aug[pivot], aug[col]
        inv_pivot = 1.0 / aug[col][col]
        for c in range(col, 2 * n):
            aug[col][c] *= inv_pivot
        for r in range(n):
            if r == col:
                continue
            factor = aug[r][col]
            if factor == 0.0:
                continue
            for c in range(col, 2 * n):
                aug[r][c] -= factor * aug[col][c]
    return [row[n:] for row in aug]


def _cholesky(a: List[List[float]]) -> List[List[float]]:
    n = len(a)
    l = [[0.0 for _ in range(n)] for _ in range(n)]
    for i in range(n):
        for j in range(i + 1):
            s = a[i][j]
            for k in range(j):
                s -= l[i][k] * l[j][k]
            if i == j:
                if s <= 1e-12:
                    s = 1e-12
                l[i][j] = sqrt(s)
            else:
                l[i][j] = s / l[j][j]
    return l


def _cholesky_solve(l: List[List[float]], b: List[float]) -> List[float]:
    n = len(l)
    y = [0.0 for _ in range(n)]
    for i in range(n):
        s = b[i]
        for k in range(i):
            s -= l[i][k] * y[k]
        y[i] = s / l[i][i]
    x = [0.0 for _ in range(n)]
    for i in range(n - 1, -1, -1):
        s = y[i]
        for k in range(i + 1, n):
            s -= l[k][i] * x[k]
        x[i] = s / l[i][i]
    return x


def _zeros(n: int, m: int) -> List[List[float]]:
    return [[0.0 for _ in range(m)] for _ in range(n)]


def _add_normal_row(normal: List[List[float]], row: Dict[int, float], weight: float) -> None:
    items = [(i, v) for i, v in row.items() if abs(v) > 1e-14]
    for i, vi in items:
        nr = normal[i]
        for j, vj in items:
            nr[j] += weight * vi * vj


def _submatrix(a: List[List[float]], rows: Sequence[int], cols: Sequence[int]) -> List[List[float]]:
    return [[a[r][c] for c in cols] for r in rows]


def _mat_vec(a: List[List[float]], x: Sequence[float]) -> List[float]:
    return [sum(v * x[c] for c, v in enumerate(row)) for row in a]


def _extract_coords(vertices: Sequence[Vec2], indices: Sequence[int]) -> List[float]:
    out: List[float] = []
    for idx in indices:
        out.extend(vertices[idx])
    return out


def _scatter_interleaved(values: Sequence[float], indices: Sequence[int], n_vertices: int) -> List[Vec2]:
    out = [(0.0, 0.0) for _ in range(n_vertices)]
    for local, idx in enumerate(indices):
        out[idx] = (values[2 * local], values[2 * local + 1])
    return out


def _edge_adjacency(triangles: Sequence[Tri]) -> Dict[Tuple[int, int], List[int]]:
    edges: Dict[Tuple[int, int], List[int]] = {}
    for a, b, c in triangles:
        for i, j, opp in ((a, b, c), (b, c, a), (c, a, b)):
            key = (i, j) if i < j else (j, i)
            edges.setdefault(key, []).append(opp)
    return edges


def _similarity_coefficients(vertices: Sequence[Vec2], context: Sequence[int]) -> Tuple[List[Tuple[int, float]], List[Tuple[int, float]]]:
    rows: List[List[float]] = []
    for idx in context:
        x, y = vertices[idx]
        rows.append([x, y, 1.0, 0.0])
        rows.append([y, -x, 0.0, 1.0])
    at = _mat_transpose(rows)
    pinv = _mat_mul(_invert_small(_mat_mul(at, rows)), at)
    c_coeffs: List[Tuple[int, float]] = []
    s_coeffs: List[Tuple[int, float]] = []
    for local, idx in enumerate(context):
        c_coeffs.append((2 * idx, pinv[0][2 * local]))
        c_coeffs.append((2 * idx + 1, pinv[0][2 * local + 1]))
        s_coeffs.append((2 * idx, pinv[1][2 * local]))
        s_coeffs.append((2 * idx + 1, pinv[1][2 * local + 1]))
    return c_coeffs, s_coeffs


def _build_edges(mesh: Mesh) -> List[EdgeInfo]:
    adjacency = _edge_adjacency(mesh.triangles)
    edges: List[EdgeInfo] = []
    for (i, j), opposites in sorted(adjacency.items()):
        context = [i, j]
        for opp in opposites:
            if opp not in context:
                context.append(opp)
        c_coeffs, s_coeffs = _similarity_coefficients(mesh.vertices, context)
        edges.append(EdgeInfo(i=i, j=j, context=context, c_coeffs=c_coeffs, s_coeffs=s_coeffs))
    return edges


def _assemble_step1_normal(mesh: Mesh, edges: Sequence[EdgeInfo]) -> List[List[float]]:
    n = len(mesh.vertices) * 2
    normal = _zeros(n, n)
    for edge in edges:
        pi = mesh.vertices[edge.i]
        pj = mesh.vertices[edge.j]
        ex, ey = _sub(pj, pi)
        row_x: Dict[int, float] = {2 * edge.i: -1.0, 2 * edge.j: 1.0}
        row_y: Dict[int, float] = {2 * edge.i + 1: -1.0, 2 * edge.j + 1: 1.0}
        for idx, coeff in edge.c_coeffs:
            row_x[idx] = row_x.get(idx, 0.0) - ex * coeff
            row_y[idx] = row_y.get(idx, 0.0) - ey * coeff
        for idx, coeff in edge.s_coeffs:
            row_x[idx] = row_x.get(idx, 0.0) - ey * coeff
            row_y[idx] = row_y.get(idx, 0.0) + ex * coeff
        _add_normal_row(normal, row_x, edge.weight)
        _add_normal_row(normal, row_y, edge.weight)
    return normal


def _assemble_step2_normal(mesh: Mesh, edges: Sequence[EdgeInfo]) -> List[List[float]]:
    n = len(mesh.vertices)
    normal = _zeros(n, n)
    for edge in edges:
        i, j, w = edge.i, edge.j, edge.weight
        normal[i][i] += w
        normal[j][j] += w
        normal[i][j] -= w
        normal[j][i] -= w
    return normal


class CompiledARAP:
    def __init__(self, mesh: Mesh, constrained: Sequence[int]):
        if len(set(constrained)) < 2:
            raise ValueError("at least two constrained vertices are required")
        self.mesh = mesh
        self.edges = _build_edges(mesh)
        self.constrained = sorted(set(constrained))
        self.free = [i for i in range(len(mesh.vertices)) if i not in set(self.constrained)]
        self._compile_step1()
        self._compile_step2()

    def _compile_step1(self) -> None:
        normal = _assemble_step1_normal(self.mesh, self.edges)
        free_dofs: List[int] = []
        constrained_dofs: List[int] = []
        for idx in self.free:
            free_dofs.extend([2 * idx, 2 * idx + 1])
        for idx in self.constrained:
            constrained_dofs.extend([2 * idx, 2 * idx + 1])
        self.step1_free_dofs = free_dofs
        self.step1_constrained_dofs = constrained_dofs
        self.step1_fc = _submatrix(normal, free_dofs, constrained_dofs)
        self.step1_l = _cholesky(_submatrix(normal, free_dofs, free_dofs))

    def _compile_step2(self) -> None:
        normal = _assemble_step2_normal(self.mesh, self.edges)
        self.step2_fc = _submatrix(normal, self.free, self.constrained)
        self.step2_l = _cholesky(_submatrix(normal, self.free, self.free))

    def deform(self, handle_targets: Dict[int, Vec2], scale_adjust: bool = True) -> List[Vec2]:
        missing = [idx for idx in self.constrained if idx not in handle_targets]
        if missing:
            raise ValueError(f"missing targets for constrained vertices: {missing}")
        q = _extract_coords([handle_targets[i] for i in self.constrained], range(len(self.constrained)))
        fc_q = _mat_vec(self.step1_fc, q)
        free_values = _cholesky_solve(self.step1_l, [-v for v in fc_q])
        intermediate = _scatter_interleaved(free_values, self.free, len(self.mesh.vertices))
        for idx in self.constrained:
            intermediate[idx] = handle_targets[idx]
        if not scale_adjust:
            return intermediate
        return self._scale_adjust(intermediate, handle_targets)

    def _scale_adjust(self, intermediate: Sequence[Vec2], handle_targets: Dict[int, Vec2]) -> List[Vec2]:
        flat: List[float] = []
        for x, y in intermediate:
            flat.extend([x, y])
        rhs_x = [0.0 for _ in self.mesh.vertices]
        rhs_y = [0.0 for _ in self.mesh.vertices]
        for edge in self.edges:
            c = sum(coeff * flat[idx] for idx, coeff in edge.c_coeffs)
            s = sum(coeff * flat[idx] for idx, coeff in edge.s_coeffs)
            norm = sqrt(c * c + s * s)
            if norm < 1e-12:
                c, s = 1.0, 0.0
            else:
                c, s = c / norm, s / norm
            ex, ey = _sub(self.mesh.vertices[edge.j], self.mesh.vertices[edge.i])
            tx = c * ex + s * ey
            ty = -s * ex + c * ey
            w = edge.weight
            rhs_x[edge.i] -= w * tx
            rhs_x[edge.j] += w * tx
            rhs_y[edge.i] -= w * ty
            rhs_y[edge.j] += w * ty
        constrained_x = [handle_targets[i][0] for i in self.constrained]
        constrained_y = [handle_targets[i][1] for i in self.constrained]
        hcx = _mat_vec(self.step2_fc, constrained_x)
        hcy = _mat_vec(self.step2_fc, constrained_y)
        bx = [rhs_x[idx] - hcx[row] for row, idx in enumerate(self.free)]
        by = [rhs_y[idx] - hcy[row] for row, idx in enumerate(self.free)]
        x = _cholesky_solve(self.step2_l, bx)
        y = _cholesky_solve(self.step2_l, by)
        out = list(intermediate)
        for local, idx in enumerate(self.free):
            out[idx] = (x[local], y[local])
        for idx in self.constrained:
            out[idx] = handle_targets[idx]
        return out


def grid_mesh(cols: int, rows: int, width: float = 1.0, height: float = 1.0) -> Mesh:
    vertices: List[Vec2] = []
    for y in range(rows + 1):
        for x in range(cols + 1):
            vertices.append((width * x / cols, height * y / rows))
    triangles: List[Tri] = []
    stride = cols + 1
    for y in range(rows):
        for x in range(cols):
            a = y * stride + x
            b = a + 1
            c = a + stride
            d = c + 1
            triangles.append((a, b, d))
            triangles.append((a, d, c))
    return Mesh(vertices, triangles)


def transform_points(points: Iterable[Vec2], angle: float, translation: Vec2 = (0.0, 0.0), pivot: Vec2 = (0.0, 0.0)) -> List[Vec2]:
    ca = cos(angle)
    sa = sin(angle)
    out: List[Vec2] = []
    for p in points:
        x, y = _sub(p, pivot)
        out.append((pivot[0] + ca * x + sa * y + translation[0], pivot[1] - sa * x + ca * y + translation[1]))
    return out


def edge_length_rms(mesh: Mesh, vertices: Sequence[Vec2]) -> float:
    edges = _build_edges(mesh)
    err = 0.0
    for edge in edges:
        rest = _length(_sub(mesh.vertices[edge.j], mesh.vertices[edge.i]))
        now = _length(_sub(vertices[edge.j], vertices[edge.i]))
        err += (now - rest) * (now - rest)
    return sqrt(err / max(1, len(edges)))


def max_distance(a: Sequence[Vec2], b: Sequence[Vec2]) -> float:
    return max(_length(_sub(pa, pb)) for pa, pb in zip(a, b))

