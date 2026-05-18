use std::collections::{BTreeMap, BTreeSet};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Vec2 {
    pub x: f64,
    pub y: f64,
}

impl Vec2 {
    pub fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }

    fn sub(self, other: Self) -> Self {
        Self::new(self.x - other.x, self.y - other.y)
    }

    fn length(self) -> f64 {
        (self.x * self.x + self.y * self.y).sqrt()
    }
}

#[derive(Clone, Debug)]
pub struct Mesh {
    pub vertices: Vec<Vec2>,
    pub triangles: Vec<[usize; 3]>,
}

#[derive(Clone, Debug)]
struct Coeff {
    dof: usize,
    value: f64,
}

#[derive(Clone, Debug)]
struct EdgeInfo {
    i: usize,
    j: usize,
    c_coeffs: Vec<Coeff>,
    s_coeffs: Vec<Coeff>,
    weight: f64,
}

#[derive(Clone, Debug)]
struct Cholesky {
    n: usize,
    l: Vec<f64>,
}

impl Cholesky {
    fn factor(a: &[f64], n: usize) -> Self {
        let mut l = vec![0.0; n * n];
        for i in 0..n {
            for j in 0..=i {
                let mut s = a[i * n + j];
                for k in 0..j {
                    s -= l[i * n + k] * l[j * n + k];
                }
                if i == j {
                    l[i * n + j] = s.max(1e-12).sqrt();
                } else {
                    l[i * n + j] = s / l[j * n + j];
                }
            }
        }
        Self { n, l }
    }

    fn solve(&self, b: &[f64]) -> Vec<f64> {
        let n = self.n;
        let mut y = vec![0.0; n];
        for i in 0..n {
            let mut s = b[i];
            for k in 0..i {
                s -= self.l[i * n + k] * y[k];
            }
            y[i] = s / self.l[i * n + i];
        }
        let mut x = vec![0.0; n];
        for i in (0..n).rev() {
            let mut s = y[i];
            for k in (i + 1)..n {
                s -= self.l[k * n + i] * x[k];
            }
            x[i] = s / self.l[i * n + i];
        }
        x
    }
}

#[derive(Clone, Debug)]
pub struct CompiledArap {
    mesh: Mesh,
    edges: Vec<EdgeInfo>,
    constrained: Vec<usize>,
    free: Vec<usize>,
    step1_fc: Vec<f64>,
    step1_fc_cols: usize,
    step1_l: Cholesky,
    step2_fc: Vec<f64>,
    step2_fc_cols: usize,
    step2_l: Cholesky,
}

impl CompiledArap {
    pub fn new(mesh: Mesh, constrained: &[usize]) -> Result<Self, String> {
        let constrained_set: BTreeSet<usize> = constrained.iter().copied().collect();
        if constrained_set.len() < 2 {
            return Err("at least two constrained vertices are required".to_string());
        }
        if constrained_set
            .iter()
            .any(|idx| *idx >= mesh.vertices.len())
        {
            return Err("constraint index out of range".to_string());
        }
        let constrained: Vec<usize> = constrained_set.into_iter().collect();
        let constrained_lookup: BTreeSet<usize> = constrained.iter().copied().collect();
        let free = (0..mesh.vertices.len())
            .filter(|idx| !constrained_lookup.contains(idx))
            .collect::<Vec<_>>();
        let edges = build_edges(&mesh)?;
        let step1_normal = assemble_step1_normal(&mesh, &edges);
        let mut free_dofs = Vec::with_capacity(free.len() * 2);
        let mut constrained_dofs = Vec::with_capacity(constrained.len() * 2);
        for idx in &free {
            free_dofs.push(2 * idx);
            free_dofs.push(2 * idx + 1);
        }
        for idx in &constrained {
            constrained_dofs.push(2 * idx);
            constrained_dofs.push(2 * idx + 1);
        }
        let total_dofs = mesh.vertices.len() * 2;
        let step1_ff = submatrix(&step1_normal, total_dofs, &free_dofs, &free_dofs);
        let step1_fc = submatrix(&step1_normal, total_dofs, &free_dofs, &constrained_dofs);
        let step2_normal = assemble_step2_normal(mesh.vertices.len(), &edges);
        let step2_ff = submatrix(&step2_normal, mesh.vertices.len(), &free, &free);
        let step2_fc = submatrix(&step2_normal, mesh.vertices.len(), &free, &constrained);
        let step2_size = free.len();
        let step2_fc_cols = constrained.len();
        Ok(Self {
            mesh,
            edges,
            constrained,
            free,
            step1_fc_cols: constrained_dofs.len(),
            step1_fc,
            step1_l: Cholesky::factor(&step1_ff, free_dofs.len()),
            step2_fc_cols,
            step2_fc,
            step2_l: Cholesky::factor(&step2_ff, step2_size),
        })
    }

