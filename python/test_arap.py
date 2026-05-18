import unittest
from math import pi

from arap import CompiledARAP, edge_length_rms, grid_mesh, max_distance, transform_points


class ARAPTests(unittest.TestCase):
    def test_global_translation_is_exact(self):
        mesh = grid_mesh(4, 3)
        constrained = [0, 4, 15, 19]
        solver = CompiledARAP(mesh, constrained)
        target = {idx: (mesh.vertices[idx][0] + 2.0, mesh.vertices[idx][1] - 0.75) for idx in constrained}
        result = solver.deform(target)
        expected = [(x + 2.0, y - 0.75) for x, y in mesh.vertices]
        self.assertLess(max_distance(result, expected), 1e-7)

    def test_global_rotation_is_exact(self):
        mesh = grid_mesh(5, 4)
        constrained = [0, 5, 24, 29]
        solver = CompiledARAP(mesh, constrained)
        expected = transform_points(mesh.vertices, pi / 5.0, translation=(0.4, 0.2), pivot=(0.5, 0.5))
        target = {idx: expected[idx] for idx in constrained}
        result = solver.deform(target)
        self.assertLess(max_distance(result, expected), 1e-6)

    def test_scale_adjustment_preserves_edges_better_than_first_step(self):
        mesh = grid_mesh(8, 3, width=2.0, height=0.6)
        left = [0, 9, 18, 27]
        right = [8, 17, 26, 35]
        constrained = left + right
        solver = CompiledARAP(mesh, constrained)
        target = {}
        for idx in left:
            x, y = mesh.vertices[idx]
            target[idx] = (x - 0.25, y)
        for idx in right:
            x, y = mesh.vertices[idx]
            target[idx] = (x + 0.9, y + 0.15)
        first = solver.deform(target, scale_adjust=False)
        final = solver.deform(target, scale_adjust=True)
        self.assertLess(edge_length_rms(mesh, final), edge_length_rms(mesh, first))


if __name__ == "__main__":
    unittest.main()
