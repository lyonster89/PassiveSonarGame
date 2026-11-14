// Runs the Rust simulation core (WebAssembly) off the main thread so the
// page never freezes while physics runs.
let ex = null;
let L = null;

const f32 = (ptr, n) => new Float32Array(ex.memory.buffer, ptr, n);

function state() {
  return f32(ex.sc_out_ptr(), L.outHead + 2 * L.nDrawParticles).slice();
}

function trace(axis, depth) {
  ex.sc_set_axis(axis);
  const t0 = performance.now();
  ex.sc_trace(depth);
  const ms = performance.now() - t0;
  const rays = f32(ex.sc_rays_ptr(), L.nDrawRays * L.rayPts * 3).slice();
  const profile = f32(ex.sc_profile_ptr(), L.nProfile).slice();
  const coverage = new Uint8Array(ex.memory.buffer, ex.sc_coverage_ptr(), L.covNr * L.covNz).slice();
  postMessage({ type: 'rays', rays, profile, coverage, drift: ex.sc_snell_drift(), ms },
    [rays.buffer, profile.buffer, coverage.buffer]);
}

function bench() {
  let t0 = performance.now();
  for (let i = 0; i < 30; i++) ex.sc_trace(300);
  const traceMs = (performance.now() - t0) / 30;
  ex.sc_reset(999);
  t0 = performance.now();
  for (let i = 0; i < 240; i++) ex.sc_step(i < 60 ? 0 : 110, 12);
  const stepMs = (performance.now() - t0) / 240;
  return { traceMs, stepMs };
}

async function init() {
  const resp = await fetch('sim_core.wasm');
  const bytes = await resp.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});
  ex = instance.exports;
  const v = i => ex.sc_layout(i);
  L = { nDrawRays: v(0), rayPts: v(1), covNr: v(2), covNz: v(3), nProfile: v(4),
        outHead: v(5), nDrawParticles: v(6), nParticles: v(7), nRays: v(8) };
  const b = bench();
  postMessage({ type: 'ready', layout: L, wasmBytes: bytes.byteLength, bench: b });
}

onmessage = (e) => {
  const m = e.data;
  if (!ex) return;
  if (m.type === 'trace') trace(m.axis, m.depth);
  else if (m.type === 'reset') { ex.sc_reset(m.seed); postMessage({ type: 'state', out: state(), fresh: true }); }
  else if (m.type === 'step') {
    const t0 = performance.now();
    ex.sc_step(m.course, m.speed);
    postMessage({ type: 'state', out: state(), ms: performance.now() - t0 });
  }
};

init().catch(err => postMessage({ type: 'error', message: String(err) }));