    pub fn constrained(&self) -> &[usize] {
        &self.constrained
    }

    pub fn deform(&self, targets: &[Vec2], scale_adjust: bool) -> Result<Vec<Vec2>, String> {
        if targets.len() != self.constrained.len() {
            return Err("target count must match constrained vertex count".to_string());
        }
        let mut q = Vec::with_capacity(targets.len() * 2);
        for target in targets {
            q.push(target.x);
            q.push(target.y);
        }
        let fc_q = mat_vec(&self.step1_fc, self.free.len() * 2, self.step1_fc_cols, &q);
        let rhs = fc_q.into_iter().map(|v| -v).collect::<Vec<_>>();
        let free_values = self.step1_l.solve(&rhs);
        let mut intermediate = vec![Vec2::default(); self.mesh.vertices.len()];
        for (local, idx) in self.free.iter().enumerate() {
            intermediate[*idx] = Vec2::new(free_values[2 * local], free_values[2 * local + 1]);
        }
        for (local, idx) in self.constrained.iter().enumerate() {
            intermediate[*idx] = targets[local];
        }
        if !scale_adjust {
            return Ok(intermediate);
        }
        Ok(self.scale_adjust(&intermediate, targets))
    }

    fn scale_adjust(&self, intermediate: &[Vec2], targets: &[Vec2]) -> Vec<Vec2> {
        let n = self.mesh.vertices.len();
        let mut flat = Vec::with_capacity(n * 2);
        for p in intermediate {
            flat.push(p.x);
            flat.push(p.y);
        }
        let mut rhs_x = vec![0.0; n];
        let mut rhs_y = vec![0.0; n];
        for edge in &self.edges {
            let c = edge
                .c_coeffs
                .iter()
                .map(|coeff| coeff.value * flat[coeff.dof])
                .sum::<f64>();
            let s = edge
                .s_coeffs
                .iter()
                .map(|coeff| coeff.value * flat[coeff.dof])
                .sum::<f64>();
            let norm = (c * c + s * s).sqrt();
            let (c, s) = if norm < 1e-12 {
                (1.0, 0.0)
            } else {
                (c / norm, s / norm)
            };
            let e = self.mesh.vertices[edge.j].sub(self.mesh.vertices[edge.i]);
            let tx = c * e.x + s * e.y;
            let ty = -s * e.x + c * e.y;
            rhs_x[edge.i] -= edge.weight * tx;
            rhs_x[edge.j] += edge.weight * tx;
            rhs_y[edge.i] -= edge.weight * ty;
            rhs_y[edge.j] += edge.weight * ty;
        }
        let constrained_x = targets.iter().map(|p| p.x).collect::<Vec<_>>();
        let constrained_y = targets.iter().map(|p| p.y).collect::<Vec<_>>();
        let hcx = mat_vec(
            &self.step2_fc,
            self.free.len(),
            self.step2_fc_cols,
            &constrained_x,
        );
        let hcy = mat_vec(
            &self.step2_fc,
            self.free.len(),
            self.step2_fc_cols,
            &constrained_y,
        );
        let bx = self
            .free
            .iter()
            .enumerate()
            .map(|(row, idx)| rhs_x[*idx] - hcx[row])
            .collect::<Vec<_>>();
        let by = self
            .free
            .iter()
            .enumerate()
            .map(|(row, idx)| rhs_y[*idx] - hcy[row])
            .collect::<Vec<_>>();
        let x = self.step2_l.solve(&bx);
        let y = self.step2_l.solve(&by);
        let mut out = intermediate.to_vec();
        for (local, idx) in self.free.iter().enumerate() {
            out[*idx] = Vec2::new(x[local], y[local]);
        }
        for (local, idx) in self.constrained.iter().enumerate() {
            out[*idx] = targets[local];
        }
        out
    }
}

