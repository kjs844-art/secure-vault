"""Exercise the production synthetic demo with an installed Chromium, no real data."""

import argparse
import hashlib
import json
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
    parser.add_argument("--output", type=Path, default=Path("/tmp/keyatlas-ka-c06-browser-checks"))
    parser.add_argument("--view", choices=("standalone", "integrated"), default="standalone")
    parser.add_argument("--timezone", choices=("Asia/Seoul", "UTC"), default="Asia/Seoul")
    args = parser.parse_args()
    entry = "signup-mail-discovery.html" if args.view == "standalone" else "index.html"
    if not (args.dist / entry).is_file():
        raise SystemExit("Build the selected production entry first")
    args.output.mkdir(parents=True, exist_ok=False)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(args.dist.resolve())))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    checks = []
    requests = []
    errors = []

    def passed(name):
        checks.append(name)

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=str(args.chromium), headless=True)
            context = browser.new_context(locale="ko-KR", timezone_id=args.timezone,
                                          service_workers="block", accept_downloads=False,
                                          viewport={"width": 1280, "height": 960})

            def restrict(route):
                request = route.request
                if not request.url.startswith(origin + "/") or request.method not in ("GET", "HEAD"):
                    errors.append("Unexpected origin or method")
                    route.abort()
                else:
                    try:
                        path = urlsplit(request.url).path
                        actual = (args.dist.resolve() / (unquote(path).lstrip("/") or "index.html")).resolve()
                        assert actual.is_relative_to(args.dist.resolve()) and actual.is_file()
                        response = route.fetch()
                        assert response.status == 200
                        payload = response.body()
                        assert hashlib.sha256(payload).digest() == hashlib.sha256(actual.read_bytes()).digest()
                        requests.append({"method": request.method, "path": path})
                        route.fulfill(response=response, body=payload)
                        response.dispose()
                    except Exception:
                        errors.append("Static response validation failed")
                        route.abort()

            context.route("**/*", restrict)
            context.route_web_socket("**/*", lambda socket: (errors.append("Unexpected WebSocket"), socket.close()))
            page = context.new_page()
            page.on("pageerror", lambda _error: errors.append("Uncaught page exception"))
            page.on("console", lambda message: errors.append("Browser console error") if message.type == "error" else None)
            page.on("response", lambda response: errors.append(f"HTTP {response.status}") if response.status >= 400 else None)
            page.clock.install()
            target = "/signup-mail-discovery.html" if args.view == "standalone" else "/?view=signup-mail-discovery"
            if args.view == "integrated":
                page.goto(origin + "/", wait_until="load")
                page.get_by_role("link", name="합성 메일 가입 흔적 탐색 →", exact=True).click()
            else:
                page.goto(origin + target, wait_until="load")

            expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색")).to_have_count(0)
            expect(page.get_by_role("heading", name="검토할 서비스 후보")).to_have_count(0)
            expect(page.get_by_text("실제 Gmail·메일 계정에 연결하지 않는 합성 체험 화면입니다.", exact=False)).to_be_visible()
            passed("initial page offers no premature confirmation/results and identifies synthetic mode")

            for label in ["Aurora 예제", "Cedar 예제", "Harbor 예제"]:
                page.get_by_label(label, exact=True).uncheck()
            expect(page.get_by_role("button", name="탐색 범위 미리보기")).to_be_disabled()
            page.get_by_label("Cedar 예제", exact=True).check()
            preview = page.get_by_role("button", name="탐색 범위 미리보기")
            preview.focus()
            page.keyboard.press("Enter")
            expect(page.get_by_role("heading", name="이 범위로 탐색할까요?")).to_be_visible()
            expect(page.get_by_role("heading", name="이 범위로 탐색할까요?")).to_be_focused()
            for label in ["Aurora 예제", "Cedar 예제", "Harbor 예제"]:
                expect(page.get_by_label(label, exact=True)).to_be_disabled()
            expect(page.get_by_role("combobox", name="예제 메일의 기간")).to_be_disabled()
            expect(page.get_by_text("메일 메타데이터 최대 50건")).to_be_visible()
            expect(page.get_by_text("2026. 08. 31.", exact=False)).to_be_visible()
            expect(page.get_by_text("기간 (한국시간)", exact=True)).to_be_visible()
            expect(page.locator(".signup-mail-card")).to_contain_text("21:00")
            expect(page.get_by_role("heading", name="검토할 서비스 후보")).to_have_count(0)
            passed("keyboard preview binds selected service, exact period and metadata budget")

            page.get_by_role("button", name="탐색 취소", exact=True).click()
            expect(page.get_by_text("탐색을 취소하고 후보를 지웠습니다.")).to_be_visible()
            expect(page.get_by_text("탐색을 취소하고 후보를 지웠습니다.")).to_be_focused()
            expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색")).to_have_count(0)
            passed("cancel before confirmation reads no messages and clears consent")

            page.get_by_role("button", name="범위 다시 선택", exact=True).click()
            expect(page.get_by_text("확인할 합성 서비스", exact=True)).to_be_focused()
            page.get_by_role("button", name="탐색 범위 미리보기").click()
            page.get_by_role("button", name="선택한 범위에 동의하고 탐색").click()
            expect(page.get_by_role("heading", name="검토할 서비스 후보")).to_be_visible()
            expect(page.get_by_role("heading", name="검토할 서비스 후보")).to_be_focused()
            expect(page.get_by_text("메타데이터 6건에서 후보 1개를 찾았습니다.")).to_be_visible()
            expect(page.locator(".signup-mail-results li")).to_have_count(1)
            expect(page.locator(".signup-mail-results")).to_contain_text("Cedar 예제")
            expect(page.locator(".signup-mail-results")).not_to_contain_text("Aurora 예제")
            expect(page.locator(".signup-mail-results")).to_contain_text("확인 필요")
            passed("explicit confirmation produces only the selected service as a review candidate")

            page.get_by_role("button", name="확인됨으로 표시").click()
            expect(page.locator(".signup-mail-results")).to_contain_text("직접 확인함")
            page.get_by_role("button", name="오탐으로 표시").click()
            expect(page.locator(".signup-mail-results")).to_contain_text("오탐")
            page.get_by_role("button", name="다시 검토", exact=True).click()
            expect(page.locator(".signup-mail-results")).to_contain_text("확인 필요")
            passed("user can confirm, dismiss and reopen false-positive review")

            text = page.locator("body").inner_text()
            assert not any(value in text for value in ["synthetic-only-private-canary", "Welcome to Aurora", "accounts.aurora.invalid"])
            assert page.evaluate("localStorage.length") == 0
            assert page.evaluate("sessionStorage.length") == 0
            assert page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
            passed("rendered results contain no raw subject/domain and create no browser storage")

            page.screenshot(path=str(args.output / "desktop-review.png"), full_page=True)
            page.set_viewport_size({"width": 360, "height": 800})
            assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
            page.screenshot(path=str(args.output / "mobile-review.png"), full_page=True)
            passed("360-pixel mobile review has no horizontal overflow")

            page.get_by_role("button", name="확인됨으로 표시", exact=True).focus()
            page.clock.fast_forward(300_001)
            expect(page.get_by_text("확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.")).to_be_visible()
            expect(page.get_by_text("확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.")).to_be_focused()
            expect(page.locator(".signup-mail-results li")).to_have_count(0)
            reset_button = page.get_by_role("button", name="범위 다시 선택", exact=True)
            reset_button.focus()
            page.clock.fast_forward(2_000)
            expect(reset_button).to_be_focused()
            passed("five-minute expiry removes candidates and restores only disappearing focus")

            reset_button.click()
            page.get_by_role("button", name="탐색 범위 미리보기").click()
            page.get_by_role("button", name="선택한 범위에 동의하고 탐색").click()
            reset_button.focus()
            page.clock.fast_forward(300_001)
            expect(page.get_by_text("확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.")).to_be_visible()
            expect(reset_button).to_be_focused()
            expect(page.locator(".signup-mail-results li")).to_have_count(0)
            passed("expiry preserves focus on a control that remains available")

            reset_button.click()
            page.get_by_role("button", name="탐색 범위 미리보기").click()
            page.get_by_role("button", name="선택한 범위에 동의하고 탐색").focus()
            page.clock.fast_forward(300_001)
            expect(page.get_by_text("확인 시간이 만료되어 후보를 지웠습니다. 범위를 다시 선택해 주세요.")).to_be_focused()
            expect(page.get_by_role("button", name="선택한 범위에 동의하고 탐색")).to_have_count(0)
            passed("unconfirmed preview expiry removes confirmation and restores focus to the notice")

            page.get_by_role("button", name="범위 다시 선택", exact=True).click()
            page.get_by_role("button", name="탐색 범위 미리보기").click()
            page.get_by_role("button", name="선택한 범위에 동의하고 탐색").click()
            page.get_by_role("button", name="후보 지우기", exact=True).click()
            expect(page.locator(".signup-mail-results li")).to_have_count(0)
            passed("clear-results action removes review controls and owned candidates")

            assert not errors, errors
            assert requests and all(item["method"] == "GET" for item in requests)
            assert all(item["path"] == ("/signup-mail-discovery.html" if args.view == "standalone" else "/")
                       or item["path"].startswith("/assets/") for item in requests)
            passed("only same-origin static GETs occur; no API, upload, console or CSP errors")
            report = {"checks": checks, "passed": len(checks), "browser": browser.version, "view": args.view,
                      "timezone": args.timezone, "requests": requests, "errors": errors}
            (args.output / "results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
            print(f"Browser checks: {len(checks)} passed; errors: 0")
            context.close()
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
