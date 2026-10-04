"""Synthetic production navigation QA using an installed, isolated Chromium."""

import argparse
import hashlib
import json
import shutil
import subprocess
import threading
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.sync_api import expect, sync_playwright


VIEWS = {
    "overview": ("/", "합성 목록"),
    "local-vault": ("/?view=local-vault", "로컬 합성 금고"),
    "synthetic-backup": ("/?view=synthetic-backup", "합성 백업·복원"),
    "identity-map": ("/?view=identity-map", "계정·연결 관계"),
    "discovery-inbox": ("/?view=discovery-inbox", "가입 흔적 검토"),
    "signup-mail-discovery": ("/?view=signup-mail-discovery", "합성 메일 탐색"),
}


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
    repo = Path(__file__).resolve().parents[4]
    module = (repo / "apps/web/tests/mvp-browser/synthetic-idb-probe.mjs").as_uri()
    probe = subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import { probeSyntheticArchive } from " + json.dumps(module)
        + '; process.stdout.write("(" + probeSyntheticArchive.toString() + ")");',
    ], text=True)
    report = {"scope": "synthetic static production app; fresh owned context",
              "checks": [], "errors": [], "assets": {}, "result": "FAIL"}
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(dist)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    origin = f"http://127.0.0.1:{server.server_port}"
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
                path = urlsplit(request.url).path
                relative = unquote(path).lstrip("/") or "index.html"
                actual = (dist / relative).resolve()
                assert actual.is_relative_to(dist.resolve()) and actual.is_file()
                response = route.fetch()
                payload = response.body()
                assert response.status == 200
                digest = hashlib.sha256(payload).hexdigest()
                assert digest == hashlib.sha256(actual.read_bytes()).hexdigest()
                report["assets"][relative] = {"bytes": len(payload), "sha256": digest}
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

        def page_created(page):
            page.set_default_timeout(45_000)
            page.on("pageerror", lambda _error: report["errors"].append("QA_PAGE_ERROR"))
            page.on("console", lambda message: report["errors"].append("QA_CONSOLE_ERROR")
                    if message.type == "error" else None)

        context.on("page", page_created)

    def snapshot(page):
        return page.evaluate(probe, {"action": "read", "acknowledgement": "keyatlas-m05a-synthetic-only"})["archive"]

    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=str(args.chromium), headless=True)
            report["browser"] = browser.version
            for width in (1280, 360, 320):
                context = browser.new_context(viewport={"width": width, "height": 900},
                                              locale="ko-KR", service_workers="block", accept_downloads=False)
                configure(context)
                try:
                    page = context.new_page()
                    for view, (path, label) in VIEWS.items():
                        stage = f"shell-{view}-{width}"
                        page.goto(origin + path, wait_until="load")
                        report["last_observation"] = {
                            "view": view, "width": width, "title": page.title(),
                            "main_count": page.get_by_role("main").count(),
                            "skip_count": page.get_by_role("link", name="본문으로 바로가기", exact=True).count(),
                        }
                        expect(page).to_have_title(f"{label} | KeyAtlas 합성 체험")
                        expect(page.get_by_role("main")).to_have_count(1)
                        expect(page.get_by_role("heading", level=1)).to_have_count(1)
                        assert page.locator("main main").count() == 0
                        nav = page.get_by_role("navigation", name="합성 체험 화면", exact=True)
                        expect(nav).to_have_count(1)
                        expect(nav.get_by_role("link")).to_have_count(len(VIEWS))
                        expect(nav.locator('[aria-current="page"]')).to_have_count(1)
                        expect(nav.get_by_role("link", name=label, exact=True)).to_have_attribute("aria-current", "page")
                        assert set(nav.get_by_role("link").evaluate_all("links => links.map(link => link.getAttribute('href'))")) == {
                            value[0] for value in VIEWS.values()}
                        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
                        sizes = nav.get_by_role("link").evaluate_all("links => links.map(link => { const rect = link.getBoundingClientRect(); return [rect.width, rect.height]; })")
                        assert all(w >= 44 and h >= 44 for w, h in sizes)
                        assert page.evaluate("document.activeElement === document.body")
                        page.keyboard.press("Tab")
                        skip = page.get_by_role("link", name="본문으로 바로가기", exact=True)
                        expect(skip).to_be_focused()
                        assert skip.bounding_box()["y"] >= 0
                        page.keyboard.press("Enter")
                        target = page.locator("#main-content")
                        expect(target).to_be_focused()
                        page.keyboard.press("Tab")
                        assert page.evaluate("document.querySelector('#main-content').contains(document.activeElement)")
                        passed(stage, main_landmarks=1, current_page_links=1,
                               first_tab_skip=True, next_tab_in_content=True, minimum_nav_target_px=44)
                    assert page.evaluate("localStorage.length") == 0
                    assert page.evaluate("sessionStorage.length") == 0
                    assert page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
                    assert context.cookies() == []
                    passed(f"no-persistent-view-state-{width}")
                finally:
                    context.close()

            context = browser.new_context(service_workers="block", accept_downloads=False)
            configure(context)
            try:
                page = context.new_page()
                stage = "unknown-view-fallback"
                page.goto(origin + "/?view=unrecognized", wait_until="load")
                expect(page).to_have_title("합성 목록 | KeyAtlas 합성 체험")
                expect(page.get_by_role("navigation", name="합성 체험 화면").get_by_role("link", name="합성 목록", exact=True)).to_have_attribute("aria-current", "page")
                passed(stage)

                stage = "vault-shell-navigation-locks-and-preserves-ciphertext"
                page.goto(origin + VIEWS["local-vault"][0], wait_until="load")
                page.get_by_role("button", name="합성 금고 만들기", exact=True).click()
                expect(page.get_by_test_id("vault-status")).to_contain_text("열림", timeout=45_000)
                before = snapshot(page)
                page.get_by_role("navigation", name="합성 체험 화면").get_by_role("link", name="계정·연결 관계", exact=True).click()
                expect(page).to_have_title("계정·연결 관계 | KeyAtlas 합성 체험")
                assert snapshot(page) == before
                page.go_back(wait_until="load")
                expect(page.get_by_test_id("vault-status")).to_contain_text("잠김")
                expect(page.get_by_test_id("relationship-catalog")).to_have_count(0)
                expect(page.locator(".identity-map")).to_have_count(0)
                assert snapshot(page) == before
                page.get_by_role("button", name="저장된 합성 금고 열기", exact=True).click()
                expect(page.get_by_test_id("vault-status")).to_contain_text("열림", timeout=45_000)
                assert snapshot(page) == before
                passed(stage, explicit_reopen_required=True, archive_hash_unchanged=True,
                       bfcache_and_os_sleep_not_claimed=True)

                stage = "mail-shell-navigation-clears-owned-candidates"
                page.get_by_role("navigation", name="합성 체험 화면").get_by_role("link", name="합성 메일 탐색", exact=True).click()
                page.get_by_role("button", name="탐색 범위 미리보기", exact=True).click()
                page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True).click()
                # The three-service fixture has two in-range signup candidates;
                # Harbor's reset mail and old signup are deliberately excluded.
                expect(page.locator(".signup-mail-results li")).to_have_count(2)
                expect(page.locator(".signup-mail-results li").nth(0)).to_contain_text("Aurora 예제")
                expect(page.locator(".signup-mail-results li").nth(1)).to_contain_text("Cedar 예제")
                expect(page.locator(".signup-mail-results")).not_to_contain_text("Harbor 예제")
                page.get_by_role("navigation", name="합성 체험 화면").get_by_role("link", name="가입 흔적 검토", exact=True).click()
                expect(page.locator(".signup-mail-results li")).to_have_count(0)
                page.go_back(wait_until="load")
                expect(page.get_by_role("button", name="탐색 범위 미리보기", exact=True)).to_be_visible()
                expect(page.locator(".signup-mail-results li")).to_have_count(0)
                expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색", exact=True)).to_have_count(0)
                assert snapshot(page) == before
                passed(stage, no_cross_view_handoff=True, archive_hash_unchanged=True)
            finally:
                context.close()
                browser.close()
        assert not report["errors"], "QA_BROWSER_ERRORS"
        report["result"] = "PASS"
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
