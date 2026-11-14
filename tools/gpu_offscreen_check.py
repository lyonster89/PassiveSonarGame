"""Checks the WebGPU ray shader without a screen.

Headless Chrome's software renderer loses the WebGPU device as soon as a frame
is presented to a canvas, so the on-screen path cannot be tested here. This
script takes the shader source from web/app.js, traces rays with the real
WebAssembly core, draws them to an off-screen texture with the same pipeline
settings (4x multisampling, premultiplied alpha blending), reads the pixels
back and saves them as a PNG over the paper colour.

Usage: gpu_offscreen_check.py WEB_DIR OUT.png
"""
import sys, re, subprocess, time, base64
from playwright.sync_api import sync_playwright
root, out = sys.argv[1], sys.argv[2]
wgsl = re.search(r"const WGSL = `(.*?)`;", open(f'{root}/app.js').read(), re.S).group(1)
JS = """async (wgsl) => {
  const bytes = await (await fetch('sim_core.wasm')).arrayBuffer();
  const ex = (await WebAssembly.instantiate(bytes, {})).instance.exports;
  ex.sc_trace(300);
  const nRays = ex.sc_layout(0), pts = ex.sc_layout(1);
  const r = new Float32Array(ex.memory.buffer, ex.sc_rays_ptr(), nRays * pts * 3);
  const v = new Float32Array(nRays * (pts - 1) * 6); let n = 0;
  for (let i = 0; i < nRays; i++) for (let k = 0; k < pts - 1; k++) {
    const a = (i * pts + k) * 3, b = a + 3; if (r[b] !== r[b]) break;
    const bo = r[b + 2] > 0 ? 1 : 0;
    v[n++] = r[a]; v[n++] = r[a + 1]; v[n++] = bo; v[n++] = r[b]; v[n++] = r[b + 1]; v[n++] = bo;
  }
  const adapter = await navigator.gpu.requestAdapter(); const d = await adapter.requestDevice();
  d.pushErrorScope('validation');
  const W = 924, H = 204, format = 'rgba8unorm';
  const module = d.createShaderModule({ code: wgsl });
  const blend = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' };
  const pipeline = d.createRenderPipeline({ layout: 'auto',
    vertex: { module, entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] },
    fragment: { module, entryPoint: 'fs', targets: [{ format, blend: { color: blend, alpha: blend } }] },
    primitive: { topology: 'line-list' }, multisample: { count: 4 } });
  const ubuf = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(ubuf, 0, new Float32Array([-0.95, 0.9, 0.95, -0.9, 1, 0, 0, 0]));
  const bind = d.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  const vbuf = d.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  d.queue.writeBuffer(vbuf, 0, v, 0, n);
  const msaa = d.createTexture({ size: [W, H], sampleCount: 4, format, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const tex = d.createTexture({ size: [W, H], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const enc = d.createCommandEncoder();
  const pass = enc.beginRenderPass({ colorAttachments: [{ view: msaa.createView(), resolveTarget: tex.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'discard' }] });
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.setVertexBuffer(0, vbuf); pass.draw(n / 3); pass.end();
  const rowBytes = Math.ceil(W * 4 / 256) * 256;
  const rb = d.createBuffer({ size: rowBytes * H, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  enc.copyTextureToBuffer({ texture: tex }, { buffer: rb, bytesPerRow: rowBytes }, [W, H]);
  d.queue.submit([enc.finish()]);
  const err = await d.popErrorScope();
  await rb.mapAsync(GPUMapMode.READ);
  const px = new Uint8Array(rb.getMappedRange());
  // composite over paper on a 2D canvas and report coverage
  const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d');
  const img = g.createImageData(W, H); let inked = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = y * rowBytes + x * 4, t = (y * W + x) * 4, a = px[s + 3] / 255;
    if (a > 0.02) inked++;
    img.data[t] = px[s] + 243 * (1 - a); img.data[t + 1] = px[s + 1] + 239 * (1 - a); img.data[t + 2] = px[s + 2] + 230 * (1 - a); img.data[t + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return { err: err ? err.message : null, vertices: n / 3, inkedFraction: inked / (W * H), png: c.toDataURL('image/png') };
}"""
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8771', '--bind', '127.0.0.1', '-d', root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'])
        pg = b.new_page()
        pg.goto('http://localhost:8771/index.html')
        r = pg.evaluate(JS, wgsl)
        open(out, 'wb').write(base64.b64decode(r['png'].split(',')[1]))
        print('validation error:', r['err'], '| vertices:', r['vertices'], '| inked fraction: %.3f' % r['inkedFraction'])
        b.close()
finally:
    srv.terminate()
