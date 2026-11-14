"""Full functional review: drives every control and checks what depends on it.

Usage: full_review.py WEB_DIR
Prints one PASS/FAIL line per check and exits non-zero if anything fails.
"""
import sys, subprocess, time, re
from playwright.sync_api import sync_playwright

root = sys.argv[1]
PORT = 8780
URL = f'http://127.0.0.1:{PORT}/index.html'
results = []

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS  ' if ok else 'FAIL  ') + name + (f'  [{detail}]' if detail and not ok else ''))

# pixel helpers, run in the page
JS_AMBER = """(id) => { const c = document.getElementById(id), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 40 && d[i] > 180 && d[i+1] > 90 && d[i+1] < 190 && d[i+2] < 110) n++; return n; }"""
JS_TEAL = """(id) => { const c = document.getElementById(id), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 40 && d[i] < 120 && d[i+1] > 110 && d[i+2] > 110 && d[i+1] - d[i] > 40) n++; return n; }"""
JS_SUM = """(id) => { const c = document.getElementById(id), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 3; i < d.length; i += 4) s = (s * 31 + d[i] + d[i-1]) % 1000000007; return s; }"""
JS_INK = """(id) => { const c = document.getElementById(id), g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) n++; return n; }"""

def ready(pg):
    pg.wait_for_function("!document.getElementById('go').disabled", timeout=15000)
    pg.wait_for_timeout(1200)

def set_range(pg, id, value):
    pg.evaluate("([id, v]) => { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }", [id, value])

srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '-d', root], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

        # ------------------------------------------------------------ laptop
        ctx = b.new_context(viewport={'width': 1366, 'height': 800})
        pg = ctx.new_page()
        errors, failed = [], []
        pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errors.append('PAGEERROR ' + str(e)))
        pg.on('requestfailed', lambda r: failed.append(r.url))
        pg.on('response', lambda r: failed.append(f'{r.status} {r.url}') if r.status >= 400 else None)
        pg.goto(URL); ready(pg)

        print('--- load')
        check('page becomes interactive', True)
        check('tour starts at step 1 and points at Start', pg.inner_text('#hint').startswith('1 of 5') and 'spot' in pg.get_attribute('#go', 'class'))
        check('ocean view has rays drawn', pg.evaluate(JS_INK, 'cRay') > 20000, str(pg.evaluate(JS_INK, 'cRay')))
        check('waterfall shows its empty-state message, no bearings', pg.evaluate(JS_AMBER, 'cWf') == 0)
        check('commit is disabled before a hunt', pg.is_disabled('#commit'))
        check('benchmarks filled in', all(re.search(r'\d', pg.inner_text(s)) for s in ('#bTrace', '#bStep', '#bSize')) and pg.inner_text('#bDraw') not in ('', '…'), pg.inner_text('#bDraw'))
        fits = pg.evaluate("document.querySelector('.stage').getBoundingClientRect().bottom <= innerHeight + 2")
        check('whole hunt screen fits one laptop screen (1366x800)', fits)

        print('--- ocean controls and what depends on them')
        before_sum, before_live = pg.evaluate(JS_SUM, 'cRay'), pg.inner_text('#czLive')
        set_range(pg, 'depth', 1200); pg.wait_for_timeout(500)
        check('listener depth slider updates its readout', pg.inner_text('#depthOut') == '1200 m', pg.inner_text('#depthOut'))
        check('listener depth slider redraws the rays', pg.evaluate(JS_SUM, 'cRay') != before_sum)
        check('listener depth slider updates the live text in the "How sound bends" layer', pg.inner_text('#czLive') != before_live and '1200 m' in pg.inner_text('#czLive'), pg.inner_text('#czLive'))
        s2, l2 = pg.evaluate(JS_SUM, 'cRay'), pg.inner_text('#czLive')
        set_range(pg, 'axis', 800); pg.wait_for_timeout(500)
        check('slowest-sound slider updates its readout', pg.inner_text('#axisOut') == '800 m')
        check('slowest-sound slider redraws the rays', pg.evaluate(JS_SUM, 'cRay') != s2)
        check('slowest-sound slider updates the live text', pg.inner_text('#czLive') != l2 and '800 m' in pg.inner_text('#czLive'))
        box = pg.locator('#cRay').bounding_box()
        pg.mouse.move(box['x'] + box['width'] * 0.6, box['y'] + box['height'] * 0.3); pg.mouse.down(); pg.mouse.move(box['x'] + box['width'] * 0.6, box['y'] + box['height'] * 0.45, steps=4); pg.mouse.up(); pg.wait_for_timeout(400)
        d_drag = pg.inner_text('#depthOut')
        check('dragging on the ocean moves the listener and syncs the slider', d_drag != '1200 m' and pg.input_value('#depth') + ' m' == d_drag, d_drag)
        pg.mouse.move(box['x'] + 30, box['y'] + box['height'] * 0.5); pg.mouse.down(); pg.mouse.move(box['x'] + 30, box['y'] + box['height'] * 0.6, steps=3); pg.mouse.up(); pg.wait_for_timeout(400)
        check('dragging on the profile strip moves the slowest depth and syncs the slider', pg.inner_text('#axisOut') != '800 m' and pg.input_value('#axis') + ' m' == pg.inner_text('#axisOut'), pg.inner_text('#axisOut'))
        set_range(pg, 'depth', 300); set_range(pg, 'axis', 1300); pg.wait_for_timeout(500)

        print('--- hunt')
        pg.click('#go'); pg.wait_for_timeout(2500)
        check('Start changes to Pause', pg.inner_text('#go') == 'Pause')
        check('tour moves to step 2 and points at the waterfall', pg.inner_text('#hint').startswith('2 of 5') and 'spot' in (pg.get_attribute('#vWf', 'class') or ''))
        check('waterfall receives bearings', pg.evaluate(JS_AMBER, 'cWf') > 20)
        check('chart shows the estimate cloud', pg.evaluate(JS_TEAL, 'cPlot') > 50, str(pg.evaluate(JS_TEAL, 'cPlot')))
        check('signal label reports signal quality', 'signal:' in pg.inner_text('#sig') and 'none yet' not in pg.inner_text('#sig'), pg.inner_text('#sig'))
        check('"tracking math" layer shows live filter numbers', 'Estimated range' in pg.inner_text('#pfLive'))
        check('commit becomes available once the filter has an estimate', not pg.is_disabled('#commit'))
        pg.click('#go'); pg.wait_for_timeout(300)
        a1 = pg.evaluate(JS_SUM, 'cWf'); pg.wait_for_timeout(900); a2 = pg.evaluate(JS_SUM, 'cWf')
        check('Pause stops the hunt', a1 == a2 and pg.inner_text('#go') == 'Resume' and 'Paused' in pg.inner_text('#hint'))
        pg.click('#go'); pg.wait_for_timeout(900)
        check('Resume continues and restores the tour text', pg.evaluate(JS_SUM, 'cWf') != a2 and re.match(r'\d of 5', pg.inner_text('#hint')) is not None, pg.inner_text('#hint'))
        pg.click('#fast')
        check('speed toggle switches to 3x', pg.inner_text('#fast') == '3×' and pg.get_attribute('#fast', 'aria-pressed') == 'true')
        pg.wait_for_timeout(2600)
        check('tour asks for a turn at step 3 and points at the course buttons', pg.inner_text('#hint').startswith('3 of 5') and 'spot' in (pg.get_attribute('#turnBtns', 'class') or ''), pg.inner_text('#hint'))
        pg.click('#stbd'); pg.click('#stbd'); pg.click('#stbd')
        check('course buttons update the ordered course', pg.inner_text('#courseOut') == '090°', pg.inner_text('#courseOut'))
        pg.locator('h1').click(); pg.keyboard.press('ArrowLeft')
        check('arrow keys turn the ship', pg.inner_text('#courseOut') == '060°', pg.inner_text('#courseOut'))
        pg.keyboard.press('ArrowRight'); pg.keyboard.press('ArrowRight')
        check('tour moves to step 4 after the turn and points at the chart', pg.inner_text('#hint').startswith('4 of 5') and 'spot' in (pg.get_attribute('#vPlot', 'class') or ''), pg.inner_text('#hint'))
        set_range(pg, 'speed', 14)
        check('speed slider updates its readout', pg.inner_text('#speedOut') == '14 kn')
        pg.wait_for_timeout(3600)
        check('tour reaches step 5 and points at the answer', pg.inner_text('#hint').startswith('5 of 5') and 'spot' in (pg.get_attribute('#answer', 'class') or ''), pg.inner_text('#hint'))
        c1 = pg.evaluate(JS_SUM, 'cPlot'); pg.click('#go'); pg.wait_for_timeout(300); c1 = pg.evaluate(JS_SUM, 'cPlot')
        set_range(pg, 'gRange', 25); set_range(pg, 'gCourse', 140); set_range(pg, 'gSpeed', 12); pg.wait_for_timeout(200)
        check('answer sliders update their readouts', (pg.inner_text('#gRangeOut'), pg.inner_text('#gCourseOut'), pg.inner_text('#gSpeedOut')) == ('25 km', '140°', '12 kn'))
        check('answer sliders move your marker on the chart', pg.evaluate(JS_SUM, 'cPlot') != c1)

        print('--- linking between views')
        wbox = pg.locator('#cWf').bounding_box(); c2 = pg.evaluate(JS_SUM, 'cPlot'); sig0 = pg.inner_text('#sig')
        pg.mouse.move(wbox['x'] + wbox['width'] * 0.5, wbox['y'] + 60); pg.wait_for_timeout(300)
        check('pointing at a moment in the waterfall highlights it on the chart', pg.evaluate(JS_SUM, 'cPlot') != c2)
        check('pointing at a moment in the waterfall reports that moment in the ocean view label', pg.inner_text('#sig') != sig0, pg.inner_text('#sig'))
        fig_h = pg.locator('#vWf').bounding_box()['height']
        wtxt = pg.inner_text('#wfOut')
        check('waterfall readout shows time and bearing under the pointer', re.match(r'(now|−\d+\.\d min) · bearing \d{3}°', wtxt) is not None, wtxt)
        pg.mouse.move(5, 5); pg.wait_for_timeout(200)
        check('showing a readout does not shift the layout', abs(pg.locator('#vWf').bounding_box()['height'] - fig_h) < 0.5)
        pg.mouse.move(wbox['x'] + wbox['width'] * 0.5, wbox['y'] + 150); pg.wait_for_timeout(300)
        check('waterfall readout changes as the pointer moves', pg.inner_text('#wfOut') != wtxt, pg.inner_text('#wfOut'))
        pg.mouse.move(5, 5); pg.wait_for_timeout(300)
        check('moving away clears the highlight and the readout', pg.evaluate(JS_SUM, 'cPlot') == c2 and pg.inner_text('#sig') == sig0 and pg.inner_text('#wfOut') == '')
        rbox = pg.locator('#cRay').bounding_box()
        pg.mouse.move(rbox['x'] + rbox['width'] * 0.6, rbox['y'] + rbox['height'] * 0.5); pg.wait_for_timeout(300)
        rtxt = pg.inner_text('#sig')
        check('ocean readout shows range, depth, sound speed and path type', re.match(r'\d+\.\d km · [\d,]+ m · \d{4} m/s · (direct sound|sea-floor bounce only|shadow)$', rtxt) is not None, rtxt)
        pg.mouse.move(rbox['x'] + 40, rbox['y'] + rbox['height'] * 0.5); pg.wait_for_timeout(300)
        check('profile strip readout shows depth and sound speed', re.match(r'depth [\d,]+ m · sound speed \d{4} m/s$', pg.inner_text('#sig')) is not None, pg.inner_text('#sig'))
        pbox = pg.locator('#cPlot').bounding_box()
        pg.mouse.move(pbox['x'] + pbox['width'] * 0.5, pbox['y'] + 30); pg.wait_for_timeout(300)
        ptxt = pg.inner_text('#plotOut')
        check('chart readout shows bearing and range from your ship', re.match(r'bearing \d{3}° · \d+\.\d km$', ptxt) is not None, ptxt)
        check('pointing straight up from your ship reads as north', ptxt.startswith('bearing 000°') or ptxt.startswith('bearing 360°') or ptxt.startswith('bearing 359°') or ptxt.startswith('bearing 001°'), ptxt)
        pg.mouse.move(5, 5); pg.wait_for_timeout(300)
        check('readouts clear when the pointer leaves', pg.inner_text('#plotOut') == '' and pg.inner_text('#sig') == sig0)

        print('--- finishing a hunt')
        pg.click('#commit'); pg.wait_for_timeout(400)
        rows = pg.locator('#result table tr').count()
        check('commit shows a result with you, the computer and the truth', rows == 6 and pg.is_visible('#result'), f'rows={rows}')
        check('after commit Start and Commit are disabled and the tour points at New contact', pg.is_disabled('#go') and pg.is_disabled('#commit') and 'spot' in pg.get_attribute('#fresh', 'class'))
        check('the true contact is revealed on the chart and the ocean view', pg.evaluate(JS_AMBER, 'cRay') > 20 and 'Hunt over' in pg.inner_text('#hint'))
        pg.click('#fresh'); pg.wait_for_timeout(700)
        check('New contact clears the result and re-enables Start', not pg.is_visible('#result') and not pg.is_disabled('#go') and pg.inner_text('#go') == 'Start')
        check('New contact clears the waterfall', pg.evaluate(JS_AMBER, 'cWf') == 0, str(pg.evaluate(JS_AMBER, 'cWf')))
        check('New contact resets course, signal label and tour', pg.inner_text('#courseOut') == '000°' and 'none yet' in pg.inner_text('#sig') and pg.inner_text('#hint').startswith('1 of 5'))
        check('New contact resets the live filter text', 'Estimated range' not in pg.inner_text('#pfLive'), pg.inner_text('#pfLive')[:60])
        pg.click('#go'); pg.wait_for_timeout(1500); pg.click('#fresh'); pg.wait_for_timeout(900)
        check('New contact pressed mid-hunt leaves no stale bearings', pg.evaluate(JS_AMBER, 'cWf') == 0, str(pg.evaluate(JS_AMBER, 'cWf')))
        pg.click('#go'); pg.wait_for_function("document.getElementById('result').hidden === false", timeout=40000)
        check('a hunt left alone ends by itself after two simulated hours', 'Time ran out' in pg.inner_text('#result'))
        pg.click('#fresh'); pg.wait_for_timeout(500)

        print('--- deeper layers and navigation')
        t0 = pg.inner_text('#ambOut'); s0 = pg.evaluate(JS_SUM, 'cAmb'); set_range(pg, 'amb', 0.8)
        check('range-ambiguity slider redraws its chart and text', pg.inner_text('#ambOut') != t0 and pg.evaluate(JS_SUM, 'cAmb') != s0)
        for layer in ['sound', 'waterfall', 'tracking', 'engineering', 'hunt']:
            pg.click(f'.gauge a[data-layer="{layer}"]'); pg.wait_for_timeout(1300)
            top = pg.evaluate(f"document.getElementById('{layer}').getBoundingClientRect().top")
            at_end = pg.evaluate("scrollY + innerHeight >= document.documentElement.scrollHeight - 2")
            cur = pg.get_attribute(f'.gauge a[data-layer="{layer}"]', 'aria-current')
            check(f'depth gauge jumps to "{layer}" and marks it current', (abs(top) < 4 or at_end) and cur == 'true', f'top={top:.0f} current={cur}')
        pg.evaluate("scrollTo(0, document.documentElement.scrollHeight)"); pg.wait_for_timeout(400)
        check('depth readout reaches 5,000 m at the bottom', '5,000 m' in pg.inner_text('#gRead'), pg.inner_text('#gRead'))
        href = pg.get_attribute('#engineering a[href^="https://github.com"]', 'href')
        check('source link points at the repository', href == 'https://github.com/lyonster89/PassiveSonarGame', str(href))
        pg.set_viewport_size({'width': 1000, 'height': 700}); pg.wait_for_timeout(500)
        check('resizing the window redraws without overflow', pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") == 0 and pg.evaluate(JS_INK, 'cRay') > 10000)
        pg2 = ctx.new_page(); pg2.goto(URL + '#tracking'); ready(pg2)
        check('opening the page at #tracking lands on that layer', abs(pg2.evaluate("document.getElementById('tracking').getBoundingClientRect().top")) < 60, str(pg2.evaluate("document.getElementById('tracking').getBoundingClientRect().top")))
        pg2.close()
        pg.goto(URL); ready(pg)
        pg.keyboard.press('Tab')
        order = []
        for _ in range(14):
            order.append(pg.evaluate("document.activeElement.id || document.activeElement.textContent.trim().slice(0, 12)")); pg.keyboard.press('Tab')
        check('keyboard Tab reaches the hunt controls', all(k in order for k in ('go', 'port', 'stbd', 'speed', 'commit')) or all(k in order for k in ('go', 'port', 'stbd')), ' '.join(order))
        pg.focus('#go'); pg.keyboard.press('Enter'); pg.wait_for_timeout(600)
        check('Enter on Start begins the hunt', pg.inner_text('#go') == 'Pause')
        check('no console errors on laptop', not errors, '; '.join(errors)[:300])
        bad = [f for f in failed if 'favicon' not in f]
        check('no failed or 4xx requests', not bad, '; '.join(bad)[:300])
        ctx.close()

        # ------------------------------------------------------------- phone
        print('--- phone (380 px wide)')
        ctx = b.new_context(viewport={'width': 380, 'height': 780}, device_scale_factor=2, has_touch=True, is_mobile=True)
        pg = ctx.new_page(); perr = []
        pg.on('console', lambda m: perr.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: perr.append('PAGEERROR ' + str(e)))
        pg.goto(URL); ready(pg)
        check('no sideways overflow', pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth") == 0)
        hb = pg.locator('.helm-main').bounding_box()
        check('Start and course buttons stay pinned in view', hb['y'] + hb['height'] <= 781 and hb['y'] > 400, str(hb))
        check('ocean view starts within the first screen', pg.locator('#cRay').bounding_box()['y'] < 780)
        for i, name in enumerate(['Ocean', 'Waterfall', 'Chart']):
            pg.tap(f'.tabs button[data-view="{i}"]'); pg.wait_for_timeout(700)
            left = pg.evaluate("document.getElementById('views').scrollLeft / document.getElementById('views').clientWidth")
            sel = pg.get_attribute(f'.tabs button[data-view="{i}"]', 'aria-selected')
            check(f'tab "{name}" shows its view and is marked selected', abs(left - i) < 0.05 and sel == 'true', f'left={left:.2f} sel={sel}')
        pg.tap('.tabs button[data-view="0"]'); pg.wait_for_timeout(600)
        pg.tap('#go'); pg.wait_for_timeout(1500)
        left = pg.evaluate("document.getElementById('views').scrollLeft / document.getElementById('views').clientWidth")
        check('tour swipes to the waterfall at step 2', abs(left - 1) < 0.05, f'left={left:.2f}')
        small = pg.evaluate("[...document.querySelectorAll('button, input[type=range]')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 24).map(e => e.id || e.textContent.trim())")
        check('touch targets are at least 24 px tall', not small, str(small))
        wb = pg.locator('#cWf').bounding_box()
        pg.touchscreen.tap(wb['x'] + wb['width'] * 0.5, wb['y'] + 40); pg.wait_for_timeout(400)
        check('tapping the waterfall on a phone shows the readout', 'bearing' in pg.inner_text('#wfOut'), pg.inner_text('#wfOut'))
        check('gauge is replaced by the depth chip on phone', not pg.is_visible('.gauge') and pg.is_visible('#gRead'))
        check('no console errors on phone', not perr, '; '.join(perr)[:300])
        ctx.close()

        # ----------------------------------------------------- failure paths
        print('--- failure paths')
        ctx = b.new_context(viewport={'width': 1366, 'height': 800}); pg = ctx.new_page()
        pg.route('**/sim_core.wasm', lambda r: r.abort())
        pg.goto(URL); pg.wait_for_timeout(2500)
        check('if the simulation core fails to load, the page says so', 'could not start' in pg.inner_text('#hint'), pg.inner_text('#hint'))
        ctx.close()
        ctx = b.new_context(viewport={'width': 1366, 'height': 800}); pg = ctx.new_page()
        pg.route('**/worker.js', lambda r: r.abort())
        pg.goto(URL); pg.wait_for_timeout(2500)
        check('if the worker script fails to load, the page says so', 'could not start' in pg.inner_text('#hint'), pg.inner_text('#hint'))
        ctx.close()
        ctx = b.new_context(viewport={'width': 1366, 'height': 800}); pg = ctx.new_page()
        pg.route('**/fonts.googleapis.com/**', lambda r: r.abort()); pg.route('**/fonts.gstatic.com/**', lambda r: r.abort())
        pg.goto(URL); ready(pg)
        check('page works with the web fonts blocked', pg.evaluate(JS_INK, 'cRay') > 20000 and not pg.is_disabled('#go'))
        ctx.close()
        ctx = b.new_context(viewport={'width': 1366, 'height': 800}, reduced_motion='reduce'); pg = ctx.new_page()
        pg.goto(URL); pg.wait_for_function("!document.getElementById('go').disabled", timeout=15000); pg.wait_for_timeout(250)
        check('with reduced motion the rays appear at once', pg.evaluate(JS_INK, 'cRay') > 20000, str(pg.evaluate(JS_INK, 'cRay')))
        ctx.close()
        ctx = b.new_context(viewport={'width': 1366, 'height': 800}, java_script_enabled=False); pg = ctx.new_page()
        pg.goto(URL); pg.wait_for_timeout(500)
        check('with JavaScript off the page explains what is needed', 'needs JavaScript' in pg.inner_text('body'))
        ctx.close()
        b.close()
finally:
    srv.terminate()

fails = [r for r in results if not r[1]]
print(f'\n{len(results) - len(fails)} of {len(results)} checks passed')
sys.exit(1 if fails else 0)
