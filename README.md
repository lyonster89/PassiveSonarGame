# Find a ship you can only hear

A passive sonar simulator that runs entirely in the browser. You get the
direction a contact's sound comes from and must work out its range, course and
speed.

- `sim-core/` Rust, no dependencies, compiled to WebAssembly: Munk sound-speed
  profile, ray tracing (RK4), a simplified passive sonar equation, and a
  regularised particle filter for bearings-only tracking.
- `web/` the page: plain JavaScript and Canvas 2D, with the core in a Web Worker.
- `SOURCES.md` the public source for every formula and constant. All vessels
  and noise figures are invented.
- `tools/browser_check.py` loads the site in headless Chrome at laptop and
  phone sizes, plays a hunt and saves screenshots.

## Build and run

    ./build.sh                      # tests, then builds web/sim_core.wasm
    python3 -m http.server -d web   # open http://localhost:8000

## Tests

`cargo test --release` in `sim-core/` checks the ray tracer against two exact
results (a circular ray in a constant-gradient ocean, and the turning depth
from Snell's law), the drift of the ray invariant, repeatability for a given
seed, the filter's accuracy and honesty over 100 seeded hunts, and that every
physics constant is cited or marked invented.

## Not done yet

- WebGPU drawing (this version uses Canvas 2D).
- Comparison against the Bellhop reference model.
- The clarity tests with real people from the build plan.
- The CI workflow has not been run on GitHub.
