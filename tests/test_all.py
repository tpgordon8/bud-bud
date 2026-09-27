"""Full test suite. Run from repo root: python3 build.py && python3 tests/test_all.py
Needs: node, python playwright (chromium), Pillow."""
import json, os, subprocess, time, urllib.request, pathlib
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
ROOT = pathlib.Path(__file__).resolve().parent.parent
B = 'http://localhost:8787'; res = []; errs = []
def check(n, c, i=''): res.append((n, bool(c))); print(('PASS ' if c else 'FAIL ') + n, '' if c else i)
L = lambda: json.loads(urllib.request.urlopen(B + '/__log').read())
mode = lambda m: urllib.request.urlopen(B + '/__mode?m=' + m)
im = Image.new('RGB', (900, 600), 'white'); d = ImageDraw.Draw(im)
for k, t in enumerate(['GELATO 41', 'THCa 26.1%', 'THC 0.8%']): d.text((60, 60 + k * 80), t, fill='black')
im.save('/tmp/bb_label.jpg')
srv = subprocess.Popen(['node', str(ROOT / 'tests/server.mjs')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    h = json.loads(urllib.request.urlopen(B + '/api/health').read())
    check('health: ai, analytics, feedback form readable', h['ai'] and h['analytics'] and h['feedback'], h)
    check('health: current models configured', h['models'] == ['gemini-3.8-flash', 'gemini-3.5-flash-lite'], h)
    with sync_playwright() as p:
        b = p.chromium.launch()
        def page(vw=(390, 844), claude=False):
            ctx = b.new_context(viewport={'width': vw[0], 'height': vw[1]})
            ctx.route('https://www.googletagmanager.com/**', lambda r: r.fulfill(status=200, body='window.__ga=1', content_type='application/javascript'))
            ctx.add_init_script("localStorage.setItem('budbud.consent', JSON.stringify({v:'2026-09-27'}));")
            pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
            return ctx, pg
        def scan(pg):
            with pg.expect_file_chooser() as fc: pg.click('[data-cam]')
            fc.value.set_files('/tmp/bb_label.jpg')
        for vw in [(390, 844), (1024, 1366), (1440, 900)]:
            ctx, pg = page(vw); pg.goto(B); pg.wait_for_timeout(500)
            check(f'web {vw}: loads, feedback link, no sideways scroll', 'in the jar' in pg.inner_text('#view') and pg.is_visible('.foot [data-feedback]') and pg.evaluate('document.documentElement.scrollWidth<=window.innerWidth'))
            ctx.close()
        ctx, pg = page(); pg.goto(B); pg.wait_for_timeout(500)
        check('web: analytics loads', pg.evaluate('!!window.__ga'))
        mode('ok'); scan(pg); pg.wait_for_selector('#goBtn', timeout=10000)
        check('web: scan fills values', pg.input_value('#c-THCA') == '26.1' and pg.input_value('#f-name') == 'Gelato 41')
        g = L()['gemini'][-1]
        check('web: key stays on server', g['key'] == 'SECRET_TEST_KEY_123' and 'SECRET' not in pg.content())
        check('web: uses newest model, low thinking, JSON mode', 'gemini-3.8-flash:' in g['url'] and g['body']['generationConfig'] == {'responseMimeType': 'application/json', 'maxOutputTokens': 4096, 'thinkingConfig': {'thinkingLevel': 'low'}}, g['body']['generationConfig'])
        pg.click('#goBtn'); pg.wait_for_selector('.big', timeout=5000)
        ev = pg.evaluate("(window.dataLayer||[]).filter(a=>a[0]==='event').map(a=>a[1])")
        check('web: analytics events', all(x in ev for x in ['scan_start', 'scan_success', 'result_view']), ev)
        for m, label in [('first429', 'busy'), ('first404', 'unavailable')]:
            mode(m); n0 = len(L()['gemini']); scan(pg); pg.wait_for_selector('#goBtn', timeout=10000)
            calls = [x['url'] for x in L()['gemini'][n0:]]
            he = json.loads(urllib.request.urlopen(B + '/api/health').read())['model_errors']
            check(f'health records why first model was {label}', he.get('gemini-3.8-flash', {}).get('status') == (429 if m == 'first429' else 404), he)
            lite = [x for x in L()['gemini'][n0:] if 'flash-lite' in x['url']]
            check(f'web: backup model uses minimal thinking ({label})', lite and lite[0]['body']['generationConfig']['thinkingConfig'] == {'thinkingLevel': 'minimal'})
            check(f'web: falls back to backup model when first is {label}', len(calls) == 2 and 'gemini-3.5-flash-lite:' in calls[1] and pg.input_value('#c-THCA') == '26.1', calls)
            pg.goto(B); pg.wait_for_timeout(400)
        mode('all429'); scan(pg); pg.wait_for_timeout(2500)
        check('web: both models busy -> friendly message', 'Too many' in pg.inner_text('#view'), pg.inner_text('#view')[:150])
        pg.goto(B); pg.wait_for_timeout(400)
        pg.click('.foot [data-feedback]'); pg.wait_for_selector('#fbView')
        pg.fill('#fbMsg', 'Test feedback message'); pg.click('#fbSend'); pg.wait_for_selector('#fbDone', timeout=5000)
        post = L()['formPosts'][-1]['body']
        check('web: feedback reaches form', post.get('entry.1002') == 'Test feedback message', post)
        pg.click('#fbDone'); pg.evaluate("go(()=>{throw new Error('render fail')})"); pg.wait_for_timeout(400)
        check('web: crash screen recovers', 'Something broke' in pg.inner_text('#view'))
        ctx.close()
        # Claude version: same source file, running with Claude's reader instead of the server
        mode('ok'); ctx, pg = page()
        ctx.add_init_script("""
          const store = {};
          window.claude = { use: async (n) => {
            if (n === 'sample') return { limits: async () => ({images:{maxCount:2}}),
              json: async (prompt, o) => { window.__claudeCalls = (window.__claudeCalls||0)+1; if (o.onText) o.onText({text:'{', delta:'{'});
                return {is_cannabis_label:true, product_type:'flower', product_name:'Claude Kush', cannabinoids:[{key:'THCa', value:22, unit:'%', sure:true}], terpenes:[]}; } };
            if (n === 'user') return { id: async () => 'u1' };
            if (n === 'db') return { collection: () => ({ doc: (id) => ({ get: async () => store[id] || null, set: async (v) => { store[id] = v; }, delete: async () => { delete store[id]; } }),
              list: async () => Object.entries(store).map(([id, data]) => ({id, data})), query: async () => [], onSnapshot: () => () => {} }) };
            return null; } };""")
        pg.route(B + '/claude', lambda r: r.fulfill(status=200, body=(ROOT / 'src/index.html').read_text(), content_type='text/html'))
        n0 = len(L()['gemini']); pg.goto(B + '/claude'); pg.wait_for_timeout(600)
        check('claude version: loads, no web-only extras shown', 'in the jar' in pg.inner_text('#view') and not pg.is_visible('.foot [data-feedback]') and not pg.evaluate('!!window.gtag'))
        scan(pg); pg.wait_for_selector('#goBtn', timeout=10000)
        check('claude version: reads through Claude, never the server', pg.input_value('#f-name') == 'Claude Kush' and pg.evaluate('window.__claudeCalls') == 1 and len(L()['gemini']) == n0)
        ctx.close(); b.close()
finally:
    srv.terminate()
real = [e for e in errs if 'render fail' not in e]
print('page errors:', real); print(sum(ok for _, ok in res), '/', len(res), 'passed')
