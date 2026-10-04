"""Verify the real synthetic inbox and source replacement with installed tools."""

import argparse
import hashlib
import json
import shutil
import subprocess
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import expect, sync_playwright


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--chromium", type=Path, default=Path("/usr/lib/chromium/chromium"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    app = Path(__file__).resolve().parents[3]
    if not (args.dist / "index.html").is_file():
        raise SystemExit("Build apps/web production output first")
    args.output.mkdir(parents=True, exist_ok=False)
    output = args.output.resolve()
    dist = output / "production"
    shutil.copytree(args.dist, dist)
    generated = output / "source-probe"
    generated.mkdir()
    (generated / "index.html").write_text(
        '<!doctype html><html lang="ko"><meta charset="utf-8">'
        '<div id="root"></div><script type="module" src="./probe.tsx"></script></html>',
        encoding="utf-8",
    )
    panel = json.dumps(str(app / "src/features/discovery-inbox/DiscoveryInboxPanel.tsx"))
    fixture = json.dumps(str(app / "src/features/discovery-inbox/syntheticDiscoveryInboxFixture.ts"))
    (generated / "probe.tsx").write_text(
        'import { useState } from "react";\n'
        'import { createRoot } from "react-dom/client";\n'
        f'import {{ DiscoveryInboxPanel }} from {panel};\n'
        f'import {{ SYNTHETIC_DISCOVERY_INBOX_ITEMS as original }} from {fixture};\n'
        'const replacement = Object.freeze([Object.freeze({ ...original[0], '
        'serviceName:"Example replacement source", confidence:"needs_review" as const })]);\n'
        'function Probe() { const [changed,setChanged] = useState(false); return <>'
        '<button data-testid="replace-source" onClick={() => setChanged(v=>!v)}>예시 바꾸기</button>'
        '<DiscoveryInboxPanel items={changed ? replacement : original} /></>; }\n'
        'createRoot(document.getElementById("root")!).render(<Probe />);\n',
        encoding="utf-8",
    )
    probe_dist = output / "probe-build"
    build_script = output / "build-probe.mjs"
    build_script.write_text(
        f'import {{ build }} from {json.dumps((app / "node_modules/vite/dist/node/index.js").as_uri())};\n'
        f'await build({{configFile:false,root:{json.dumps(str(generated))},publicDir:false,base:"/probe/",'
        'resolve:{alias:{'
        f'"react-dom":{json.dumps(str(app / "node_modules/react-dom"))},'
        f'react:{json.dumps(str(app / "node_modules/react"))}'
        '}},esbuild:{jsx:"automatic"},'
        f'build:{{outDir:{json.dumps(str(probe_dist))},emptyOutDir:false}}}});\n',
        encoding="utf-8",
    )
    with (output / "probe-build.log").open("w") as log:
        build = subprocess.run(["node", str(build_script)], cwd=app, stdout=log, stderr=subprocess.STDOUT)
    if build.returncode:
        (output / "results.json").write_text(json.dumps({"result": "FAIL", "stage": "probe-build",
                                                          "buildExit": build.returncode, "checks": []}) + "\n")
        raise SystemExit(f"Source probe build failed (exit {build.returncode}); see owned probe-build.log")
    shutil.copytree(probe_dist, dist / "probe")
    manifest = {
        str(path.relative_to(dist)): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(dist.rglob("*")) if path.is_file()
    }
    report = {"result": "RUNNING", "scope": "synthetic production inbox and actual React source replacement",
              "checks": [], "errors": [], "assets": {}, "buildExit": build.returncode, "manifest": manifest}
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(dist)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"

    def configure(context):
        def restrict(route):
            request = route.request
            if not request.url.startswith(origin + "/") or request.method not in ("GET", "HEAD"):
                report["errors"].append("Unexpected origin or method")
                route.abort()
                return
            try:
                response = route.fetch()
                relative = unquote(urlsplit(request.url).path).lstrip("/") or "index.html"
                actual = (dist / relative).resolve()
                assert actual.is_relative_to(dist.resolve()) and actual.is_file()
                assert response.status == 200
                body = response.body()
                digest = hashlib.sha256(body).hexdigest()
                assert digest == manifest[str(actual.relative_to(dist))]
                report["assets"][str(actual.relative_to(dist))] = digest
                route.fulfill(response=response, body=body)
                response.dispose()
            except Exception:
                report["errors"].append("Static response validation failed")
                route.abort()

        context.route("**/*", restrict)
        context.route_web_socket("**/*", lambda socket: (
            report["errors"].append("Unexpected WebSocket"), socket.close()))
        context.on("page", lambda page: page.on("pageerror", lambda _error:
                   report["errors"].append("Uncaught page error")))

    def row(page, name):
        return page.get_by_test_id("discovery-inbox-item").filter(has=page.get_by_role("heading", name=name, exact=True))

    def filter_is(page, value, count):
        expect(page.get_by_test_id("discovery-filter-" + value)).to_have_attribute("aria-pressed", "true")
        expect(page.get_by_test_id("discovery-inbox-item")).to_have_count(count)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=str(args.chromium), headless=True)
            report["browser"] = browser.version
            try:
                for width in (1440, 360):
                    context = browser.new_context(service_workers="block", accept_downloads=False,
                                                  viewport={"width": width, "height": 960}, locale="ko-KR")
                    configure(context)
                    try:
                        page = context.new_page()
                        page.goto(origin + "/", wait_until="load")
                        page.get_by_role("link", name="가입 흔적 검토 연습 →", exact=True).click()
                        filter_is(page, "open", 4)
                        expect(page.get_by_text("실제 가입·계정 소유를 인증하지 않습니다", exact=False)).to_be_visible()
                        for value, count in (("confirmed", 1), ("inferred", 1), ("needs_review", 2), ("dismissed", 0)):
                            page.get_by_test_id("discovery-filter-" + value).click()
                            filter_is(page, value, count)
                        page.get_by_test_id("discovery-filter-open").click()
                        card = row(page, "Example Shop Newsletter")
                        card.get_by_test_id("discovery-action-dismissed").focus()
                        page.keyboard.press("Enter")
                        filter_is(page, "open", 3)
                        expect(page.get_by_test_id("discovery-inbox-status")).to_be_focused()
                        page.get_by_test_id("discovery-filter-dismissed").click()
                        filter_is(page, "dismissed", 1)
                        row(page, "Example Shop Newsletter").get_by_test_id("discovery-action-needs_review").click()
                        filter_is(page, "dismissed", 0)
                        expect(page.get_by_test_id("discovery-inbox-status")).to_be_focused()
                        page.get_by_test_id("discovery-filter-needs_review").click()
                        filter_is(page, "needs_review", 2)
                        row(page, "Example Notes Board").get_by_test_id("discovery-action-confirmed").click()
                        filter_is(page, "needs_review", 1)
                        page.get_by_test_id("discovery-filter-confirmed").click()
                        filter_is(page, "confirmed", 2)
                        page.get_by_test_id("discovery-filter-open").click()
                        row(page, "Example Cloud Lab").get_by_test_id("discovery-action-needs_review").click()
                        expect(row(page, "Example Cloud Lab").get_by_role("heading")).to_be_focused()
                        assert page.evaluate("() => document.documentElement.scrollWidth <= document.documentElement.clientWidth")
                        page.screenshot(path=str(output / f"inbox-review-{width}.png"), full_page=True)
                        page.reload(wait_until="load")
                        filter_is(page, "open", 4)
                        expect(page.get_by_test_id("discovery-filter-confirmed")).to_have_text("확인됨 1")
                        expect(page.get_by_test_id("discovery-filter-dismissed")).to_have_text("오탐 0")
                        report["checks"].append(f"production {width}px filters, review/undo, keyboard focus, reload and overflow")
                    finally:
                        context.close()
                context = browser.new_context(service_workers="block", accept_downloads=False)
                configure(context)
                try:
                    page = context.new_page()
                    page.goto(origin + "/probe/index.html", wait_until="load")
                    row(page, "Example AI Workshop").get_by_test_id("discovery-action-dismissed").click()
                    page.get_by_test_id("discovery-filter-dismissed").click()
                    filter_is(page, "dismissed", 1)
                    page.get_by_test_id("replace-source").click()
                    filter_is(page, "open", 1)
                    expect(page.get_by_test_id("discovery-filter-dismissed")).to_have_text("오탐 0")
                    expect(row(page, "Example replacement source")).to_be_visible()
                    row(page, "Example replacement source").get_by_test_id("discovery-action-confirmed").click()
                    page.get_by_test_id("discovery-filter-confirmed").click()
                    filter_is(page, "confirmed", 1)
                    page.get_by_test_id("replace-source").click()
                    filter_is(page, "open", 4)
                    expect(page.get_by_test_id("discovery-filter-confirmed")).to_have_text("확인됨 1")
                    report["checks"].append("source replacement with reused ID clears old filter/review and uses new source")
                finally:
                    context.close()
            finally:
                browser.close()
        assert not report["errors"]
        report["result"] = "PASS"
    except Exception as error:
        report["result"] = "FAIL"
        report["failureType"] = type(error).__name__
        raise
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        (output / "results.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(json.dumps({"result": report["result"], "checks": len(report["checks"]), "errors": report["errors"]}))


if __name__ == "__main__":
    main()
