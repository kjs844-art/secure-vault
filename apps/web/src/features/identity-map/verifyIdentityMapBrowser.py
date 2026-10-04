"""Check synthetic identity navigation and vault locking in a fresh Chromium context."""

import argparse
import shutil
import subprocess
import functools
import hashlib
import json
import pathlib
import re
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser()
parser.add_argument("--dist", type=pathlib.Path, required=True)
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--chromium", type=pathlib.Path, default=pathlib.Path("/usr/lib/chromium/chromium"))
args = parser.parse_args()
root = pathlib.Path(__file__).resolve().parents[5]
evidence = args.output.resolve()
evidence.mkdir(parents=True, exist_ok=False)
assert (args.dist / "index.html").is_file(), "Build the production app first"
dist = evidence / "dist"
shutil.copytree(args.dist.resolve(), dist)
probe_module = (root / "apps/web/tests/mvp-browser/synthetic-idb-probe.mjs").as_uri()
probe = subprocess.check_output(["node", "--input-type=module", "-e",
    "import { probeSyntheticArchive } from " + json.dumps(probe_module)
    + '; process.stdout.write("(" + probeSyntheticArchive.toString() + ")");'], text=True)
head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
report = {'scope': 'owned synthetic Chromium checks; no real credentials or providers',
          'head': head, 'source': 'production build of current working tree', 'results': [], 'pageErrors': 0,
          'offOriginAttempts': 0, 'nonReadAttempts': 0, 'webSocketAttempts': 0, 'harnessErrors': 0, 'assets': {}}
private = ['.identity-map', '[data-testid^=\"identity-map-\"]', '[data-testid="relationship-catalog"]', '[data-testid="rotation-stage-panel"]',
           '[data-testid="registration-panel"]', '[data-testid="conflict-review"]',
           '[data-testid="local-tool-panel"]', '[data-testid="connection-editor"]',
           '[data-testid^="connection-edit-open-"]', '.relationship-list', '.issuer-context',
           '#local-catalog-query', '#local-catalog-filter', '#local-tool-query']

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(Handler, directory=str(dist)))
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
origin = 'http://127.0.0.1:' + str(server.server_port)
vault_url = origin + '/?view=local-vault'
backup_url = origin + '/?view=synthetic-backup'

def save():
    (evidence / 'vault-browser-check.json').write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')

def configure(context):
    def guard(route):
        if not route.request.url.startswith(origin + '/'):
            report['offOriginAttempts'] += 1
            route.abort()
        elif route.request.method not in ['GET', 'HEAD']:
            report['nonReadAttempts'] += 1
            route.abort()
        else:
            try:
                upstream = route.fetch()
                assert upstream.status == 200
                payload = upstream.body()
                relative = route.request.url[len(origin)+1:].split('?',1)[0]
                if relative.startswith('assets/'):
                    actual = dist / relative
                    assert actual.resolve().is_relative_to(dist.resolve()) and actual.is_file()
                    digest = hashlib.sha256(payload).hexdigest()
                    assert digest == hashlib.sha256(actual.read_bytes()).hexdigest()
                    report['assets'][relative] = {'bytes':len(payload),'sha256':digest}
                route.fulfill(response=upstream, body=payload)
                upstream.dispose()
            except Exception:
                report['harnessErrors'] += 1
                route.abort()
    context.route('**/*', guard)
    def websocket(socket):
        report['webSocketAttempts'] += 1
        socket.close()
    context.route_web_socket('**/*', websocket)
    def page_created(page):
        page.set_default_timeout(45000)
        page.on('pageerror', lambda _error: report.__setitem__('pageErrors', report['pageErrors'] + 1))
    context.on('page', page_created)

def status(page, prefix):
    page.wait_for_function('(prefix) => document.querySelector("[data-testid=\\"vault-status\\"]")?.textContent.startsWith(prefix)',
                           arg=prefix, timeout=45000)

def seed(page):
    page.goto(vault_url, wait_until='load')
    status(page, '잠김')
    assert page.locator('main.local-vault header .demo-warning strong').inner_text() == '실제 비밀번호·API 키 입력 금지.'
    page.get_by_role('button', name='합성 금고 만들기', exact=True).click()
    status(page, '열림')
    assert page.get_by_test_id('relationship-catalog').count() == 1

def snapshot(page, action='read'):
    return page.evaluate(probe, {'action': action, 'acknowledgement': 'keyatlas-m05a-synthetic-only'})

def removed(page):
    return page.evaluate('(selectors) => selectors.every(s => document.querySelectorAll(s).length === 0)', private)

def reopen(page):
    page.reload(wait_until='load')
    status(page, '잠김')
    page.get_by_role('button', name='저장된 합성 금고 열기', exact=True).click()
    status(page, '열림')

