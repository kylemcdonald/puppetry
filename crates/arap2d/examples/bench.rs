use arap2d::{grid_mesh, CompiledArap, Vec2};
use std::time::Instant;

fn main() {
    let mesh = grid_mesh(24, 12, 3.0, 1.3);
    let stride = 25;
    let mut constrained = Vec::new();
    for row in 0..=12 {
        constrained.push(row * stride);
        constrained.push(row * stride + 24);
    }
    let compile_start = Instant::now();
    let solver = CompiledArap::new(mesh.clone(), &constrained).unwrap();
    let compile_elapsed = compile_start.elapsed();
    let targets = constrained
        .iter()
        .map(|idx| {
            let p = mesh.vertices[*idx];
            if idx % stride == 0 {
                Vec2::new(p.x - 0.25, p.y + 0.05)
            } else {
                Vec2::new(p.x + 0.65, p.y + 0.2)
            }
        })
        .collect::<Vec<_>>();
    let iterations = 500;
    let update_start = Instant::now();
    let mut checksum = 0.0;
    for _ in 0..iterations {
        let result = solver.deform(&targets, true).unwrap();
        checksum += result[result.len() / 2].x;
    }
    let update_elapsed = update_start.elapsed();
    println!("vertices: {}", mesh.vertices.len());
    println!("triangles: {}", mesh.triangles.len());
    println!("constrained: {}", constrained.len());
    println!("compile: {:.3?}", compile_elapsed);
    println!("average update: {:.3?}", update_elapsed / iterations);
    println!("checksum: {:.6}", checksum);
}