fn build_edges(mesh: &Mesh) -> Result<Vec<EdgeInfo>, String> {
    let mut adjacency: BTreeMap<(usize, usize), Vec<usize>> = BTreeMap::new();
    for tri in &mesh.triangles {
        for (i, j, opp) in [
            (tri[0], tri[1], tri[2]),
            (tri[1], tri[2], tri[0]),
            (tri[2], tri[0], tri[1]),
        ] {
            if i >= mesh.vertices.len() || j >= mesh.vertices.len() || opp >= mesh.vertices.len() {
                return Err("triangle index out of range".to_string());
            }
            let key = if i < j { (i, j) } else { (j, i) };
            adjacency.entry(key).or_default().push(opp);
        }
    }
    let mut edges = Vec::with_capacity(adjacency.len());
    for ((i, j), opposites) in adjacency {
        let mut context = vec![i, j];
        for opp in opposites {
            if !context.contains(&opp) {
                context.push(opp);
            }
        }
        let (c_coeffs, s_coeffs) = similarity_coefficients(&mesh.vertices, &context)?;
        edges.push(EdgeInfo {
            i,
            j,
            c_coeffs,
            s_coeffs,
            weight: 1.0,
        });
    }
    Ok(edges)
}

fn similarity_coefficients(
    vertices: &[Vec2],
    context: &[usize],
) -> Result<(Vec<Coeff>, Vec<Coeff>), String> {
    let rows = context.len() * 2;
    let mut a = vec![0.0; rows * 4];
    for (local, idx) in context.iter().enumerate() {
        let p = vertices[*idx];
        a[(2 * local) * 4] = p.x;
        a[(2 * local) * 4 + 1] = p.y;
        a[(2 * local) * 4 + 2] = 1.0;
        a[(2 * local + 1) * 4] = p.y;
        a[(2 * local + 1) * 4 + 1] = -p.x;
        a[(2 * local + 1) * 4 + 3] = 1.0;
    }
    let at = transpose(&a, rows, 4);
    let ata = mul(&at, 4, rows, &a, rows, 4);
    let inv = invert_square(&ata, 4)?;
    let pinv = mul(&inv, 4, 4, &at, 4, rows);
    let mut c_coeffs = Vec::with_capacity(context.len() * 2);
    let mut s_coeffs = Vec::with_capacity(context.len() * 2);
    for (local, idx) in context.iter().enumerate() {
        c_coeffs.push(Coeff {
            dof: 2 * idx,
            value: pinv[2 * local],
        });
        c_coeffs.push(Coeff {
            dof: 2 * idx + 1,
            value: pinv[2 * local + 1],
        });
        s_coeffs.push(Coeff {
            dof: 2 * idx,
            value: pinv[rows + 2 * local],
        });
        s_coeffs.push(Coeff {
            dof: 2 * idx + 1,
            value: pinv[rows + 2 * local + 1],
        });
    }
    Ok((c_coeffs, s_coeffs))
}

fn assemble_step1_normal(mesh: &Mesh, edges: &[EdgeInfo]) -> Vec<f64> {
    let n = mesh.vertices.len() * 2;
    let mut normal = vec![0.0; n * n];
    for edge in edges {
        let e = mesh.vertices[edge.j].sub(mesh.vertices[edge.i]);
        let mut row_x = vec![(2 * edge.i, -1.0), (2 * edge.j, 1.0)];
        let mut row_y = vec![(2 * edge.i + 1, -1.0), (2 * edge.j + 1, 1.0)];
        for coeff in &edge.c_coeffs {
            row_x.push((coeff.dof, -e.x * coeff.value));
            row_y.push((coeff.dof, -e.y * coeff.value));
        }
        for coeff in &edge.s_coeffs {
            row_x.push((coeff.dof, -e.y * coeff.value));
            row_y.push((coeff.dof, e.x * coeff.value));
        }
        add_normal_row(&mut normal, n, &row_x, edge.weight);
        add_normal_row(&mut normal, n, &row_y, edge.weight);
    }
    normal
}

fn assemble_step2_normal(n: usize, edges: &[EdgeInfo]) -> Vec<f64> {
    let mut normal = vec![0.0; n * n];
    for edge in edges {
        let i = edge.i;
        let j = edge.j;
        let w = edge.weight;
        normal[i * n + i] += w;
        normal[j * n + j] += w;
        normal[i * n + j] -= w;
        normal[j * n + i] -= w;
    }
    normal
}

fn add_normal_row(normal: &mut [f64], n: usize, row: &[(usize, f64)], weight: f64) {
    let mut collapsed: BTreeMap<usize, f64> = BTreeMap::new();
    for (idx, value) in row {
        *collapsed.entry(*idx).or_default() += *value;
    }
    let items = collapsed
        .into_iter()
        .filter(|(_, value)| value.abs() > 1e-14)
        .collect::<Vec<_>>();
    for (i, vi) in &items {
        for (j, vj) in &items {
            normal[i * n + j] += weight * vi * vj;
        }
    }
}

