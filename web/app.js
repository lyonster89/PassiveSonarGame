// Page logic: sends settings and helm orders to the simulation worker and
// draws what comes back. All physics lives in the Rust core (sim-core).
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const INK = a => `rgba(14,27,42,${a})`;
  const AMBER = a => `rgba(224,138,30,${a})`;
  const TEAL = a => `rgba(31,138,138,${a})`;
  const PAPER = '#F3EFE6';
  const MONO = '11px "IBM Plex Mono", ui-monospace, Menlo, monospace';
  const DEPTH = 5000, RANGE_KM = 100, STEPS = 240, DT = 30;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const S = {
    L: null, rays: null, profile: null, coverage: null,
    axis: 1300, depth: 300, seed: 2026,
    running: false, fast: false, waiting: false, done: false, ready: false,
    course: 0, speed: 8, out: null, hist: [], track: [], center: null,
    turnedAt: -1, tracePending: false, traceQueued: false, rayReveal: reduced ? 1 : 0,
    rayLayer: null, rayLayerKey: '', touched: false,
  };

  let worker;
  try { worker = new Worker('worker.js'); }
  catch (e) { worker = { postMessage() {} }; setTimeout(() => fail('This browser cannot run the simulation worker.'), 0); }
  function fail(text) { const el = $('hint'); el.textContent = 'The simulation could not start. ' + text; el.classList.add('err'); }
  setTimeout(() => { if (!S.ready && !$('hint').classList.contains('err')) $('hint').textContent = 'Still loading the simulation. If this does not change, reload the page.'; }, 12000);
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') onReady(m);
    else if (m.type === 'rays') onRays(m);
    else if (m.type === 'state') onState(m);
    else if (m.type === 'error') fail(m.message);
  };
  worker.onerror = () => fail('Its files did not load; check the connection and reload.');


  // ------------------------------------------------- WebGPU ray-fan drawing
  // Every traced ray is drawn as GPU line segments with alpha blending, so
  // places where many rays cross (caustics) come out darker. If WebGPU is
  // missing or fails at any point, the Canvas 2D path draws the rays instead.
  const GPU = { ok: false };
  const WGSL = `
struct U { rect: vec4f, params: vec4f };
@group(0) @binding(0) var<uniform> u: U;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) bounce: f32,
  @location(1) frac: f32,
};
@vertex fn vs(@location(0) p: vec3f) -> VOut {
  var o: VOut;
  let fx = p.x / 100000.0;   // range, 0 to 100 km
  let fy = p.y / 5000.0;     // depth, 0 to 5000 m
  o.pos = vec4f(mix(u.rect.x, u.rect.z, fx), mix(u.rect.y, u.rect.w, fy), 0.0, 1.0);
  o.bounce = p.z;
  o.frac = fx;
  return o;
}
@fragment fn fs(i: VOut) -> @location(0) vec4f {
  if (i.frac > u.params.x) { discard; }
  let a = select(0.30, 0.055, i.bounce > 0.5);
  return vec4f(vec3f(0.055, 0.106, 0.165) * a, a);   // premultiplied ink
}`;
  async function initGpu() {
    try {
      if (!navigator.gpu) return;
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) return;
      const device = await adapter.requestDevice();
      const canvas = $('cRayGpu');
      const ctx = canvas.getContext('webgpu');
      if (!ctx) return;
      const format = navigator.gpu.getPreferredCanvasFormat();
      ctx.configure({ device, format, alphaMode: 'premultiplied' });
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code: WGSL });
      const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
      const pipeline = device.createRenderPipeline({
        layout: 'auto',
        vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
        fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: blend, alpha: blend } }] },
        primitive: { topology: 'line-list' },
        multisample: { count: 4 },
      });
      const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
      const err = await device.popErrorScope();
      if (err) return;
      Object.assign(GPU, { ok: true, device, ctx, format, pipeline, ubuf, bind, vbuf: null, vbufBytes: 0, count: 0, msaa: null, msaaKey: '' });
      device.lost.then(info => gpuOff(info));
      device.onuncapturederror = ev => gpuOff(ev.error);
    } catch (e) { GPU.ok = false; console.warn('WebGPU not available:', e.message || e); }
  }
  function gpuOff(why) {
    if (!GPU.ok) return;
    console.warn('WebGPU drawing turned off, using Canvas 2D:', why && (why.message || why.reason || why));
    GPU.ok = false; $('cRayGpu').style.display = 'none'; S.rayLayerKey = '';
    S.rayReveal = 1;   // do not rely on animation frames after a GPU failure
    drawRay(); drawNote();
  }
  function gpuUpload() {
    const { nDrawRays, rayPts } = S.L, r = S.rays;
    const v = new Float32Array(nDrawRays * (rayPts - 1) * 6);
    let n = 0;
    for (let i = 0; i < nDrawRays; i++) {
      for (let k = 0; k < rayPts - 1; k++) {
        const a = (i * rayPts + k) * 3, b = a + 3;
        if (r[b] !== r[b]) break;            // NaN marks the end of a ray
        const bounce = r[b + 2] > 0 ? 1 : 0;
        v[n++] = r[a]; v[n++] = r[a + 1]; v[n++] = bounce;
        v[n++] = r[b]; v[n++] = r[b + 1]; v[n++] = bounce;
      }
    }
    if (!GPU.vbuf || GPU.vbufBytes < v.byteLength) {
      if (GPU.vbuf) GPU.vbuf.destroy();
      GPU.vbuf = GPU.device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
      GPU.vbufBytes = v.byteLength;
    }
    GPU.device.queue.writeBuffer(GPU.vbuf, 0, v, 0, n);
    GPU.count = n / 3;
  }
  function gpuRender(G, w, h, d) {
    if (!GPU.vbuf || !GPU.count) return;
    try {
      const c = $('cRayGpu'), W = Math.max(1, Math.round(w * d)), H = Math.max(1, Math.round(h * d));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const key = W + 'x' + H;
      if (GPU.msaaKey !== key) {
        if (GPU.msaa) GPU.msaa.destroy();
        GPU.msaa = GPU.device.createTexture({ size: [W, H], sampleCount: 4, format: GPU.format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        GPU.msaaKey = key;
      }
      // plot rectangle in clip space (y up), then the reveal fraction
      const u = new Float32Array([G.x0 / w * 2 - 1, 1 - G.y0 / h * 2, G.x1 / w * 2 - 1, 1 - G.y1 / h * 2, S.rayReveal, 0, 0, 0]);
      GPU.device.queue.writeBuffer(GPU.ubuf, 0, u);
      const enc = GPU.device.createCommandEncoder();
      const pass = enc.beginRenderPass({ colorAttachments: [{
        view: GPU.msaa.createView(), resolveTarget: GPU.ctx.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }] });
      pass.setPipeline(GPU.pipeline);
      pass.setBindGroup(0, GPU.bind);
      pass.setVertexBuffer(0, GPU.vbuf);
      pass.draw(GPU.count);
      pass.end();
      GPU.device.queue.submit([enc.finish()]);
    } catch (e) { gpuOff(e); }
  }
  function drawNote() {
    if (!S.L) return;
    $('bDraw').textContent = GPU.ok ? `WebGPU, ${S.L.nDrawRays} rays` : `Canvas 2D, ${Math.ceil(S.L.nDrawRays / 3)} rays`;
  }

  // ------------------------------------------------------------ canvas help
  function fit(c) {
    const r = c.getBoundingClientRect();
    const d = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    return [g, r.width, r.height, d];
  }
  const wrap180 = a => ((a + 540) % 360) - 180;
  const pad3 = v => String(Math.round(v) % 360).padStart(3, '0') + '°';

  // --------------------------------------------------------------- ray view
  function rayGeom(w, h) {
    const pw = Math.max(64, Math.min(120, w * 0.2));
    return { pw, x0: pw + 40, x1: w - 12, y0: 30, y1: h - 10 };
  }
  // Canvas 2D fallback: every third ray as two paths (direct, and after a
  // sea-floor bounce). The paths are plain geometry kept in memory, so they
  // survive anything that happens to the graphics process.
  function rayPaths(w, h) {
    const key = `${w}x${h}`;
    if (S.rayLayerKey === key && S.rayLayer) return S.rayLayer;
    const G = rayGeom(w, h);
    const X = r => G.x0 + (r / (RANGE_KM * 1000)) * (G.x1 - G.x0);
    const Y = z => G.y0 + (z / DEPTH) * (G.y1 - G.y0);
    const { nDrawRays, rayPts } = S.L;
    const direct = new Path2D(), bounced = new Path2D();
    for (let i = 0; i < nDrawRays; i += 3) {
      let prevB = -1, pen = false;
      for (let k = 0; k < rayPts; k++) {
        const o = (i * rayPts + k) * 3;
        const r = S.rays[o];
        if (r !== r) break;
        const z = S.rays[o + 1], b = S.rays[o + 2] > 0 ? 1 : 0;
        const path = b ? bounced : direct;
        if (!pen || b !== prevB) {
          if (pen && b !== prevB) (prevB ? bounced : direct).lineTo(X(r), Y(z));
          path.moveTo(X(r), Y(z)); pen = true;
        } else path.lineTo(X(r), Y(z));
        prevB = b;
      }
    }
    S.rayLayerKey = key;
    S.rayLayer = { direct, bounced };
    return S.rayLayer;
  }
  function drawRay() {
    const c = $('cRay');
    const [g, w, h, d] = fit(c);
    g.clearRect(0, 0, w, h);
    if (!S.rays) return;
    const G = rayGeom(w, h);
    const X = km => G.x0 + (km / RANGE_KM) * (G.x1 - G.x0);
    const Y = z => G.y0 + (z / DEPTH) * (G.y1 - G.y0);
    g.font = MONO; g.textBaseline = 'middle';

    // sound speed profile, left
    let lo = Infinity, hi = -Infinity;
    for (const v of S.profile) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const PX = v => 10 + ((v - lo) / (hi - lo)) * (G.pw - 22);
    g.strokeStyle = INK(0.25); g.lineWidth = 1;
    g.strokeRect(6.5, G.y0 + 0.5, G.pw - 10, G.y1 - G.y0);
    g.beginPath();
    S.profile.forEach((v, i) => { const y = Y(DEPTH * i / (S.profile.length - 1)); i ? g.lineTo(PX(v), y) : g.moveTo(PX(v), y); });
    g.strokeStyle = INK(0.9); g.lineWidth = 1.4; g.stroke();
    g.fillStyle = INK(0.75); g.textAlign = 'left';
    g.fillText(w < 460 ? 'speed' : 'sound speed', 8, 12);
    if (w >= 460) { g.fillText('slow', 10, G.y0 - 8); g.textAlign = 'right'; g.fillText('fast', G.pw - 6, G.y0 - 8); }
    // axis handle
    const ay = Y(S.axis);
    g.beginPath(); g.arc(PX(lo), ay, 5, 0, 7); g.fillStyle = PAPER; g.fill(); g.strokeStyle = INK(1); g.lineWidth = 1.5; g.stroke();
    g.setLineDash([3, 3]); g.strokeStyle = INK(0.35); g.lineWidth = 1;
    g.beginPath(); g.moveTo(PX(lo) + 6, ay); g.lineTo(G.x1, ay); g.stroke(); g.setLineDash([]);
    g.textAlign = 'left'; g.fillStyle = INK(0.75);
    g.fillText('slowest', PX(lo) + 10, ay + (ay > G.y1 - 20 ? -10 : 10));

    // frame and scales
    g.strokeStyle = INK(0.9); g.lineWidth = 1;
    g.strokeRect(G.x0 + 0.5, G.y0 + 0.5, G.x1 - G.x0, G.y1 - G.y0);
    g.fillStyle = INK(0.75);
    g.textAlign = 'center';
    const narrow = w < 460;
    for (let km = 0; km <= 100; km += narrow ? 50 : 20) {
      g.fillText(km === 0 ? '0' : km + ' km', Math.min(X(km), G.x1 - 20), 12);
      g.beginPath(); g.moveTo(X(km) + 0.5, G.y0 - 4); g.lineTo(X(km) + 0.5, G.y0); g.stroke();
    }
    g.textAlign = 'right';
    for (let z = 1000; z <= 5000; z += 1000) g.fillText(z / 1000 + ' km', G.x0 - 5, Math.min(Y(z), G.y1 - 6));
    g.fillText('surface', G.x0 - 5, G.y0 + 2);

    // rays (cached layer), drawn outward once on load
    if (GPU.ok) gpuRender(G, w, h, d);
    else {
      const paths = rayPaths(w, h);
      g.save();
      g.beginPath(); g.rect(G.x0, G.y0, (G.x1 - G.x0) * S.rayReveal, G.y1 - G.y0); g.clip();
      g.lineWidth = 0.8;
      g.strokeStyle = INK(0.10); g.stroke(paths.bounced);
      g.strokeStyle = INK(0.42); g.stroke(paths.direct);
      g.restore();
    }

    // which paths reach a ship at the surface
    const { covNr } = S.L;
    for (let i = 0; i < covNr; i++) {
      const v = S.coverage[i];
      if (!v) continue;
      g.fillStyle = v === 2 ? INK(0.95) : INK(0.28);
      g.fillRect(X(i * RANGE_KM / covNr), G.y0 - 9, (G.x1 - G.x0) / covNr + 0.5, 4);
    }

    // listener
    const ly = Y(S.depth);
    g.fillStyle = INK(1);
    g.beginPath(); g.moveTo(G.x0 - 1, ly - 6); g.lineTo(G.x0 + 9, ly); g.lineTo(G.x0 - 1, ly + 6); g.closePath(); g.fill();
    g.textAlign = 'left'; g.fillStyle = INK(0.9);
    g.fillText('listener', G.x0 + 13, ly + (ly < G.y0 + 16 ? 12 : -10));

    const hv = S.hover;
    if (hv && hv.view === 'ray' && hv.x >= G.x0 && hv.x <= G.x1 && hv.y >= G.y0 && hv.y <= G.y1) {
      g.strokeStyle = INK(0.55); g.lineWidth = 1; g.beginPath();
      g.moveTo(G.x0, Math.round(hv.y) + 0.5); g.lineTo(G.x1, Math.round(hv.y) + 0.5);
      g.moveTo(Math.round(hv.x) + 0.5, G.y0); g.lineTo(Math.round(hv.x) + 0.5, G.y1); g.stroke();
    }
    // the contact is only shown once the hunt is over
    if (S.done && S.out) {
      const km = S.out[24];
      const cx = X(Math.min(km, RANGE_KM));
      g.fillStyle = AMBER(1);
      g.beginPath(); g.arc(cx, G.y0 + 3, 5, 0, 7); g.fill();
      g.fillStyle = INK(0.9); g.textAlign = km > 80 ? 'right' : 'left';
      g.fillText(km > RANGE_KM ? `contact, ${km.toFixed(0)} km (off chart)` : `contact, ${km.toFixed(0)} km`, cx + (km > 80 ? -9 : 9), G.y0 + 16);
    }
  }
  function requestTrace() {
    if (!S.ready) return;
    if (S.tracePending) { S.traceQueued = true; return; }
    S.tracePending = true;
    worker.postMessage({ type: 'trace', axis: S.axis, depth: S.depth });
  }
  function onRays(m) {
    S.rays = m.rays; S.profile = m.profile; S.coverage = m.coverage;
    S.rayLayerKey = '';
    if (GPU.ok) { try { gpuUpload(); } catch (e) { gpuOff(e); } }
    S.tracePending = false;
    if (S.traceQueued) { S.traceQueued = false; requestTrace(); }
    if (S.rayReveal < 1 && !S.revealing) {
      S.revealing = true;
      const t0 = performance.now();
      const tick = t => { S.rayReveal = Math.min(1, (t - t0) / 900); drawRay(); if (S.rayReveal < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      // if animation frames stall for any reason, show the rays anyway
      setTimeout(() => { if (S.rayReveal < 1) { S.rayReveal = 1; drawRay(); } }, 1500);
    } else drawRay();
    clearZoneText();
  }
  function clearZoneText() {
    // Read the surface row of the coverage grid: where does direct sound return?
    const { covNr } = S.L, cov = S.coverage, kmPer = RANGE_KM / covNr;
    let i = 0;
    while (i < covNr && cov[i] === 2) i++;
    const nearEnd = i * kmPer;
    let j = i;
    while (j < covNr && cov[j] !== 2) j++;
    let k = j;
    while (k < covNr && cov[k] === 2) k++;
    const el = $('czLive');
    const head = `<b>Live from the simulation.</b> Listener at ${S.depth} m, slowest sound at ${S.axis} m. `;
    if (j >= covNr) el.innerHTML = head + `Direct sound reaches a surface ship out to ${nearEnd.toFixed(0)} km and does not return within ${RANGE_KM} km.`;
    else el.innerHTML = head + `Direct sound reaches a surface ship out to ${nearEnd.toFixed(1)} km, then returns between ${(j * kmPer).toFixed(0)} and ${(k * kmPer).toFixed(0)} km. In between, only sea-floor bounces arrive.`;
  }

  // -------------------------------------------------------------- waterfall
  const wfGeom = (w, h) => ({ x0: 58, x1: w - 10, y0: 26, y1: h - 8, rh: (h - 8 - 26) / STEPS });
  function hash(n) { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
  function drawWf() {
    const [g, w, h] = fit($('cWf'));
    g.clearRect(0, 0, w, h);
    const { x0, x1, y0, y1, rh } = wfGeom(w, h);
    const center = S.center == null ? 0 : S.center;
    const X = b => x0 + ((wrap180(b - center) + 180) / 360) * (x1 - x0);
    g.font = MONO; g.textBaseline = 'middle';
    g.strokeStyle = INK(0.9); g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    g.fillStyle = INK(0.75); g.textAlign = 'center';
    for (let k = -2; k <= 2; k++) {
      const b = (center + k * 90 + 360) % 360, x = x0 + ((k * 90 + 180) / 360) * (x1 - x0);
      if (Math.abs(k) < 2) { g.fillText(pad3(b), x, 12); g.strokeStyle = INK(0.12); g.beginPath(); g.moveTo(x + 0.5, y0); g.lineTo(x + 0.5, y1); g.stroke(); }
    }
    g.textAlign = 'right';
    g.fillText('now', x0 - 5, y0 + 5);
    for (let min = 30; min <= 120; min += 30) g.fillText('−' + min + ' min', x0 - 5, Math.min(y0 + (min * 60 / DT) * rh, y1 - 5));
    const n = S.hist.length;
    for (let k = 0; k < n; k++) {
      const m = S.hist[n - 1 - k], y = y0 + k * rh;
      // background noise speckle, repeatable for a given row
      g.fillStyle = INK(0.10);
      for (let s = 0; s < 14; s++) g.fillRect(x0 + hash(m.i * 31 + s) * (x1 - x0 - 2), y, 2, Math.max(1, rh));
      if (!m.det) continue;
      const px = (x1 - x0) / 360, x = X(m.b), sw = Math.max(1.5, m.sig * px);
      g.fillStyle = AMBER(0.22); g.fillRect(x - 2 * sw, y, 4 * sw, Math.max(1, rh));
      g.fillStyle = AMBER(0.45); g.fillRect(x - sw, y, 2 * sw, Math.max(1, rh));
      g.fillStyle = AMBER(1); g.fillRect(x - 1, y, 2, Math.max(1, rh));
    }
    if (!n) { g.fillStyle = INK(0.6); g.textAlign = 'center'; g.fillText('Bearings appear here once the hunt starts', (x0 + x1) / 2, (y0 + y1) / 2); }
    const hv = S.hover;
    if (hv && hv.view === 'wf' && wfAt(hv)) {
      g.strokeStyle = INK(0.55); g.lineWidth = 1; g.beginPath();
      g.moveTo(x0, Math.round(hv.y) + 0.5); g.lineTo(x1, Math.round(hv.y) + 0.5);
      g.moveTo(Math.round(hv.x) + 0.5, y0); g.lineTo(Math.round(hv.x) + 0.5, y1); g.stroke();
    }
  }

  // ------------------------------------------------------------------ chart
  const guess = () => ({ range: +$('gRange').value, course: +$('gCourse').value, speed: +$('gSpeed').value });
  function drawPlot() {
    const [g, w, h] = fit($('cPlot'));
    g.clearRect(0, 0, w, h);
    g.font = MONO; g.textBaseline = 'middle';
    const o = S.out;
    const ox = o ? o[1] : 0, oy = o ? o[2] : 0;
    const started = o && o[26] > 0;
    // scale: keep own ship, the estimate and your answer in view
    let reach = 30;
    if (started) reach = Math.max(reach, Math.hypot(o[10] - ox, o[11] - oy) + 2.2 * Math.sqrt(Math.max(o[12], o[14])));
    if (S.done && o) reach = Math.max(reach, o[24]);
    reach = Math.min(Math.max(reach, guess().range) * 1.12, 170);
    // ease the zoom only when the hunt or your answer changed, not on every
    // redraw, so pointing at the chart never makes it drift
    if (!S.reach) S.reach = reach;
    else if (S.ease) S.reach += (reach - S.reach) * 0.25;
    S.ease = false;
    const sc = Math.min(w, h) / 2 / S.reach, cx = w / 2, cy = h / 2;
    const X = x => cx + (x - ox) * sc, Y = y => cy - (y - oy) * sc;
    S.plotT = { cx, cy, sc };
    // range rings
    const ringStep = S.reach > 90 ? 40 : S.reach > 45 ? 20 : 10;
    g.strokeStyle = INK(0.14); g.fillStyle = INK(0.6); g.textAlign = 'left'; g.lineWidth = 1;
    for (let r = ringStep; r < S.reach * 1.5; r += ringStep) {
      g.beginPath(); g.arc(cx, cy, r * sc, 0, 7); g.stroke();
      if (r * sc < h / 2 - 8) g.fillText(r + ' km', cx + 5, cy + r * sc - 8);
    }
    g.textAlign = 'center'; g.fillStyle = INK(0.9); g.fillText('N ↑', w - 22, 14);
    // bearing lines, every 8th
    const n = S.hist.length;
    g.strokeStyle = AMBER(0.30); g.lineWidth = 1;
    for (let k = 0; k < n; k += 8) {
      const m = S.hist[k]; if (!m.det) continue;
      const a = m.b * Math.PI / 180, len = 400;
      g.beginPath(); g.moveTo(X(m.x), Y(m.y)); g.lineTo(X(m.x + len * Math.sin(a)), Y(m.y + len * Math.cos(a))); g.stroke();
    }
    // own track
    if (S.track.length) {
      g.strokeStyle = INK(1); g.lineWidth = 1.6; g.beginPath();
      S.track.forEach((p, i) => i ? g.lineTo(X(p[0]), Y(p[1])) : g.moveTo(X(p[0]), Y(p[1])));
      g.stroke();
    }
    // the filter's guesses
    if (started) {
      const { outHead, nDrawParticles } = S.L;
      g.fillStyle = TEAL(0.35);
      for (let k = 0; k < nDrawParticles; k++) g.fillRect(X(o[outHead + 2 * k]) - 1, Y(o[outHead + 2 * k + 1]) - 1, 2, 2);
      // two-sigma ellipse from the covariance
      const a = o[12], b = o[13], c = o[14], tr = a + c, det = a * c - b * b;
      const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det)), l2 = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det));
      const ang = Math.atan2(l1 - a, b || 1e-9);
      g.save(); g.translate(X(o[10]), Y(o[11])); g.rotate(-ang);
      g.beginPath(); g.ellipse(0, 0, 2 * Math.sqrt(Math.max(l1, 0)) * sc, 2 * Math.sqrt(Math.max(l2, 0)) * sc, 0, 0, 7);
      g.strokeStyle = TEAL(1); g.lineWidth = 1.4; g.stroke(); g.restore();
      g.strokeStyle = TEAL(1); g.lineWidth = 2; g.beginPath();
      g.moveTo(X(o[10]) - 5, Y(o[11])); g.lineTo(X(o[10]) + 5, Y(o[11])); g.moveTo(X(o[10]), Y(o[11]) - 5); g.lineTo(X(o[10]), Y(o[11]) + 5); g.stroke();
    }
    // your answer: along the latest bearing at your range, with a course arrow
    const last = lastDetected();
    if (last) {
      const q = guess(), a = last.b * Math.PI / 180;
      const gx = ox + q.range * Math.sin(a), gy = oy + q.range * Math.cos(a);
      const ca = q.course * Math.PI / 180, len = 14 + q.speed * 1.6;
      g.strokeStyle = INK(1); g.fillStyle = PAPER; g.lineWidth = 1.6;
      g.beginPath(); g.arc(X(gx), Y(gy), 6, 0, 7); g.fill(); g.stroke();
      g.setLineDash([4, 3]); g.beginPath(); g.moveTo(X(gx), Y(gy)); g.lineTo(X(gx) + len * Math.sin(ca), Y(gy) - len * Math.cos(ca)); g.stroke(); g.setLineDash([]);
    }
    // truth, only after the hunt
    if (S.done && o) {
      const ca = o[22] * Math.PI / 180, len = 14 + o[23] * 1.6;
      g.fillStyle = AMBER(1); g.strokeStyle = AMBER(1); g.lineWidth = 2;
      g.beginPath(); g.arc(X(o[20]), Y(o[21]), 6, 0, 7); g.fill();
      g.beginPath(); g.moveTo(X(o[20]), Y(o[21])); g.lineTo(X(o[20]) + len * Math.sin(ca), Y(o[21]) - len * Math.cos(ca)); g.stroke();
      g.fillStyle = INK(0.9); g.textAlign = 'left'; g.fillText('the contact', X(o[20]) + 10, Y(o[21]) + 12);
    }
    // the moment pointed at in the waterfall: where you were, and that bearing
    const hv = S.hover;
    if (hv && hv.view === 'wf') {
      const at = wfAt(hv);
      if (at && at.m) {
        const m = at.m, a = m.b * Math.PI / 180;
        if (m.det) { g.strokeStyle = AMBER(1); g.lineWidth = 2.2; g.beginPath(); g.moveTo(X(m.x), Y(m.y)); g.lineTo(X(m.x + 400 * Math.sin(a)), Y(m.y + 400 * Math.cos(a))); g.stroke(); }
        g.fillStyle = PAPER; g.strokeStyle = INK(1); g.lineWidth = 1.6; g.beginPath(); g.arc(X(m.x), Y(m.y), 4.5, 0, 7); g.fill(); g.stroke();
      }
    }
    // pointer on the chart: a line from your ship to the pointer
    if (hv && hv.view === 'plot') {
      g.strokeStyle = INK(0.55); g.lineWidth = 1; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(cx, cy); g.lineTo(hv.x, hv.y); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.arc(hv.x, hv.y, 3, 0, 7); g.fillStyle = INK(0.8); g.fill();
    }
    // own ship
    const hd = (o ? o[3] : 0) * Math.PI / 180;
    g.save(); g.translate(cx, cy); g.rotate(hd); g.fillStyle = INK(1);
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.restore();
  }
  function lastDetected() { for (let k = S.hist.length - 1; k >= 0; k--) if (S.hist[k].det) return S.hist[k]; return null; }


  // ----------------------------------------- live readout under the pointer
  // Each view reports the position under the pointer in its own units. The
  // waterfall also links across: the moment pointed at is marked on the
  // chart, and its signal quality replaces the ocean view's label.
  const sigOf = m => !m.det ? 'lost in a shadow zone'
    : m.zone >= 2 ? `strong, clear path (±${m.sig.toFixed(1)}°)`
    : m.zone >= 1 ? `weak, sea-floor bounce (±${m.sig.toFixed(1)}°)`
    : `very weak, no clear path (±${m.sig.toFixed(1)}°)`;
  const ago = k => k ? '−' + (k * DT / 60).toFixed(1) + ' min' : 'now';
  function wfAt(hv) {
    const { x0, x1, y0, y1, rh } = wfGeom(hv.w, hv.h);
    if (hv.x < x0 || hv.x > x1 || hv.y < y0 || hv.y > y1) return null;
    const k = Math.min(STEPS - 1, Math.floor((hv.y - y0) / rh));
    const center = S.center == null ? 0 : S.center;
    const brg = ((center + ((hv.x - x0) / (x1 - x0)) * 360 - 180) % 360 + 360) % 360;
    const row = S.hist.length - 1 - k;
    return { k, brg, m: row >= 0 ? S.hist[row] : null };
  }
  function rayAt(hv) {
    if (!S.profile) return null;
    const G = rayGeom(hv.w, hv.h);
    if (hv.y < G.y0 || hv.y > G.y1) return null;
    const depth = (hv.y - G.y0) / (G.y1 - G.y0) * DEPTH;
    const u = depth / DEPTH * (S.profile.length - 1), i = Math.min(S.profile.length - 2, Math.floor(u));
    const speed = S.profile[i] + (u - i) * (S.profile[i + 1] - S.profile[i]);
    if (hv.x <= G.pw) return { depth, speed };
    if (hv.x < G.x0 || hv.x > G.x1) return null;
    const km = (hv.x - G.x0) / (G.x1 - G.x0) * RANGE_KM;
    const { covNr, covNz } = S.L;
    const ir = Math.min(covNr - 1, Math.floor(km / RANGE_KM * covNr)), iz = Math.min(covNz - 1, Math.floor(depth / DEPTH * covNz));
    return { depth, speed, km, zone: S.coverage[iz * covNr + ir] };
  }
  function plotAt(hv) {
    const T = S.plotT; if (!T) return null;
    const dx = (hv.x - T.cx) / T.sc, dy = (T.cy - hv.y) / T.sc;
    return { km: Math.hypot(dx, dy), brg: (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360 };
  }
  const metres = v => (Math.round(v / 10) * 10).toLocaleString('en-US') + ' m';
  function readouts() {
    const hv = S.hover;
    let sig = S.sigText || 'signal: none yet', wf = '', plot = '';
    if (hv && hv.view === 'wf') {
      const at = wfAt(hv);
      if (at) {
        wf = `${ago(at.k)} · bearing ${pad3(at.brg)}`;
        if (at.m) sig = `at ${ago(at.k)}: ` + (at.m.det ? `heard at ${pad3(at.m.b)}, ` : '') + sigOf(at.m);
      }
    } else if (hv && hv.view === 'ray') {
      const at = rayAt(hv);
      if (at && at.km == null) sig = `depth ${metres(at.depth)} · sound speed ${at.speed.toFixed(0)} m/s`;
      else if (at) sig = `${at.km.toFixed(1)} km · ${metres(at.depth)} · ${at.speed.toFixed(0)} m/s · ${at.zone >= 2 ? 'direct sound' : at.zone >= 1 ? 'sea-floor bounce only' : 'shadow'}`;
    } else if (hv && hv.view === 'plot') {
      const at = plotAt(hv);
      if (at) plot = `bearing ${pad3(at.brg)} · ${at.km.toFixed(1)} km`;
    }
    $('sig').textContent = sig; $('wfOut').textContent = wf; $('plotOut').textContent = plot;
  }
  (() => {
    let queued = false, lastView = null, touchTimer = null;
    const refresh = () => {
      if (queued) return; queued = true;
      requestAnimationFrame(() => {
        queued = false; readouts();
        const v = S.hover ? S.hover.view : null;
        if (v === 'ray' || lastView === 'ray') drawRay();
        drawWf(); drawPlot(); lastView = v;
      });
    };
    const bind = (id, view) => {
      const c = $(id);
      const set = e => { const r = c.getBoundingClientRect(); S.hover = { view, x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height }; refresh(); };
      c.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') set(e); });
      c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && S.hover) { S.hover = null; refresh(); } });
      // touch: a tap shows the readout for a few seconds
      c.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return;
        set(e); clearTimeout(touchTimer);
        touchTimer = setTimeout(() => { S.hover = null; refresh(); }, 4000);
      });
    };
    bind('cRay', 'ray'); bind('cWf', 'wf'); bind('cPlot', 'plot');
  })();

  // ------------------------------------------------------------------- hunt
  function onReady(m) {
    S.L = m.layout; S.ready = true;
    $('bTrace').textContent = m.bench.traceMs.toFixed(1) + ' ms';
    $('bStep').textContent = m.bench.stepMs.toFixed(2) + ' ms';
    $('bSize').textContent = (m.wasmBytes / 1024).toFixed(0) + ' kB';
    $('go').disabled = false; $('fresh').disabled = false;
    drawNote();
    requestTrace();
    newHunt(S.seed);
  }
  function newHunt(seed) {
    S.seed = seed; S.running = false; S.done = false; S.waiting = false;
    S.hist = []; S.track = []; S.center = null; S.turnedAt = -1; S.reach = 0;
    S.course = 0; $('courseOut').textContent = '000°';
    $('result').hidden = true; $('result').innerHTML = ''; tourStep = -1; $('hint').dataset.k = '';
    $('go').textContent = 'Start'; $('go').disabled = false; $('commit').disabled = true;
    S.sigText = 'signal: none yet'; S.hover = null; readouts();
    $('pfLive').textContent = 'Start a hunt to see the filter\'s numbers here.';
    S.awaitFresh = true;
    worker.postMessage({ type: 'reset', seed });
    hint();
  }
  function onState(m) {
    S.waiting = false;
    const o = m.out; S.out = o;
    if (m.fresh) { S.awaitFresh = false; S.hist = []; S.center = null; S.track = [[o[1], o[2]]]; drawAll(); return; }
    if (S.awaitFresh) return;   // a step from the previous hunt that was still in flight
    const det = o[5] > 0;
    if (det && S.center == null) S.center = o[6];
    S.hist.push({ i: o[19], b: o[6], sig: o[7], det, se: o[8], zone: o[9], x: o[1], y: o[2] });
    S.track.push([o[1], o[2]]);
    S.sigText = 'signal: ' + sigOf(S.hist[S.hist.length - 1]);
    readouts();
    if (o[26] > 0) {
      const sd = Math.sqrt(Math.max(o[12], o[14]));
      $('pfLive').innerHTML = `<b>Live from the hunt.</b> Estimated range ${o[15].toFixed(1)} km, give or take about ${sd.toFixed(1)} km. Course ${pad3(o[16])}, speed ${o[17].toFixed(1)} kn. Guesses still carrying weight: ${(100 * o[18]).toFixed(0)}%.`;
      $('commit').disabled = S.done;
    }
    if (o[19] >= STEPS && !S.done) finish(false);
    S.ease = true;
    drawWf(); drawPlot(); hint();
  }
  function tick() {
    if (!S.running || S.waiting || S.done) return;
    S.waiting = true;
    worker.postMessage({ type: 'step', course: S.course, speed: S.speed });
  }
  let timer = null;
  function setTimer() { clearInterval(timer); timer = setInterval(tick, S.fast ? 80 : 250); }
  // Guided tour: five steps, each tied to what the visitor has just done.
  // The step sets the hint text, outlines the control or view it is about,
  // and on a phone swipes to the view it is about.
  const TOUR = [
    { spot: 'go', view: 0, text: 'Press Start. A ship is out there, and all you will get is the direction of its sound.' },
    { spot: 'vWf', view: 1, text: 'The amber trace is the direction of the sound over time. One line of bearings fits many ranges, so the teal cloud on the chart is long.' },
    { spot: 'turnBtns', view: 2, text: 'Now turn your ship with the course buttons. Moving across the line of sight is what reveals range.' },
    { spot: 'vPlot', view: 2, text: 'Watch the teal cloud shrink as bearings from your new course rule out wrong ranges.' },
    { spot: 'answer', view: 2, text: 'Set your answer with the three sliders, then commit. Turn again first if the cloud is still long.' },
  ];
  let tourStep = -1;
  function tourAt() {
    const n = S.hist.length;
    if (!S.running && n === 0) return 0;
    if (n < 24) return 1;
    if (S.turnedAt < 0) return 2;
    if (n - S.turnedAt < 40) return 3;
    return 4;
  }
  function spotlight(id) {
    document.querySelectorAll('.spot').forEach(e => e.classList.remove('spot'));
    if (id) $(id).classList.add('spot');
  }
  function hint() {
    const el = $('hint');
    if (!S.ready) return;
    if (S.done) { tourStep = -1; spotlight('fresh'); el.textContent = 'Hunt over. The amber dot is where the contact really was. Press New contact to try again.'; return; }
    if (!S.running && S.hist.length > 0) { el.textContent = 'Paused.'; el.dataset.k = ''; return; }
    const k = tourAt();
    if (k === tourStep && el.dataset.k === String(k)) return;
    const moved = k !== tourStep;
    tourStep = k; el.dataset.k = String(k);
    el.innerHTML = `<span class="n">${k + 1} of ${TOUR.length}</span>`;
    el.appendChild(document.createTextNode(TOUR[k].text));
    spotlight(TOUR[k].spot);
    // on a phone, bring the view this step is about into sight
    const views = $('views');
    if (moved && k > 0 && views.scrollWidth > views.clientWidth + 4)
      views.scrollTo({ left: views.clientWidth * TOUR[k].view, behavior: reduced ? 'auto' : 'smooth' });
  }
  function finish(byPlayer) {
    S.done = true; S.running = false;
    $('go').textContent = 'Start'; $('go').disabled = true; $('commit').disabled = true;
    const o = S.out, q = guess();
    const dAng = (a, b) => Math.abs(wrap180(a - b));
    const started = o[26] > 0;
    const row = (name, r, c, s) => `<tr><td>${name}</td><td>${r}</td><td>${c}</td><td>${s}</td></tr>`;
    const yourErr = Math.abs(q.range - o[24]) / o[24], compErr = started ? Math.abs(o[15] - o[24]) / o[24] : NaN;
    let verdict;
    if (!byPlayer) verdict = 'Time ran out before you committed.';
    else if (yourErr < 0.1) verdict = `Your range was within ${(100 * yourErr).toFixed(0)}% of the truth. That is a solid solution.`;
    else if (yourErr < 0.3) verdict = `Your range was off by ${(100 * yourErr).toFixed(0)}%. Close; another turn would have tightened it.`;
    else verdict = `Your range was off by ${(100 * yourErr).toFixed(0)}%. Bearings alone hide range until you turn across the line of sight.`;
    $('result').innerHTML = `<p>${verdict}</p><table class="res"><tr><th></th><th>Range</th><th>Course</th><th>Speed</th></tr>`
      + row('The contact', o[24].toFixed(1) + ' km', pad3(o[22]), o[23].toFixed(1) + ' kn')
      + (byPlayer ? row('You', q.range.toFixed(0) + ' km', pad3(q.course), q.speed.toFixed(0) + ' kn') : '')
      + (started ? row('The computer', o[15].toFixed(1) + ' km', pad3(o[16]), o[17].toFixed(1) + ' kn') : '')
      + (byPlayer ? row('Your error', (100 * yourErr).toFixed(0) + '%', dAng(q.course, o[22]).toFixed(0) + '°', Math.abs(q.speed - o[23]).toFixed(1) + ' kn') : '')
      + (started ? row("Computer's error", (100 * compErr).toFixed(0) + '%', dAng(o[16], o[22]).toFixed(0) + '°', Math.abs(o[17] - o[23]).toFixed(1) + ' kn') : '')
      + '</table>';
    $('result').hidden = false;
    drawAll(); hint();
  }
  function drawAll() { drawRay(); drawWf(); drawPlot(); }

  // --------------------------------------------------------------- controls
  $('go').onclick = () => {
    if (S.done) return;
    S.running = !S.running;
    $('go').textContent = S.running ? 'Pause' : 'Resume';
    hint();
  };
  $('fast').onclick = () => {
    S.fast = !S.fast; $('fast').textContent = S.fast ? '3×' : '1×';
    $('fast').setAttribute('aria-pressed', S.fast); setTimer();
  };
  const turn = d => {
    S.course = (S.course + d + 360) % 360; $('courseOut').textContent = pad3(S.course);
    if (S.running && S.turnedAt < 0) S.turnedAt = S.hist.length;
    hint();
  };
  $('port').onclick = () => turn(-30);
  $('stbd').onclick = () => turn(30);
  $('speed').oninput = e => { S.speed = +e.target.value; $('speedOut').textContent = S.speed + ' kn'; };
  $('depth').oninput = e => { S.depth = +e.target.value; $('depthOut').textContent = S.depth + ' m'; requestTrace(); };
  $('axis').oninput = e => { S.axis = +e.target.value; $('axisOut').textContent = S.axis + ' m'; requestTrace(); };
  $('gRange').oninput = e => { $('gRangeOut').textContent = e.target.value + ' km'; S.ease = true; drawPlot(); };
  $('gCourse').oninput = e => { $('gCourseOut').textContent = pad3(+e.target.value); drawPlot(); };
  $('gSpeed').oninput = e => { $('gSpeedOut').textContent = e.target.value + ' kn'; drawPlot(); };
  $('commit').onclick = () => { if (!S.done && S.hist.length) finish(true); };
  $('fresh').onclick = () => newHunt(1 + Math.floor(Math.random() * 1e6));
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft') { turn(-30); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { turn(30); e.preventDefault(); }
  });

  // drag on the ocean view with a mouse: the profile strip moves the slowest
  // depth, the ocean moves the listener. Touch uses the sliders so the page
  // can still scroll.
  (() => {
    const c = $('cRay'); let mode = null;
    const apply = e => {
      const r = c.getBoundingClientRect(), G = rayGeom(r.width, r.height);
      const z = Math.round(((e.clientY - r.top - G.y0) / (G.y1 - G.y0)) * DEPTH / 10) * 10;
      if (mode === 'axis') { S.axis = Math.max(300, Math.min(2500, z)); $('axis').value = S.axis; $('axisOut').textContent = S.axis + ' m'; }
      else { S.depth = Math.max(50, Math.min(2500, z)); $('depth').value = S.depth; $('depthOut').textContent = S.depth + ' m'; }
      requestTrace();
    };
    c.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'mouse') return;
      const r = c.getBoundingClientRect(), G = rayGeom(r.width, r.height);
      mode = (e.clientX - r.left) < G.pw + 6 ? 'axis' : 'depth';
      c.setPointerCapture(e.pointerId); apply(e);
    });
    c.addEventListener('pointermove', e => { if (mode) apply(e); });
    c.addEventListener('pointerup', () => { mode = null; });
    c.addEventListener('pointercancel', () => { mode = null; });
  })();

  // phone tabs: one view at a time, swipe or tap
  (() => {
    const views = $('views'), tabs = [...document.querySelectorAll('.tabs button')];
    tabs.forEach(b => b.onclick = () => views.scrollTo({ left: views.clientWidth * +b.dataset.view, behavior: reduced ? 'auto' : 'smooth' }));
    views.addEventListener('scroll', () => {
      const i = Math.round(views.scrollLeft / Math.max(1, views.clientWidth));
      tabs.forEach((b, k) => b.setAttribute('aria-selected', k === i));
    }, { passive: true });
  })();

  // ------------------------------------------- mid layer: range ambiguity
  function drawAmb() {
    const c = $('cAmb'); if (!c) return;
    const [g, w, h] = fit(c);
    g.clearRect(0, 0, w, h);
    g.font = MONO; g.textBaseline = 'middle';
    // Listener steams north at 12 kn for an hour. The reference contact
    // starts 20 km away. Scaling its position relative to the listener by k
    // gives another straight, steady track with identical bearings.
    const KN = 1.852, T = 1, N = 6;
    const own = t => [0, 12 * KN * t];
    const ref = t => { const a = 70 * Math.PI / 180, ca = 340 * Math.PI / 180; return [20 * Math.sin(a) + 10 * KN * t * Math.sin(ca), 20 * Math.cos(a) + 10 * KN * t * Math.cos(ca)]; };
    const cand = (k, t) => { const o = own(t), r = ref(t); return [o[0] + k * (r[0] - o[0]), o[1] + k * (r[1] - o[1])]; };
    const k = +$('amb').value;
    const sc = Math.min((w - 50) / 46, (h - 56) / 25), X = x => 30 + x * sc, Y = y => h - 34 - (y + 0.5) * sc;
    const line = (a, b) => { g.beginPath(); g.moveTo(X(a[0]), Y(a[1])); g.lineTo(X(b[0]), Y(b[1])); g.stroke(); };
    g.lineWidth = 1; g.strokeStyle = AMBER(0.55);
    for (let i = 0; i <= N; i++) { const t = T * i / N, o = own(t), f = cand(2.35, t); line(o, f); }
    g.strokeStyle = INK(1); g.lineWidth = 1.8; line(own(0), own(T));
    g.setLineDash([5, 4]); g.lineWidth = 1.2; g.strokeStyle = INK(0.45);
    for (const kk of [0.6, 1.0]) line(cand(kk, 0), cand(kk, T));
    g.strokeStyle = INK(1); g.lineWidth = 2; line(cand(k, 0), cand(k, T)); g.setLineDash([]);
    g.fillStyle = INK(1);
    for (let i = 0; i <= N; i++) { const p = cand(k, T * i / N); g.beginPath(); g.arc(X(p[0]), Y(p[1]), 2.6, 0, 7); g.fill(); const o = own(T * i / N); g.beginPath(); g.arc(X(o[0]), Y(o[1]), 2.6, 0, 7); g.fill(); }
    g.textAlign = 'left'; g.fillText('listener, heading north', X(0) - 6, Y(0) + 18);
    const a = cand(k, 0), b = cand(k, T), dx = b[0] - a[0], dy = b[1] - a[1];
    const spd = Math.hypot(dx, dy) / T / KN, crs = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360, rng = Math.hypot(a[0], a[1]);
    $('ambOut').textContent = `This one starts ${rng.toFixed(0)} km away, course ${pad3(crs)}, ${spd.toFixed(1)} kn.`;
  }
  $('amb').oninput = drawAmb;

  // ------------------------------------------------------------ depth gauge
  (() => {
    const ids = ['hunt', 'sound', 'waterfall', 'tracking', 'engineering'];
    const links = [...document.querySelectorAll('.gauge a')];
    const mark = $('gMark'), read = $('gRead');
    let queued = false;
    const place = () => {
      queued = false;
      const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
      const f = Math.min(1, Math.max(0, scrollY / max));
      const span = innerHeight - 48;
      mark.style.top = (24 + f * span) + 'px';
      read.textContent = 'depth ' + (Math.round(f * 500) * 10).toLocaleString('en-US') + ' m';
      let current = 0;
      ids.forEach((id, i) => {
        const top = $(id).offsetTop;
        links[i].style.top = (24 + Math.min(1, top / max) * span) + 'px';
        if (scrollY + innerHeight * 0.4 >= top) current = i;
      });
      links.forEach((a, i) => a.setAttribute('aria-current', i === current));
    };
    const ask = () => { if (!queued) { queued = true; requestAnimationFrame(place); } };
    addEventListener('scroll', ask, { passive: true });
    addEventListener('resize', ask);
    links.forEach(a => a.addEventListener('click', e => { e.preventDefault(); $(a.dataset.layer).scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); }));
    place();
  })();

  // If the browser's graphics process restarts, 2D canvases lose their
  // contents; redraw everything when they come back.
  ['cRay', 'cWf', 'cPlot', 'cAmb'].forEach(id => $(id).addEventListener('contextrestored', () => { S.rayLayerKey = ''; drawAll(); drawAmb(); }));

  let rz = null;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { S.rayLayerKey = ''; drawAll(); drawAmb(); }, 80); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawAll(); drawAmb(); });
  setTimer(); drawAll(); drawAmb();
  initGpu().then(() => { drawNote(); if (GPU.ok && S.rays) { try { gpuUpload(); } catch (e) { gpuOff(e); } drawRay(); } });
})();
