"""Native bfcache and synthetic pagehide QA; fixture mail only, no new tooling."""

import argparse
import hashlib
import json
import shutil
import threading
import traceback
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
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chromium", type=Path, default=Path("/usr/lib/chromium/chromium"))
    args = parser.parse_args()
    assert (args.dist / "index.html").is_file(), "QA_BUILD_REQUIRED"
    args.output.mkdir(parents=True, exist_ok=False)
    dist = args.output / "dist"
    shutil.copytree(args.dist.resolve(), dist)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(dist)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
    report = {"scope": "fresh synthetic Chromium context; no user profile/mail/providers",
              "checks": [], "errors": [], "assets": {}, "result": "FAIL",
              "browser_default_override": "remove --disable-back-forward-cache only"}
    stage = "prerequisite"

    def passed(name, **details):
        report["checks"].append({"case": name, "result": "PASS", **details})

    def configure(context):
        def restrict(route):
            request = route.request
            if not request.url.startswith(origin + "/") or request.method != "GET":
                report["errors"].append("QA_UNEXPECTED_REQUEST")
                route.abort()
                return
            response = None
            try:
                path = unquote(urlsplit(request.url).path).lstrip("/") or "index.html"
                actual = (dist / path).resolve()
                assert actual.is_relative_to(dist.resolve()) and actual.is_file()
                response = route.fetch()
                payload = response.body()
                digest = hashlib.sha256(payload).hexdigest()
                assert response.status == 200 and digest == hashlib.sha256(actual.read_bytes()).hexdigest()
                report["assets"][path] = {"bytes": len(payload), "sha256": digest}
                route.fulfill(response=response, body=payload)
            except Exception:
                report["errors"].append("QA_STATIC_RESPONSE_MISMATCH")
                route.abort()
            finally:
                if response is not None:
                    response.dispose()

        context.route("**/*", restrict)
        context.route_web_socket("**/*", lambda socket: (
            report["errors"].append("QA_UNEXPECTED_WEBSOCKET"), socket.close()))
        context.add_init_script("""window.__ownedPageShowPersisted = null;
          addEventListener('pageshow', event => { window.__ownedPageShowPersisted = event.persisted; });""")

    def scan(page):
        page.get_by_role("button", name="탐색 범위 미리보기", exact=True).click()
        page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True).click()
        expect(page.locator(".signup-mail-results li")).to_have_count(2)
        expect(page.locator(".signup-mail-results")).not_to_contain_text("Harbor 예제")

    def cleared(page):
        expect(page.locator(".signup-mail-results li")).to_have_count(0)
        expect(page.get_by_role("heading", name="검토할 서비스 후보", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="탐색 범위 미리보기", exact=True)).to_be_visible()
        for service in ("Aurora 예제", "Cedar 예제", "Harbor 예제"):
            expect(page.get_by_label(service, exact=True)).to_be_enabled()

    try:
        with sync_playwright() as playwright:
            # Playwright disables bfcache by default. Re-enable only this feature
            # on the owned browser; request guards and ordinary browser security stay.
            browser = playwright.chromium.launch(executable_path=str(args.chromium), headless=True,
                                                ignore_default_args=["--disable-back-forward-cache"])
            report["browser"] = browser.version
            context = browser.new_context(service_workers="block", accept_downloads=False, locale="ko-KR")
            configure(context)
            try:
                page = context.new_page()
                page.set_default_timeout(15_000)
                page.on("pageerror", lambda _error: report["errors"].append("QA_PAGE_ERROR"))
                page.on("console", lambda message: report["errors"].append("QA_CONSOLE_ERROR")
                        if message.type == "error" else None)
                stage = "native-bfcache-review-return"
                page.goto(origin + "/?view=signup-mail-discovery", wait_until="load")
                scan(page)
                page.get_by_role("navigation", name="합성 체험 화면").get_by_role("link", name="합성 목록", exact=True).click()
                expect(page).to_have_title("합성 목록 | KeyAtlas 합성 체험")
                # A restored bfcache document emits pageshow, not a fresh load.
                page.evaluate("history.back()")
                page.wait_for_function("location.search === '?view=signup-mail-discovery' && document.querySelector('.signup-mail-panel') !== null")
                persisted = page.evaluate("window.__ownedPageShowPersisted")
                report["native_bfcache_persisted"] = persisted
                assert persisted is True, "QA_BFCACHE_NOT_ACTIVATED"
                cleared(page)
                passed(stage, actual_pageshow_persisted=True, candidate_count=0)

                stage = "cached-return-requires-fresh-explicit-confirmation"
                page.get_by_role("button", name="탐색 범위 미리보기", exact=True).click()
                expect(page.locator(".signup-mail-results li")).to_have_count(0)
                expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True)).to_be_visible()
                page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True).click()
                expect(page.locator(".signup-mail-results li")).to_have_count(2)
                passed(stage)

                stage = "scripted-persisted-pagehide-review"
                page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}))")
                cleared(page)
                assert page.evaluate("document.activeElement?.tagName") == "BODY"
                # Explicitly scripted coverage, separate from the native case.
                passed(stage, scripted_event=True, focus_not_moved_to_a_heading=True)

                stage = "scripted-pagehide-clears-unconfirmed-preview"
                page.get_by_role("button", name="탐색 범위 미리보기", exact=True).click()
                expect(page.get_by_role("heading", name="이 범위로 탐색할까요?", exact=True)).to_be_visible()
                page.evaluate("dispatchEvent(new PageTransitionEvent('pagehide', {persisted: false}))")
                cleared(page)
                passed(stage, scripted_event=True)

                assert page.evaluate("localStorage.length") == 0
                assert page.evaluate("sessionStorage.length") == 0
                assert page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
                assert context.cookies() == []
                assert not report["errors"], "QA_BROWSER_ERRORS"
                passed("no-browser-storage-cookie-external-request-or-errors")
                report["result"] = "PASS"
            finally:
                context.close()
                browser.close()
    except Exception as error:
        report["failed_stage"] = stage
        report["failure_type"] = type(error).__name__
        report["failure_line"] = [frame.lineno for frame in traceback.extract_tb(error.__traceback__)
                                  if frame.filename == __file__]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        report["passed"] = len(report["checks"])
        (args.output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({key: report[key] for key in ("result", "passed", "errors")}, ensure_ascii=False))
    raise SystemExit(0 if report["result"] == "PASS" else 1)


if __name__ == "__main__":
    main()