stage = 'prerequisite'
try:
    assert dist.is_dir()
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=str(args.chromium), headless=True)
        report['browser'] = browser.version
        for width in [1440, 360]:
            stage = 'standalone-' + str(width)
            context = browser.new_context(service_workers='block',accept_downloads=False,viewport={'width':width,'height':900})
            configure(context)
            try:
                page=context.new_page()
                page.goto(origin+'/',wait_until='load')
                page.get_by_role('link',name='계정 · 발급처 · 사용처 둘러보기 →',exact=True).click()
                page.get_by_test_id('identity-map-account').first.wait_for(state='visible')
                assert page.get_by_test_id('identity-map-account').count()==3
                assert page.get_by_test_id('identity-map-step-issuer').is_disabled()
                assert page.get_by_test_id('identity-map-step-usage').is_disabled()
                widths=[]
                def geometry():
                    value=page.evaluate('() => ({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
                    widths.append(value)
                    assert value['scroll'] <= value['client']
                def focused_heading(expected):
                    page.wait_for_function('(id) => document.activeElement?.id===id',arg=expected)
                geometry()
                page.get_by_test_id('identity-map-account').first.focus()
                page.keyboard.press('Enter')
                page.get_by_test_id('identity-map-issuer').first.wait_for(state='visible')
                focused_heading('identity-issuer-heading')
                assert page.get_by_test_id('identity-map-issuer').count()==2
                geometry()
                page.keyboard.press('Tab')
                assert page.evaluate("() => document.activeElement?.dataset.testid === 'identity-map-issuer'")
                page.keyboard.press('Enter')
                page.get_by_test_id('identity-map-usages').wait_for(state='visible')
                focused_heading('identity-usage-heading')
                assert page.get_by_test_id('identity-map-usages').locator('li').count()==2
                assert page.get_by_test_id('identity-map-step-usage').get_attribute('aria-current')=='step'
                geometry()
                page.screenshot(path=str(evidence/('identity-map-usage-'+str(width)+'.png')),full_page=True)
                page.keyboard.press('Escape')
                focused_heading('identity-issuer-heading')
                assert page.get_by_test_id('identity-map-issuer').count()==2
                page.keyboard.press('Escape')
                focused_heading('identity-account-heading')
                assert page.get_by_test_id('identity-map-step-issuer').is_disabled()
                page.get_by_test_id('identity-map-account').nth(2).click()
                page.get_by_test_id('identity-map-issuer').first.click()
                page.get_by_test_id('identity-map-no-usage').wait_for(state='visible')
                focused_heading('identity-usage-heading')
                geometry()
                page.get_by_test_id('identity-map-reset').click()
                focused_heading('identity-account-heading')
                assert page.get_by_test_id('identity-map-account').count()==3
                report['results'].append({'case':stage,'result':'PASS','checks':{'keyboardEnterTabAndEscape':True,'focusFollowsStep':True,'unknownAccountAndNoUsagePreserved':True,'resetAndDisabledBreadcrumbs':True,'widths':widths}})
            finally:
                context.close()
        stage='embedded-vault-lock-and-reopen'
        context=browser.new_context(service_workers='block',accept_downloads=False,viewport={'width':360,'height':900})
        configure(context)
        try:
            page=context.new_page()
            seed(page)
            before=snapshot(page)['archive']
            panel=page.locator('section.identity-map')
            assert panel.count()==1
            assert panel.get_by_role('heading', level=2).count()==1
            assert panel.get_by_role('heading', level=3, name='1. 계정', exact=True).count()==1
            assert panel.locator('h1').count()==0
            assert page.get_by_test_id('identity-map-account').count()>0
            page.get_by_test_id('identity-map-account').first.click()
            page.get_by_test_id('identity-map-issuer').first.click()
            page.wait_for_function("() => document.activeElement?.id==='identity-usage-heading'")
            assert panel.get_by_role('heading', level=3, name='3. 사용처', exact=True).count()==1
            lock_button=page.get_by_role('button',name='잠그기 / 작업 취소',exact=True)
            lock_button.focus()
            page.keyboard.press('Escape')
            assert page.get_by_test_id('identity-map-step-usage').get_attribute('aria-current')=='step'
            assert page.evaluate("() => document.activeElement?.textContent==='잠그기 / 작업 취소'")
            page.keyboard.press('Enter')
            status(page,'잠김')
            assert removed(page)
            assert snapshot(page)['archive']==before
            reopen(page)
            assert panel.count()==1
            assert page.get_by_test_id('identity-map-step-account').get_attribute('aria-current')=='step'
            assert page.get_by_test_id('identity-map-step-issuer').is_disabled()
            assert page.get_by_test_id('identity-map-step-usage').is_disabled()
            assert snapshot(page)['archive']==before
            geometry=page.evaluate('() => ({client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth})')
            assert geometry['scroll']<=geometry['client']
            page.screenshot(path=str(evidence/'identity-map-vault-360.png'),full_page=True)
            report['results'].append({'case':stage,'result':'PASS','checks':{'escapeOutsidePanelDoesNotNavigate':True,'lockRemovesPrivateDom':True,'archiveUnchanged':True,'explicitReopenResetsSelection':True,'noMobileOverflow':True,'embeddedHeadingHierarchy':True}})
        finally:
            context.close()
        browser.close()
    assert all(report[key]==0 for key in ['pageErrors','harnessErrors','offOriginAttempts','nonReadAttempts','webSocketAttempts'])
    report['result']='PASS'
except Exception as error:
    report['result']='FAIL'
    report['failure']={'stage':stage,'type':type(error).__name__,'message':str(error)[:600]}
finally:
    server.shutdown();server.server_close();thread.join();save()
print(json.dumps({'result':report['result'],'cases':len(report['results']),'failure':report.get('failure'),'pageErrors':report['pageErrors'],'harnessErrors':report['harnessErrors']},ensure_ascii=False))
raise SystemExit(0 if report['result']=='PASS' else 1)