fn submatrix(a: &[f64], ncols: usize, rows: &[usize], cols: &[usize]) -> Vec<f64> {
    let mut out = vec![0.0; rows.len() * cols.len()];
    for (rout, rin) in rows.iter().enumerate() {
        for (cout, cin) in cols.iter().enumerate() {
            out[rout * cols.len() + cout] = a[rin * ncols + cin];
        }
    }
    out
}

fn mat_vec(a: &[f64], rows: usize, cols: usize, x: &[f64]) -> Vec<f64> {
    let mut out = vec![0.0; rows];
    for r in 0..rows {
        let mut sum = 0.0;
        for c in 0..cols {
            sum += a[r * cols + c] * x[c];
        }
        out[r] = sum;
    }
    out
}

fn transpose(a: &[f64], rows: usize, cols: usize) -> Vec<f64> {
    let mut out = vec![0.0; cols * rows];
    for r in 0..rows {
        for c in 0..cols {
            out[c * rows + r] = a[r * cols + c];
        }
    }
    out
}

fn mul(
    a: &[f64],
    a_rows: usize,
    a_cols: usize,
    b: &[f64],
    b_rows: usize,
    b_cols: usize,
) -> Vec<f64> {
    assert_eq!(a_cols, b_rows);
    let mut out = vec![0.0; a_rows * b_cols];
    for r in 0..a_rows {
        for k in 0..a_cols {
            let av = a[r * a_cols + k];
            if av == 0.0 {
                continue;
            }
            for c in 0..b_cols {
                out[r * b_cols + c] += av * b[k * b_cols + c];
            }
        }
    }
    out
}

fn invert_square(a: &[f64], n: usize) -> Result<Vec<f64>, String> {
    let mut aug = vec![0.0; n * 2 * n];
    let width = 2 * n;
    for r in 0..n {
        for c in 0..n {
            aug[r * width + c] = a[r * n + c];
        }
        aug[r * width + n + r] = 1.0;
    }
    for col in 0..n {
        let mut pivot = col;
        let mut best = aug[col * width + col].abs();
        for r in (col + 1)..n {
            let value = aug[r * width + col].abs();
            if value > best {
                best = value;
                pivot = r;
            }
        }
        if best < 1e-12 {
            return Err("singular matrix".to_string());
        }
        if pivot != col {
            for c in 0..width {
                aug.swap(col * width + c, pivot * width + c);
            }
        }
        let inv_pivot = 1.0 / aug[col * width + col];
        for c in col..width {
            aug[col * width + c] *= inv_pivot;
        }
        for r in 0..n {
            if r == col {
                continue;
            }
            let factor = aug[r * width + col];
            if factor == 0.0 {
                continue;
            }
            for c in col..width {
                aug[r * width + c] -= factor * aug[col * width + c];
            }
        }
    }
    let mut inv = vec![0.0; n * n];
    for r in 0..n {
        for c in 0..n {
            inv[r * n + c] = aug[r * width + n + c];
        }
    }
    Ok(inv)
}

pub fn grid_mesh(cols: usize, rows: usize, width: f64, height: f64) -> Mesh {
    let mut vertices = Vec::with_capacity((cols + 1) * (rows + 1));
    for y in 0..=rows {
        for x in 0..=cols {
            vertices.push(Vec2::new(
                width * x as f64 / cols as f64,
                height * y as f64 / rows as f64,
            ));
        }
    }
    let stride = cols + 1;
    let mut triangles = Vec::with_capacity(cols * rows * 2);
    for y in 0..rows {
        for x in 0..cols {
            let a = y * stride + x;
            let b = a + 1;
            let c = a + stride;
            let d = c + 1;
            triangles.push([a, b, d]);
            triangles.push([a, d, c]);
        }
    }
    Mesh {
        vertices,
        triangles,
    }
}

pub fn transform_points(points: &[Vec2], angle: f64, translation: Vec2, pivot: Vec2) -> Vec<Vec2> {
    let ca = angle.cos();
    let sa = angle.sin();
    points
        .iter()
        .map(|p| {
            let x = p.x - pivot.x;
            let y = p.y - pivot.y;
            Vec2::new(
                pivot.x + ca * x + sa * y + translation.x,
                pivot.y - sa * x + ca * y + translation.y,
            )
        })
        .collect()
}

pub fn max_distance(a: &[Vec2], b: &[Vec2]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(pa, pb)| pa.sub(*pb).length())
        .fold(0.0, f64::max)
}

