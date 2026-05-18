from pathlib import Path

from PIL import Image, ImageDraw

from arap import CompiledARAP, Mesh, Vec2, edge_length_rms, grid_mesh


def _bounds(point_sets):
    xs = []
    ys = []
    for points in point_sets:
        for x, y in points:
            xs.append(x)
            ys.append(y)
    return min(xs), min(ys), max(xs), max(ys)


def _project(p: Vec2, bounds, size=(960, 520), margin=44):
    min_x, min_y, max_x, max_y = bounds
    sx = (size[0] - 2 * margin) / max(1e-9, max_x - min_x)
    sy = (size[1] - 2 * margin) / max(1e-9, max_y - min_y)
    s = min(sx, sy)
    x = margin + (p[0] - min_x) * s
    y = size[1] - margin - (p[1] - min_y) * s
    return x, y


def draw_mesh(path: Path, mesh: Mesh, rest, first, final, handles):
    image = Image.new("RGB", (960, 520), "white")
    draw = ImageDraw.Draw(image)
    bounds = _bounds([rest, first, final])
    for vertices, color, width in ((rest, (190, 190, 190), 1), (first, (235, 145, 45), 1), (final, (35, 96, 180), 2)):
        for tri in mesh.triangles:
            pts = [_project(vertices[i], bounds) for i in tri]
            draw.line([pts[0], pts[1], pts[2], pts[0]], fill=color, width=width)
    for idx in handles:
        x, y = _project(final[idx], bounds)
        draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=(210, 35, 40))
    draw.text((24, 18), "gray: rest   orange: first step   blue: scale adjusted", fill=(30, 30, 30))
    image.save(path)


def main():
    out_dir = Path("artifacts/python")
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh = grid_mesh(12, 4, width=3.0, height=0.9)
    stride = 13
    left = [0, stride, 2 * stride, 3 * stride, 4 * stride]
    right = [12, 12 + stride, 12 + 2 * stride, 12 + 3 * stride, 12 + 4 * stride]
    handles = left + right
    solver = CompiledARAP(mesh, handles)
    target = {}
    for idx in left:
        x, y = mesh.vertices[idx]
        target[idx] = (x - 0.35, y + 0.15)
    for local, idx in enumerate(right):
        x, y = mesh.vertices[idx]
        target[idx] = (x + 0.75, y + 0.35 + 0.25 * (local - 2))
    first = solver.deform(target, scale_adjust=False)
    final = solver.deform(target, scale_adjust=True)
    draw_mesh(out_dir / "bar_deformation.png", mesh, mesh.vertices, first, final, handles)
    print(f"first-step edge RMS: {edge_length_rms(mesh, first):.6f}")
    print(f"scale-adjusted edge RMS: {edge_length_rms(mesh, final):.6f}")
    print(f"wrote {out_dir / 'bar_deformation.png'}")


if __name__ == "__main__":
    main()
