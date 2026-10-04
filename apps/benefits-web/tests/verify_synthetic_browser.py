"""Chromium hydration/interaction QA for an already running owned synthetic SSR app.

No browser dependency is added to the app. Use the installed Python Playwright.
Only the loopback SSR preview and its actual built assets are read.
"""

import argparse
import asyncio
import hashlib
import json
import traceback
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.async_api import async_playwright, expect


async def run(args):
    report = {"checks": [], "errors": [], "static_assets": {}, "get_paths": [], "browser": None,
              "response_statuses": []}
    origin = args.base_url.rstrip("/")
    public = args.public.resolve()

    def passed(name):
        report["checks"].append(name)
        print(json.dumps({"case": name, "result": "PASS"}), flush=True)

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=str(args.chromium), headless=True)
        report["browser"] = browser.version
        context = await browser.new_context(locale="ko-KR", timezone_id="UTC",
                                            service_workers="block", accept_downloads=False,
                                            viewport={"width": 1440, "height": 900})
        try:
            async def guard(route):
                request = route.request
                if not request.url.startswith(origin + "/") or request.method != "GET":
                    report["errors"].append("UNEXPECTED_ORIGIN_OR_METHOD")
                    await route.abort()
                    return
                path = urlsplit(request.url).path
                # Record path only. Framework query/request IDs are excluded.
                report["get_paths"].append(path)
                if path.startswith("/_serverFn/"):
                    # Preserve the browser's Fetch Metadata. APIRequestContext
                    # route.fetch is not the same transport as a browser request.
                    await route.continue_()
                    return
                try:
                    response = await route.fetch()
                    report["response_statuses"].append({"path": path, "status": response.status})
                    assert response.status == 200
                    payload = await response.body()
                    if path.startswith("/assets/"):
                        actual = (public / unquote(path).lstrip("/")).resolve()
                        assert actual.is_relative_to(public) and actual.is_file()
                        digest = hashlib.sha256(payload).hexdigest()
                        assert digest == hashlib.sha256(actual.read_bytes()).hexdigest()
                        report["static_assets"][path] = {"bytes": len(payload), "sha256": digest}
                    await route.fulfill(response=response, body=payload)
                    await response.dispose()
                except Exception:
                    report["errors"].append("RESPONSE_CHECK_FAILED")
                    await route.abort()

            await context.route("**/*", guard)

            async def socket_guard(socket):
                report["errors"].append("UNEXPECTED_WEBSOCKET")
                await socket.close()

            await context.route_web_socket("**/*", socket_guard)
            page = await context.new_page()
            page.on("pageerror", lambda _error: report["errors"].append("PAGE_EXCEPTION"))
            page.on("console", lambda m: report["errors"].append("CONSOLE_ERROR") if m.type == "error" else None)
            await page.goto(origin + "/", wait_until="load")
            await expect(page.get_by_role("heading", level=1, name="계정과 서비스 정보를 한곳으로")).to_be_visible()
            await expect(page.get_by_role("status")).to_contain_text("실제 비밀번호·API 키·메일을 입력하지 마세요")
            assert await page.locator("html").get_attribute("lang") == "ko"
            await page.get_by_role("link", name="합성 데모 둘러보기", exact=True).click()
            await expect(page.get_by_role("heading", name="서비스와 혜택을 한곳에서 살펴보세요", exact=True)).to_be_visible()
            await expect(page.locator("article[aria-labelledby]")).to_have_count(6)
            await expect(page.get_by_role("heading", name="지난 프로모션 크레딧", exact=True)).to_have_count(0)
            await expect(page.get_by_role("button", name="현재·확인 필요 보기", exact=True)).to_have_attribute("aria-pressed", "true")
            passed("landing-to-hydrated-demo-preserves-synthetic-and-default-history-boundaries")

            await page.get_by_role("button", name="지난 기록 보기", exact=True).click()
            await expect(page.get_by_role("button", name="지난 기록 보기", exact=True)).to_have_attribute("aria-pressed", "true")
            await expect(page.locator("article[aria-labelledby]")).to_have_count(2)
            await expect(page.get_by_role("heading", name="지난 프로모션 크레딧", exact=True)).to_be_visible()
            await expect(page.get_by_role("meter")).to_have_count(0)
            report["history_status_role_count"] = await page.get_by_role("status").count()
            history_status = page.locator('.history-filter + p[role="status"]')
            await expect(history_status).to_have_count(1)
            await expect(history_status).to_contain_text("기록은 삭제하지")
            passed("opt-in-history-renders-two-records-without-spendable-meters")

            await page.get_by_role("button", name="현재·확인 필요 보기", exact=True).click()
            await expect(page.locator("article[aria-labelledby]")).to_have_count(6)
            await expect(page.get_by_role("heading", name="지난 프로모션 크레딧", exact=True)).to_have_count(0)
            await expect(page.locator("#demo-services")).to_contain_text("모름")
            await expect(page.locator("#demo-services")).to_contain_text("현재 잔액을 조회한 값이 아닙니다")
            passed("return-to-current-view-keeps-unknown-and-observation-date-meaning")

            buttons = page.locator('button[id^="demo-svc-"]')
            assert await buttons.count() == 4
            await buttons.first.focus()
            await page.keyboard.press("ArrowDown")
            await expect(buttons.nth(1)).to_be_focused()
            await expect(buttons.nth(1)).to_have_attribute("aria-pressed", "true")
            await page.keyboard.press("ArrowUp")
            await expect(buttons.first).to_be_focused()
            await page.keyboard.press("ArrowUp")
            await expect(buttons.last).to_be_focused()
            await page.get_by_role("button", name="해당 서비스 보기", exact=True).first.click()
            assert await page.locator('button[id^="demo-svc-"]:focus').count() == 1
            await page.get_by_role("link", name="서비스 목록으로 건너뛰기", exact=True).click()
            await expect(page.locator("#demo-services")).to_be_focused()
            passed("hydrated-keyboard-arrows-attention-action-and-skip-link")

            await page.screenshot(path=str(args.output / "demo-desktop.png"), full_page=True)
            await page.set_viewport_size({"width": 360, "height": 800})
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            sizes = await page.locator("main button").evaluate_all("""elements => elements.map(element => {
              const box = element.getBoundingClientRect();
              return {width: Math.round(box.width * 100) / 100, height: Math.round(box.height * 100) / 100};
            })""")
            report["mobile_button_sizes"] = sizes
            assert sizes and all(size["width"] >= 44 and size["height"] >= 44 for size in sizes)
            await page.screenshot(path=str(args.output / "demo-mobile.png"), full_page=True)
            await page.get_by_role("button", name="지난 기록 보기", exact=True).click()
            assert await page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            passed("360-pixel-current-and-history-views-have-no-horizontal-overflow-and-current-buttons-have-44-pixel-targets")

            async with page.expect_response(lambda response: urlsplit(response.url).path.startswith("/_serverFn/")) as pending_status:
                await page.get_by_role("link", name="연결 준비 상태", exact=True).click()
            status_response = await pending_status.value
            report["response_statuses"].append({"path": urlsplit(status_response.url).path, "status": status_response.status,
                                               "transport": "actual browser request"})
            assert status_response.status == 200
            await expect(page.get_by_role("heading", name="연결 준비 상태", exact=True)).to_be_visible()
            await expect(page.locator("main")).to_contain_text("CLOSED")
            await expect(page.locator("main")).to_contain_text("not-connected")
            await page.get_by_role("link", name="처음으로", exact=True).click()
            await expect(page.get_by_role("heading", name="계정과 서비스 정보를 한곳으로", exact=True)).to_be_visible()
            passed("client-navigation-to-protected-status-keeps-integrations-disconnected")

            assert await page.evaluate("localStorage.length") == 0
            assert await page.evaluate("sessionStorage.length") == 0
            assert await page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
            assert await context.cookies() == []
            assert report["static_assets"] and not report["errors"]
            passed("owned-static-assets-match-build-and-no-browser-storage-cookie-or-external-request")
            report["result"] = "PASS"
        except Exception as error:
            report["result"] = "FAIL"
            report["failure_type"] = type(error).__name__
            report["failure_line"] = [frame.lineno for frame in traceback.extract_tb(error.__traceback__) if frame.filename == __file__]
        finally:
            await context.close()
            await browser.close()
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"result": report["result"], "checks": len(report["checks"]), "errors": report["errors"]}))
    return 0 if report["result"] == "PASS" else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--public", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chromium", type=Path, default=Path("/usr/lib/chromium/chromium"))
    args = parser.parse_args()
    parsed = urlsplit(args.base_url)
    assert parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port
    assert not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    assert parsed.path in ("", "/")
    args.output.mkdir(parents=True, exist_ok=False)
    return asyncio.run(run(args))


if __name__ == "__main__":
    raise SystemExit(main())
