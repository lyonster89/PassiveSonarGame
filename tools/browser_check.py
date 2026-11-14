"""Loads the built site in headless Chrome, plays a hunt, saves screenshots.

Usage: browser_check.py WEB_DIR OUT_DIR [gpu]
With "gpu", Chrome runs WebGPU on its software renderer so that path is tested too.
"""
import sys, json, subprocess, time
from playwright.sync_api import sync_playwright
root, out = sys.argv[1], sys.argv[2]
gpu = len(sys.argv) > 3 and sys.argv[3] == 'gpu'
args = ['--no-sandbox'] + (['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--use-angle=swiftshader', '--use-webgpu-adapter=swiftshader'] if gpu else [])
srv = subprocess.Popen([sys.executable, '-m', 'http.server', '8765', '--bind', '127.0.0.1', '-d', root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
logs = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=args)
        for name, vp in [('laptop', {'width': 1366, 'height': 800}), ('phone', {'width': 380, 'height': 780})]:
            pg = b.new_page(viewport=vp, device_scale_factor=2 if name == 'phone' else 1)
            pg.on('console', lambda m: logs.append(f'{name} console {m.type}: {m.text}'))
            pg.on('pageerror', lambda e: logs.append(f'{name} PAGEERROR: {e}'))
            t0 = time.time()
            pg.goto('http://127.0.0.1:8765/index.html')
            pg.wait_for_function("!document.getElementById('go').disabled", timeout=15000)
            logs.append(f'{name} interactive after {time.time()-t0:.2f}s')
            pg.wait_for_timeout(1300)
            pg.screenshot(path=f'{out}/{name}-1-start.png')
            logs.append(f'{name} hint0: ' + pg.inner_text('#hint'))
            pg.click('#fast', force=True); pg.click('#go', force=True)
            pg.wait_for_timeout(3000)
            pg.click('#stbd'); pg.click('#stbd'); pg.click('#stbd'); pg.click('#stbd')
            pg.wait_for_timeout(8000)
            pg.screenshot(path=f'{out}/{name}-2-mid.png')
            logs.append(f'{name} hint mid: ' + pg.inner_text('#hint'))
            if name == 'phone':
                pg.click('.tabs button[data-view="2"]'); pg.wait_for_timeout(600)
                pg.screenshot(path=f'{out}/{name}-2b-chart.png')
            pg.wait_for_timeout(1500)
            pg.click('#commit')
            pg.wait_for_timeout(400)
            pg.screenshot(path=f'{out}/{name}-3-result.png', full_page=(name == 'laptop'))
            logs.append(f'{name} result: ' + pg.inner_text('#result').replace('\n', ' | ')[:400])
            logs.append(f'{name} live: ' + pg.inner_text('#czLive'))
            logs.append(f'{name} bench: ' + pg.inner_text('#bTrace') + ' / ' + pg.inner_text('#bStep') + ' / ' + pg.inner_text('#bSize') + ' / ' + pg.inner_text('#bDraw'))
            if name == 'phone':
                pg.screenshot(path=f'{out}/{name}-4-full.png', full_page=True)
            ov = pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            logs.append(f'{name} horizontal overflow px: {ov}')
            pg.close()
        b.close()
finally:
    srv.terminate()
print('\n'.join(logs))