pub fn edge_length_rms(mesh: &Mesh, vertices: &[Vec2]) -> f64 {
    let edges = build_edges(mesh).expect("valid mesh");
    let mut err = 0.0;
    for edge in &edges {
        let rest = mesh.vertices[edge.j].sub(mesh.vertices[edge.i]).length();
        let now = vertices[edge.j].sub(vertices[edge.i]).length();
        err += (now - rest) * (now - rest);
    }
    (err / edges.len().max(1) as f64).sqrt()
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub struct WasmArap {
    solver: CompiledArap,
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
impl WasmArap {
    #[wasm_bindgen(constructor)]
    pub fn new(
        vertices: &[f64],
        triangles: &[u32],
        constrained: &[u32],
    ) -> Result<WasmArap, JsValue> {
        if vertices.len() % 2 != 0 || triangles.len() % 3 != 0 {
            return Err(JsValue::from_str(
                "invalid vertex or triangle buffer length",
            ));
        }
        let verts = vertices
            .chunks_exact(2)
            .map(|p| Vec2::new(p[0], p[1]))
            .collect::<Vec<_>>();
        let tris = triangles
            .chunks_exact(3)
            .map(|t| [t[0] as usize, t[1] as usize, t[2] as usize])
            .collect::<Vec<_>>();
        let constrained = constrained.iter().map(|v| *v as usize).collect::<Vec<_>>();
        let solver = CompiledArap::new(
            Mesh {
                vertices: verts,
                triangles: tris,
            },
            &constrained,
        )
        .map_err(|err| JsValue::from_str(&err))?;
        Ok(WasmArap { solver })
    }

    pub fn deform(&self, targets: &[f64], scale_adjust: bool) -> Result<Vec<f64>, JsValue> {
        if targets.len() != self.solver.constrained.len() * 2 {
            return Err(JsValue::from_str(
                "target buffer length does not match constrained vertices",
            ));
        }
        let targets = targets
            .chunks_exact(2)
            .map(|p| Vec2::new(p[0], p[1]))
            .collect::<Vec<_>>();
        let points = self
            .solver
            .deform(&targets, scale_adjust)
            .map_err(|err| JsValue::from_str(&err))?;
        let mut out = Vec::with_capacity(points.len() * 2);
        for p in points {
            out.push(p.x);
            out.push(p.y);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_translation_is_exact() {
        let mesh = grid_mesh(4, 3, 1.0, 1.0);
        let constrained = [0, 4, 15, 19];
        let solver = CompiledArap::new(mesh.clone(), &constrained).unwrap();
        let targets = constrained
            .iter()
            .map(|idx| Vec2::new(mesh.vertices[*idx].x + 2.0, mesh.vertices[*idx].y - 0.75))
            .collect::<Vec<_>>();
        let result = solver.deform(&targets, true).unwrap();
        let expected = mesh
            .vertices
            .iter()
            .map(|p| Vec2::new(p.x + 2.0, p.y - 0.75))
            .collect::<Vec<_>>();
        assert!(max_distance(&result, &expected) < 1e-7);
    }

    #[test]
    fn global_rotation_is_exact() {
        let mesh = grid_mesh(5, 4, 1.0, 1.0);
        let constrained = [0, 5, 24, 29];
        let solver = CompiledArap::new(mesh.clone(), &constrained).unwrap();
        let expected = transform_points(
            &mesh.vertices,
            std::f64::consts::PI / 5.0,
            Vec2::new(0.4, 0.2),
            Vec2::new(0.5, 0.5),
        );
        let targets = constrained
            .iter()
            .map(|idx| expected[*idx])
            .collect::<Vec<_>>();
        let result = solver.deform(&targets, true).unwrap();
        assert!(max_distance(&result, &expected) < 1e-6);
    }

    #[test]
    fn scale_adjustment_preserves_edges_better_than_first_step() {
        let mesh = grid_mesh(8, 3, 2.0, 0.6);
        let left = [0, 9, 18, 27];
        let right = [8, 17, 26, 35];
        let constrained = left.into_iter().chain(right).collect::<Vec<_>>();
        let solver = CompiledArap::new(mesh.clone(), &constrained).unwrap();
        let targets = constrained
            .iter()
            .map(|idx| {
                let p = mesh.vertices[*idx];
                if *idx % 9 == 0 {
                    Vec2::new(p.x - 0.25, p.y)
                } else {
                    Vec2::new(p.x + 0.9, p.y + 0.15)
                }
            })
            .collect::<Vec<_>>();
        let first = solver.deform(&targets, false).unwrap();
        let final_result = solver.deform(&targets, true).unwrap();
        assert!(edge_length_rms(&mesh, &final_result) < edge_length_rms(&mesh, &first));
    }
}
