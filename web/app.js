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

  const worker = new Worker('worker.js');
  worker.onmessage = e => {
    const m = e.data;
    if (m.type === 'ready') onReady(m);
    else if (m.type === 'rays') onRays(m);
    else if (m.type === 'state') onState(m);
    else if (m.type === 'error') { $('hint').textContent = 'The simulation could not start: ' + m.message; $('hint').classList.add('err'); }
  };
  worker.onerror = e => { $('hint').textContent = 'The simulation could not start in this browser.'; $('hint').classList.add('err'); };

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
  function drawRayLayer(w, h, d) {
    const key = `${w}x${h}x${d}`;
    if (!S.rayLayer) S.rayLayer = document.createElement('canvas');
    const c = S.rayLayer;
    c.width = Math.round(w * d); c.height = Math.round(h * d);
    S.rayLayerKey = key;
    const g = c.getContext('2d');
    g.setTransform(d, 0, 0, d, 0, 0);
    const G = rayGeom(w, h);
    const X = r => G.x0 + (r / (RANGE_KM * 1000)) * (G.x1 - G.x0);
    const Y = z => G.y0 + (z / DEPTH) * (G.y1 - G.y0);
    const { nDrawRays, rayPts } = S.L;
    const direct = new Path2D(), bounced = new Path2D();
    for (let i = 0; i < nDrawRays; i++) {
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
    g.lineWidth = 0.8;
    g.strokeStyle = INK(0.10); g.stroke(bounced);
    g.strokeStyle = INK(0.42); g.stroke(direct);
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
    const key = `${w}x${h}x${d}`;
    if (S.rayLayerKey !== key) drawRayLayer(w, h, d);
    g.save();
    g.beginPath(); g.rect(G.x0, G.y0, (G.x1 - G.x0) * S.rayReveal, G.y1 - G.y0); g.clip();
    g.drawImage(S.rayLayer, 0, 0, w, h);
    g.restore();

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
    S.tracePending = false;
    if (S.traceQueued) { S.traceQueued = false; requestTrace(); }
    if (S.rayReveal < 1 && !S.revealing) {
      S.revealing = true;
      const t0 = performance.now();
      const tick = t => { S.rayReveal = Math.min(1, (t - t0) / 900); drawRay(); if (S.rayReveal < 1) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
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
  function hash(n) { let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); return ((x ^ (x >>> 16)) >>> 0) / 4294967296; }
  function drawWf() {
    const [g, w, h] = fit($('cWf'));
    g.clearRect(0, 0, w, h);
    const x0 = 58, x1 = w - 10, y0 = 26, y1 = h - 8, rh = (y1 - y0) / STEPS;
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
    S.reach = S.reach ? S.reach + (reach - S.reach) * 0.25 : reach;
    const sc = Math.min(w, h) / 2 / S.reach, cx = w / 2, cy = h / 2;
    const X = x => cx + (x - ox) * sc, Y = y => cy - (y - oy) * sc;
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
    // own ship
    const hd = (o ? o[3] : 0) * Math.PI / 180;
    g.save(); g.translate(cx, cy); g.rotate(hd); g.fillStyle = INK(1);
    g.beginPath(); g.moveTo(0, -9); g.lineTo(6, 7); g.lineTo(-6, 7); g.closePath(); g.fill(); g.restore();
  }
  function lastDetected() { for (let k = S.hist.length - 1; k >= 0; k--) if (S.hist[k].det) return S.hist[k]; return null; }

  // ------------------------------------------------------------------- hunt
  function onReady(m) {
    S.L = m.layout; S.ready = true;
    $('bTrace').textContent = m.bench.traceMs.toFixed(1) + ' ms';
    $('bStep').textContent = m.bench.stepMs.toFixed(2) + ' ms';
    $('bSize').textContent = (m.wasmBytes / 1024).toFixed(0) + ' kB';
    $('go').disabled = false; $('fresh').disabled = false;
    requestTrace();
    newHunt(S.seed);
  }
  function newHunt(seed) {
    S.seed = seed; S.running = false; S.done = false; S.waiting = false;
    S.hist = []; S.track = []; S.center = null; S.turnedAt = -1; S.reach = 0;
    S.course = 0; $('courseOut').textContent = '000°';
    $('result').hidden = true; $('result').innerHTML = '';
    $('go').textContent = 'Start'; $('go').disabled = false; $('commit').disabled = true;
    $('sig').textContent = 'signal: none yet';
    worker.postMessage({ type: 'reset', seed });
    hint();
  }
  function onState(m) {
    S.waiting = false;
    const o = m.out; S.out = o;
    if (m.fresh) { S.track = [[o[1], o[2]]]; drawAll(); return; }
    const det = o[5] > 0;
    if (det && S.center == null) S.center = o[6];
    S.hist.push({ i: o[19], b: o[6], sig: o[7], det, se: o[8], zone: o[9], x: o[1], y: o[2] });
    S.track.push([o[1], o[2]]);
    $('sig').textContent = !det ? 'signal: lost in a shadow zone'
      : o[9] >= 2 ? `signal: strong, clear path (±${o[7].toFixed(1)}°)`
      : `signal: weak, sea-floor bounce (±${o[7].toFixed(1)}°)`;
    if (o[26] > 0) {
      const sd = Math.sqrt(Math.max(o[12], o[14]));
      $('pfLive').innerHTML = `<b>Live from the hunt.</b> Estimated range ${o[15].toFixed(1)} km, give or take about ${sd.toFixed(1)} km. Course ${pad3(o[16])}, speed ${o[17].toFixed(1)} kn. Guesses still carrying weight: ${(100 * o[18]).toFixed(0)}%.`;
      $('commit').disabled = S.done;
    }
    if (o[19] >= STEPS && !S.done) finish(false);
    drawWf(); drawPlot(); hint();
  }
  function tick() {
    if (!S.running || S.waiting || S.done) return;
    S.waiting = true;
    worker.postMessage({ type: 'step', course: S.course, speed: S.speed });
  }
  let timer = null;
  function setTimer() { clearInterval(timer); timer = setInterval(tick, S.fast ? 80 : 250); }
  function hint() {
    const n = S.hist.length, el = $('hint');
    if (!S.ready) return;
    if (S.done) { el.textContent = 'Hunt over. The amber dot is where the contact really was. Press New contact to try again.'; return; }
    if (!S.running && n === 0) { el.textContent = 'Press Start. A ship is out there, and all you will get is the direction of its sound.'; return; }
    if (!S.running) { el.textContent = 'Paused.'; return; }
    if (n < 24) el.textContent = 'The amber trace is the direction of the sound over time. Notice how long the teal cloud is: many ranges fit so far.';
    else if (S.turnedAt < 0) el.textContent = 'Now turn your ship with the course buttons. Moving across the line of sight is what reveals range.';
    else if (n - S.turnedAt < 40) el.textContent = 'Watch the teal cloud shrink as bearings from your new course rule out wrong ranges.';
    else el.textContent = 'Set your answer with the three sliders, then commit. Turn again if the cloud is still long.';
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
  $('gRange').oninput = e => { $('gRangeOut').textContent = e.target.value + ' km'; drawPlot(); };
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

  let rz = null;
  addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { S.rayLayerKey = ''; drawAll(); drawAmb(); }, 80); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { drawAll(); drawAmb(); });
  setTimer(); drawAll(); drawAmb();
})();
