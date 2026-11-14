# Find a ship you can only hear

A passive sonar simulator that runs entirely in the browser. You get the
direction a contact's sound comes from and must work out its range, course and
speed.

Live site: https://lyonster89.github.io/PassiveSonarGame/

- `sim-core/` Rust, no dependencies, compiled to WebAssembly: Munk sound-speed
  profile, ray tracing (RK4), a simplified passive sonar equation, and a
  regularised particle filter for bearings-only tracking.
- `web/` the page: plain JavaScript, with the core in a Web Worker. The ray fan
  is drawn with WebGPU where available and Canvas 2D otherwise.
- `SOURCES.md` the public source for every formula and constant. All vessels
  and noise figures are invented.
- `tools/browser_check.py` loads the site in headless Chrome at laptop and
  phone sizes, plays a hunt and saves screenshots.

## Build and run

    ./build.sh                      # tests, then builds web/sim_core.wasm
    python3 -m http.server -d web   # open http://localhost:8000

## Tests

`cargo test --release` in `sim-core/` checks the ray tracer against stored
BELLHOP reference paths and against two exact results (a circular ray in a constant-gradient ocean, and the turning depth
from Snell's law), the drift of the ray invariant, repeatability for a given
seed, the filter's accuracy and honesty over 100 seeded hunts, and that every
physics constant is cited or marked invented.

## Checks

- `tools/browser_check.py web OUT_DIR` plays a hunt in headless Chrome at laptop
  and phone sizes. Add `gpu` to run with software WebGPU.
- `tools/gpu_offscreen_check.py web OUT.png` draws the WebGPU ray shader to an
  off-screen texture and reads it back.

## Known limits

- WebGPU drawing is checked off-screen only. Headless Chrome's software
  renderer drops the device when a frame is presented to a canvas, so the
  on-screen path has not been seen running in a test. When that happens the
  page falls back to Canvas 2D, which is tested.
- The clarity tests with real people from the build plan have not been run.
- Bearing noise, detection and path penalties are invented game values, not a
  model of any real sensor.
