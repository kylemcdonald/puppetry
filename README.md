# As-Rigid-As-Possible Shape Manipulation

Clean-room implementation of the 2D as-rigid-as-possible shape manipulation
method by Igarashi, Moscovich, and Hughes, with a Python reference
implementation and a Rust/WASM interactive frontend.

The implementation follows the two-stage closed-form algorithm:

1. Solve a scale-free similarity deformation from constrained handles.
2. Estimate local rotations from the intermediate mesh and solve a second
   edge-preserving system to restore scale.

The original papers and demo were downloaded locally under `references/` for
study. That directory is intentionally ignored so the public repository only
contains this implementation.

## Verification

```bash
PYTHONPATH=python python3 -m unittest discover -s python -p 'test_*.py'
python3 python/visual_tests.py

source "$HOME/.cargo/env"
cargo test
cargo run -p arap2d --example bench --release

cd web
npm install
npm run build
npm run dev
```

The current release benchmark on this machine reports a 325-vertex mesh at
about 0.26 ms per deformation update after precomputation.

## Frontend

The web app supports drawing a closed shape, automatic triangulation, selecting
anchor/control vertices, and dragging controls through the Rust/WASM solver.
After a clean checkout, run `npm run build:wasm` in `web/` before `npm run dev`
if you want the dev server without a full production build.

## References

- Takeo Igarashi, Tomer Moscovich, John F. Hughes. "As-Rigid-As-Possible Shape
  Manipulation." ACM SIGGRAPH 2005.
- Takeo Igarashi and Yuki Igarashi. "Implementing As-Rigid-As-Possible Shape
  Manipulation and Surface Flattening." Journal of Graphics, GPU, and Game
  Tools, 2009.
