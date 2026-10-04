"""Owned synthetic Chromium QA: competing tabs, page lifecycle and real idle timing.

Uses the installed Python Playwright and Chromium. It never installs dependencies,
attaches to a user's browser/profile, or contacts a provider. Disk roundtrips use
fresh owned test profiles inside the new output directory.
"""

import argparse
import asyncio
import hashlib
import json
import shutil
import threading
import time
import traceback
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from playwright.async_api import async_playwright, expect


PRIVATE_SELECTORS = [
    '[data-testid="relationship-catalog"]', '[data-testid="registration-panel"]',
    '[data-testid="conflict-review"]', '[data-testid="rotation-stage-panel"]',
    '[data-testid="connection-editor"]', '[data-testid="local-tool-panel"]',
    '.identity-map', '.relationship-list', '.issuer-context',
    '#local-catalog-query', '#local-catalog-filter', '#local-tool-query',
]

# Exact synthetic DB, readonly transactions, no archive bytes or IDs returned.
READ_STATE = """async () => {
  const result = await new Promise((resolve, reject) => {
    const request = indexedDB.open('keyatlas-synthetic-vault-v1');
    request.onupgradeneeded = () => { request.transaction.abort(); reject(new Error('QA_MISSING_DB')); };
    request.onerror = () => reject(new Error('QA_IDB_ERROR'));
    request.onblocked = () => reject(new Error('QA_IDB_BLOCKED'));
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      if (db.version !== 1 || db.objectStoreNames.length !== 1 || !db.objectStoreNames.contains('bundle')) {
        db.close(); reject(new Error('QA_IDB_SCHEMA')); return;
      }
      const tx = db.transaction('bundle', 'readonly');
      let keys, values;
      tx.onabort = () => { db.close(); reject(new Error('QA_IDB_ABORT')); };
      tx.onerror = () => { db.close(); reject(new Error('QA_IDB_ERROR')); };
      tx.oncomplete = () => {
        db.close();
        if (!keys || !values || keys.length !== values.length || keys.length < 1 || keys.length > 9) {
          reject(new Error('QA_IDB_KEYS')); return;
        }
        let archive;
        const conflicts = [];
        for (let i = 0; i < keys.length; i++) {
          const value = values[i];
          if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 524288) {
            reject(new Error('QA_IDB_VALUE')); return;
          }
          if (keys[i] === 'archive') archive = value;
          else if (typeof keys[i] === 'string' && /^conflict:[0-9a-f]{32}$/.test(keys[i])) conflicts.push(value);
          else { reject(new Error('QA_IDB_KEY')); return; }
        }
        if (!archive) { reject(new Error('QA_MISSING_ARCHIVE')); return; }
        resolve({archive, conflicts});
      };
      const store = tx.objectStore('bundle');
      const k = store.getAllKeys(undefined, 10), v = store.getAll(undefined, 10);
      k.onsuccess = () => { keys = k.result; };
      v.onsuccess = () => { values = v.result; };
    };
  });
  const hash = async bytes => ({bytes: bytes.byteLength,
    sha256: [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('')});
  const conflicts = await Promise.all(result.conflicts.map(hash));
  conflicts.sort((a, b) => a.sha256.localeCompare(b.sha256));
  return {archive: await hash(result.archive), conflicts};
}"""

# Observe and delegate to the actual browser APIs; keep URLs and File bytes out
# of the report. This does not supply a fake URL, file read, or cleanup result.
OBSERVE_BACKUP_RESOURCES = """() => {
  const created = new Set(), revoked = new Set();
  let duplicateRevokes = 0, unknownRevokes = 0, fileReads = 0;
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  const read = File.prototype.arrayBuffer;
  URL.createObjectURL = function (...args) {
    const url = Reflect.apply(create, this, args);
    created.add(url); return url;
  };
  URL.revokeObjectURL = function (url) {
    Reflect.apply(revoke, this, [url]);
    if (!created.has(url)) unknownRevokes++;
    else if (revoked.has(url)) duplicateRevokes++;
    else revoked.add(url);
  };
  File.prototype.arrayBuffer = function (...args) {
    fileReads++; return Reflect.apply(read, this, args);
  };
  window.qaBackupResourceCounts = () => ({created: created.size,
    revoked: revoked.size, active: created.size - revoked.size,
    duplicateRevokes, unknownRevokes, fileReads});
}"""


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


async def run(args, dist, origin):
    report = {"scope": "owned synthetic production preview only", "checks": [],
              "errors": [], "clock_mode": args.mode, "network_static_bytes_verified": 0, "focus_samples": []}

    def passed(case, **evidence):
        report["checks"].append({"case": case, "result": "PASS", "evidence": evidence})
        print(json.dumps({"case": case, "result": "PASS"}), flush=True)

    def save():
        (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=str(args.chromium), headless=True)
        report["browser"] = browser.version

        async def context(wasm_fault=None):
            ctx = await browser.new_context(locale="ko-KR", timezone_id="Asia/Seoul",
                                            service_workers="block", accept_downloads=False,
                                            viewport={"width": 1440, "height": 900})
            return await configure(ctx, wasm_fault)

        async def configure(ctx, wasm_fault=None):
            async def restrict(route):
                request = route.request
                if not request.url.startswith(origin + "/") or request.method != "GET":
                    report["errors"].append("UNEXPECTED_ORIGIN_OR_METHOD")
                    await route.abort()
                    return
                try:
                    path = urlsplit(request.url).path
                    actual = (dist / (unquote(path).lstrip("/") or "index.html")).resolve()
                    assert actual.is_relative_to(dist) and actual.is_file()
                    if wasm_fault is not None and wasm_fault["enabled"] and path.endswith(".wasm"):
                        wasm_fault["blocked"] += 1
                        await route.abort()
                        return
                    response = await route.fetch()
                    payload = await response.body()
                    assert response.status == 200
                    assert hashlib.sha256(payload).digest() == hashlib.sha256(actual.read_bytes()).digest()
                    report["network_static_bytes_verified"] += 1
                    await route.fulfill(response=response, body=payload)
                    await response.dispose()
                except Exception:
                    report["errors"].append("STATIC_RESPONSE_CHECK_FAILED")
                    await route.abort()

            await ctx.route("**/*", restrict)

            async def socket_guard(socket):
                report["errors"].append("UNEXPECTED_WEBSOCKET")
                await socket.close()

            await ctx.route_web_socket("**/*", socket_guard)
            ctx.on("page", lambda page: page.on("pageerror", lambda _error: report["errors"].append("PAGE_EXCEPTION")))
            return ctx

        async def owned_profile(path, downloads=False, restart=False):
            assert path.parent == args.output and path.name in ("disk-source-profile", "disk-target-profile")
            assert path.is_dir() if restart else not path.exists()
            ctx = await p.chromium.launch_persistent_context(str(path), executable_path=str(args.chromium),
                headless=True, locale="ko-KR", timezone_id="Asia/Seoul", service_workers="block",
                accept_downloads=downloads, viewport={"width": 1440, "height": 900})
            return await configure(ctx)

        async def status(page, prefix):
            await expect(page.get_by_test_id("vault-status")).to_contain_text(prefix, timeout=45_000)

        async def seed(page):
            await page.goto(origin + "/?view=local-vault", wait_until="load")
            await status(page, "잠김")
            await expect(page.locator("main.local-vault header .demo-warning strong")).to_have_text("실제 비밀번호·API 키 입력 금지.")
            await page.get_by_role("button", name="합성 금고 만들기", exact=True).click()
            await status(page, "열림")
            await expect(page.get_by_test_id("relationship-catalog")).to_have_count(1)

        async def stored(page):
            return await asyncio.wait_for(page.evaluate(READ_STATE), timeout=10)

        async def removed(page):
            return await page.evaluate("selectors => selectors.every(s => document.querySelectorAll(s).length === 0)", PRIVATE_SELECTORS)

        async def reopen(page):
            await page.get_by_role("button", name="저장된 합성 금고 열기", exact=True).click()
            await status(page, "열림")

        async def prepare_registration(page, profile):
            await page.get_by_test_id("registration-profile").select_option(str(profile))
            await page.get_by_test_id("registration-acknowledgement").check()

        async def focus(page, target, name):
            report["focus_samples"].append({"case": name, "active_tag": await page.evaluate("document.activeElement?.tagName")})
            await expect(target).to_be_focused()

        async def controlled_clock(page):
            # Freeze before any vault/backup activity. Installing alone lets
            # real setup/crypto time consume the one-second pre-deadline margin.
            await page.clock.install(time="2026-10-03T00:00:00Z")
            await page.clock.pause_at("2026-10-03T00:00:01Z")

        async def settle(cases):
            # Finish each owned case and its cleanup before closing the browser,
            # including when a sibling fails. Preserve failures without raw data.
            outcomes = await asyncio.gather(*(task for _, task in cases), return_exceptions=True)
            failures = [{"case": name, "failure_type": type(outcome).__name__}
                        for (name, _), outcome in zip(cases, outcomes)
                        if isinstance(outcome, BaseException)]
            if failures:
                report["parallel_failures"] = failures
                raise AssertionError("QA_PARALLEL_CASE_FAILED")

        try:
            if args.mode in ("quick", "all"):
                ctx = await context()
                try:
                    a, b = await ctx.new_page(), await ctx.new_page()
                    await seed(a)
                    before = await stored(a)
                    await b.goto(origin + "/?view=local-vault", wait_until="load")
                    await status(b, "잠김")
                    await reopen(b)
                    await status(a, "열림")
                    assert await a.evaluate("document.visibilityState") == "visible"
                    assert await b.evaluate("document.visibilityState") == "visible"
                    assert await stored(b) == before
                    await prepare_registration(a, 0)
                    await prepare_registration(b, 1)
                    await a.get_by_test_id("registration-submit").click()
                    await status(a, "4개 합성 항목")
                    await focus(a, a.get_by_test_id("vault-status"), "tab-a-register")
                    current = await stored(a)
                    assert current["archive"] != before["archive"] and current["conflicts"] == []
                    await b.get_by_test_id("registration-submit").click()
                    await status(b, "STORAGE_CONFLICT_PRESERVED")
                    await focus(b, b.get_by_test_id("vault-status"), "tab-b-stale-register")
                    assert await removed(b)
                    preserved = await stored(b)
                    assert preserved["archive"] == current["archive"]
                    assert len(preserved["conflicts"]) == 1
                    assert preserved["conflicts"][0] != current["archive"]
                    passed("ordered-competing-tabs-preserve-stale-candidate", before=before, after=preserved,
                           actual_visibility="both visible in headless Chromium", actual_simultaneous_race=False)

                    backup_page = await ctx.new_page()
                    await backup_page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                    await backup_page.get_by_role("checkbox").check()
                    await backup_page.get_by_role("button", name="합성 백업 파일 준비", exact=True).click()
                    await expect(backup_page.get_by_test_id("backup-status")).to_contain_text("충돌 암호문이 있어 백업 파일을 만들지 않았습니다", timeout=45_000)
                    await focus(backup_page, backup_page.get_by_test_id("backup-status"), "backup-unresolved-conflict")
                    await expect(backup_page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(0)
                    assert await stored(backup_page) == preserved
                    passed("unresolved-conflict-blocks-export-without-discard-or-head-change", conflict_count=1)

                    await reopen(b)
                    await status(b, "4개 합성 항목")
                    await b.get_by_role("button", name="후보 목록 확인", exact=True).click()
                    await expect(b.get_by_test_id("conflict-review-status")).to_contain_text("인증된 보존 후보 1개", timeout=45_000)
                    await focus(b, b.get_by_test_id("conflict-review-status"), "load-conflict-review")
                    assert await stored(b) == preserved
                    await b.get_by_role("button", name="이 후보 폐기 검토", exact=True).click()
                    await expect(b.get_by_test_id("conflict-review").get_by_role("heading", name="보존 후보 1", exact=True)).to_be_focused()
                    assert await stored(b) == preserved
                    await b.get_by_test_id("conflict-review").get_by_role("button", name="취소", exact=True).click()
                    await expect(b.get_by_test_id("conflict-review").get_by_role("heading", name="보존 후보 1", exact=True)).to_be_focused()
                    assert await stored(b) == preserved
                    await b.get_by_role("button", name="이 후보 폐기 검토", exact=True).click()
                    await b.get_by_role("button", name="확인하고 후보 폐기", exact=True).click()
                    await expect(b.get_by_test_id("conflict-review-status")).to_contain_text("선택한 후보를 폐기했습니다", timeout=45_000)
                    await expect(b.get_by_test_id("conflict-review-status")).to_be_focused()
                    discarded = await stored(b)
                    assert discarded["archive"] == current["archive"] and discarded["conflicts"] == []
                    passed("explicit-conflict-review-cancel-and-two-step-discard", head_preserved=True, conflict_count=0)
                    await backup_page.get_by_role("button", name="합성 백업 파일 준비", exact=True).click()
                    await expect(backup_page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(1, timeout=45_000)
                    await focus(backup_page, backup_page.get_by_test_id("backup-status"), "backup-prepared")
                    assert await stored(backup_page) == discarded
                    await backup_page.get_by_role("button", name="작업 취소 · 준비 파일 비우기", exact=True).click()
                    await expect(backup_page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(0)
                    await expect(backup_page.get_by_role("checkbox")).not_to_be_checked()
                    assert await stored(backup_page) == discarded
                    passed("resolved-backup-preparation-and-explicit-clear-preserve-storage", actual_disk_download=False)
                    await a.get_by_role("button", name="잠그기 / 작업 취소", exact=True).click()
                    await b.get_by_role("button", name="잠그기 / 작업 취소", exact=True).click()
                    assert await removed(a) and await removed(b)
                finally:
                    await ctx.close()

                ctx = await context()
                try:
                    page = await ctx.new_page()
                    await seed(page)
                    before = await stored(page)
                    await page.get_by_test_id("connection-edit-open-0").click()
                    await expect(page.get_by_test_id("connection-editor")).to_be_visible()
                    await page.goto(origin + "/?view=identity-map", wait_until="load")
                    await page.go_back(wait_until="load")
                    await status(page, "잠김")
                    assert await removed(page) and await stored(page) == before
                    await reopen(page)
                    assert await stored(page) == before
                    passed("actual-navigation-and-back-require-explicit-reopen", ciphertext_unchanged=True,
                           no_claim_of_os_sleep_or_background_tab=True)
                finally:
                    await ctx.close()

                ctx = await context()
                try:
                    page = await ctx.new_page()
                    await controlled_clock(page)
                    await seed(page)
                    before = await stored(page)
                    await page.bring_to_front()
                    await page.locator("#local-catalog-query").focus()
                    await page.clock.run_for(299_000)
                    await status(page, "열림")
                    await page.clock.run_for(2_000)
                    await status(page, "잠김")
                    await expect(page.get_by_test_id("vault-status")).to_be_focused()
                    assert await removed(page) and await stored(page) == before
                    await reopen(page)
                    lock_button = page.get_by_role("button", name="잠그기 / 작업 취소", exact=True)
                    await lock_button.focus()
                    await page.keyboard.press("Enter")
                    await status(page, "잠김")
                    await expect(lock_button).to_be_focused()
                    passed("accelerated-idle-restores-lost-focus-and-manual-lock-preserves-button-focus",
                           clock_mock=True, ciphertext_unchanged=True)
                finally:
                    await ctx.close()

                ctx = await context()
                try:
                    page = await ctx.new_page()
                    await controlled_clock(page)
                    await seed(page)
                    before = await stored(page)
                    await page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                    await page.evaluate(OBSERVE_BACKUP_RESOURCES)
                    await page.get_by_role("checkbox").check()
                    await page.get_by_role("button", name="합성 백업 파일 준비", exact=True).click()
                    download = page.get_by_role("link", name="백업 파일 다운로드", exact=True)
                    await expect(download).to_have_count(1, timeout=45_000)
                    await expect(page.get_by_test_id("backup-status")).to_be_focused()
                    counts = await page.evaluate("window.qaBackupResourceCounts()")
                    assert counts == {"created": 1, "revoked": 0, "active": 1,
                                      "duplicateRevokes": 0, "unknownRevokes": 0, "fileReads": 0}
                    await page.clock.run_for(299_000)
                    await expect(download).to_have_count(1)
                    await page.clock.run_for(2_000)
                    await expect(download).to_have_count(0)
                    await expect(page.get_by_role("checkbox")).not_to_be_checked()
                    counts = await page.evaluate("window.qaBackupResourceCounts()")
                    assert counts == {"created": 1, "revoked": 1, "active": 0,
                                      "duplicateRevokes": 0, "unknownRevokes": 0, "fileReads": 0}
                    assert await stored(page) == before
                    passed("prepared-backup-idle-expiry-revokes-actual-url-and-clears-acknowledgement",
                           clock_mock=True, native_resource_counts=counts, ciphertext_unchanged=True)

                    files = args.output / "owned-synthetic-files"
                    files.mkdir()
                    cases = [("too-small", 15), ("oversized", 524_289), ("boundary-size", 524_288),
                             ("invalid-header", 32)]
                    for name, size in cases:
                        (files / ("SYN-QA-" + name + ".katldemo")).write_bytes(bytes(size))
                    await page.get_by_role("checkbox").check()
                    restore = page.get_by_role("button", name="빈 저장소에 복원", exact=True)

                    async def choose(name):
                        async with page.expect_file_chooser() as pending:
                            await page.locator('input[type="file"]').click()
                        chooser = await pending.value
                        await chooser.set_files(files / ("SYN-QA-" + name + ".katldemo"))
                        assert await page.locator('input[type="file"]').input_value() == ""
                        assert "SYN-QA-" not in await page.locator("body").inner_text()

                    await choose("too-small")
                    await expect(page.get_by_test_id("backup-status")).to_contain_text("지원하는 합성 백업 파일이 아닙니다")
                    await expect(restore).to_be_disabled()
                    await choose("oversized")
                    await expect(page.get_by_test_id("backup-status")).to_contain_text("512 KiB 이하여야")
                    await expect(restore).to_be_disabled()
                    await choose("boundary-size")
                    await expect(page.locator("main")).to_contain_text("합성 파일 선택됨 · 524288바이트")
                    await expect(restore).to_be_enabled()
                    assert (await page.evaluate("window.qaBackupResourceCounts()"))["fileReads"] == 0
                    assert await stored(page) == before
                    await page.get_by_role("button", name="작업 취소 · 준비 파일 비우기", exact=True).click()
                    await expect(restore).to_be_disabled()
                    await expect(page.locator("main")).to_contain_text("선택된 파일 없음")
                    await expect(page.get_by_role("checkbox")).not_to_be_checked()
                    await page.get_by_role("checkbox").check()
                    await choose("invalid-header")
                    await expect(restore).to_be_enabled()
                    assert (await page.evaluate("window.qaBackupResourceCounts()"))["fileReads"] == 0
                    await restore.click()
                    await expect(page.get_by_test_id("backup-status")).to_contain_text("지원하는 합성 백업 파일이 아닙니다", timeout=45_000)
                    await expect(page.get_by_test_id("backup-status")).to_be_focused()
                    await expect(restore).to_be_disabled()
                    counts = await page.evaluate("window.qaBackupResourceCounts()")
                    assert counts["fileReads"] == 1 and counts["active"] == 0
                    assert await stored(page) == before
                    passed("actual-file-chooser-enforces-size-before-read-and-rejects-invalid-content-without-overwrite",
                           native_file_reads=1, accepted_boundary_bytes=524_288,
                           rejected_oversize_bytes=524_289, filename_not_rendered=True, ciphertext_unchanged=True)
                finally:
                    await ctx.close()

            if args.mode in ("rotation-stage", "all"):
                ctx = await context()
                try:
                    page = await ctx.new_page()
                    await seed(page)
                    before = await stored(page)
                    await expect(page.get_by_test_id("rotation-stage-panel")).to_contain_text("실제 API를 호출하지 않습니다")
                    # Public seed reference 2 is the closed multi-consumer API
                    # fixture; reference 0 deliberately has no connections.
                    await page.get_by_test_id("stage-reference").select_option("2")
                    await page.get_by_test_id("stage-load").click()
                    await expect(page.get_by_test_id("stage-status")).to_contain_text("현재 항목에 저장된 진행이 없습니다", timeout=45_000)
                    await focus(page, page.get_by_test_id("stage-status"), "rotation-load-no-saved-stage")
                    assert await stored(page) == before
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    await page.get_by_test_id("stage-save").click()
                    await status(page, "열림")
                    partial = await stored(page)
                    assert partial["archive"] != before["archive"] and partial["conflicts"] == []
                    await page.reload(wait_until="load")
                    await status(page, "잠김")
                    assert await removed(page) and await stored(page) == partial
                    await reopen(page)
                    await page.get_by_test_id("stage-reference").select_option("2")
                    await page.get_by_test_id("stage-load").click()
                    await expect(page.get_by_test_id("stage-details")).to_be_visible(timeout=45_000)
                    await expect(page.get_by_test_id("stage-ack")).not_to_be_checked()
                    await expect(page.get_by_test_id("stage-ack")).to_be_disabled()
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    assert await stored(page) == partial
                    passed("rotation-pending-progress-survives-reload-without-restoring-cutover-consent",
                           synthetic_provider_assumptions_only=True, ciphertext_preserved_after_reload=True)

                    fixtures = await page.get_by_test_id("stage-details").locator("li").evaluate_all(
                        "elements => elements.map(element => element.textContent.split(' · ')[0])")
                    assert len(fixtures) == 3 and set(fixtures) == {"mcp", "cli", "ci"}
                    for fixture in fixtures:
                        await page.get_by_test_id("stage-" + fixture).select_option("user_confirmed")
                    await page.get_by_test_id("stage-revocation").select_option("user_confirmed")
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    assert await stored(page) == partial
                    await page.get_by_test_id("stage-save").click()
                    await status(page, "열림")
                    ready = await stored(page)
                    assert ready["archive"] != partial["archive"] and ready["conflicts"] == []
                    await page.get_by_test_id("stage-reference").select_option("2")
                    await page.get_by_test_id("stage-load").click()
                    await expect(page.get_by_test_id("stage-details")).to_contain_text("저장된 진행의 확정 조건이 준비됐습니다", timeout=45_000)
                    await expect(page.get_by_test_id("stage-ack")).to_be_enabled()
                    await expect(page.get_by_test_id("stage-ack")).not_to_be_checked()
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    await page.get_by_test_id("stage-ack").check()
                    await expect(page.get_by_test_id("stage-commit")).to_be_enabled()
                    await page.get_by_test_id("stage-" + fixtures[0]).select_option("pending")
                    await expect(page.get_by_test_id("stage-ack")).not_to_be_checked()
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    assert await stored(page) == ready
                    await page.get_by_test_id("stage-" + fixtures[0]).select_option("user_confirmed")
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    await page.get_by_test_id("stage-ack").check()
                    await page.get_by_test_id("stage-commit").click()
                    await status(page, "열림")
                    committed = await stored(page)
                    assert committed["archive"] != ready["archive"] and committed["conflicts"] == []
                    await page.get_by_test_id("stage-reference").select_option("2")
                    await page.get_by_test_id("stage-load").click()
                    await expect(page.get_by_test_id("stage-status")).to_contain_text("현재 항목에 저장된 진행이 없습니다", timeout=45_000)
                    await expect(page.get_by_test_id("stage-commit")).to_be_disabled()
                    assert await stored(page) == committed
                    passed("rotation-cutover-requires-saved-reviewed-matching-progress-and-fresh-consent",
                           current_catalog_count=3, real_provider_revocation_verified=False,
                           consumed_stage_not_reapplied=True, selection_change_clears_consent=True)
                finally:
                    await ctx.close()

            if args.mode in ("disk-backup", "all"):
                source = await owned_profile(args.output / "disk-source-profile", downloads=True)
                try:
                    page = await source.new_page()
                    await seed(page)
                    await prepare_registration(page, 0)
                    await page.get_by_test_id("registration-submit").click()
                    await status(page, "4개 합성 항목")
                    before = await stored(page)
                    assert before["conflicts"] == []
                    await page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                    await page.get_by_role("checkbox").check()
                    await page.get_by_role("button", name="합성 백업 파일 준비", exact=True).click()
                    await expect(page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(1, timeout=45_000)
                    async with page.expect_download() as pending:
                        await page.get_by_role("link", name="백업 파일 다운로드", exact=True).click()
                    download = await pending.value
                    assert await download.failure() is None
                    assert download.suggested_filename == "keyatlas-synthetic-v1.katldemo"
                    saved = args.output / "SYN-QA-downloaded-v2.katldemo"
                    await download.save_as(saved)
                    assert 16 <= saved.stat().st_size <= 524_288
                    disk = {"bytes": saved.stat().st_size, "sha256": hashlib.sha256(saved.read_bytes()).hexdigest()}
                    assert disk == before["archive"] and await stored(page) == before
                finally:
                    await source.close()

                target_path = args.output / "disk-target-profile"
                target = await owned_profile(target_path)
                try:
                    page = await target.new_page()
                    await page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                    assert await page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
                    await page.get_by_role("checkbox").check()
                    async with page.expect_file_chooser() as pending:
                        await page.locator('input[type="file"]').click()
                    await (await pending.value).set_files(saved)
                    assert await page.evaluate("indexedDB.databases().then(dbs => dbs.length)") == 0
                    assert saved.name not in await page.locator("body").inner_text()
                    await expect(page.get_by_role("button", name="빈 저장소에 복원", exact=True)).to_be_enabled()
                    await page.get_by_role("button", name="빈 저장소에 복원", exact=True).click()
                    await expect(page.get_by_test_id("backup-status")).to_contain_text("복원 완료", timeout=45_000)
                    await expect(page.get_by_test_id("backup-status")).to_be_focused()
                    assert await stored(page) == before
                    await page.goto(origin + "/?view=local-vault", wait_until="load")
                    await status(page, "잠김")
                    assert await removed(page)
                    await reopen(page)
                    await status(page, "4개 합성 항목")
                    assert await stored(page) == before
                    await page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                    await page.get_by_role("checkbox").check()
                    async with page.expect_file_chooser() as pending:
                        await page.locator('input[type="file"]').click()
                    await (await pending.value).set_files(saved)
                    await page.get_by_role("button", name="빈 저장소에 복원", exact=True).click()
                    await expect(page.get_by_test_id("backup-status")).to_contain_text("이미 금고가 있어 복원하지 않았습니다", timeout=45_000)
                    assert await stored(page) == before
                finally:
                    await target.close()

                restarted = await owned_profile(target_path, restart=True)
                try:
                    page = await restarted.new_page()
                    await page.goto(origin + "/?view=local-vault", wait_until="load")
                    await status(page, "잠김")
                    assert await removed(page) and await stored(page) == before
                    await reopen(page)
                    await status(page, "4개 합성 항목")
                    assert await stored(page) == before
                    passed("v2-disk-download-native-file-chooser-fresh-profile-restore-and-browser-restart",
                           actual_disk_download=True, encrypted_bytes=disk,
                           source_and_restored_current_count=4, restore_requires_explicit_reopen=True,
                           existing_archive_not_overwritten=True, manual_os_file_dialog="NOT_RUN")
                finally:
                    await restarted.close()

            if args.mode in ("runtime-failure", "all"):
                fault = {"enabled": False, "blocked": 0}
                ctx = await context(fault)
                try:
                    page = await ctx.new_page()
                    await seed(page)
                    before = await stored(page)
                    fault["enabled"] = True
                    await page.reload(wait_until="load")
                    await status(page, "잠김")
                    await page.get_by_role("button", name="저장된 합성 금고 열기", exact=True).click()
                    await status(page, "BRIDGE_FAILURE")
                    await expect(page.get_by_test_id("vault-bridge-error")).to_contain_text("원인은 아직 확인되지 않았습니다")
                    await expect(page.get_by_test_id("vault-bridge-error")).to_contain_text("브라우저 데이터를 삭제하거나 금고를 초기화하지 마세요")
                    await expect(page.get_by_test_id("vault-status")).to_be_focused()
                    assert fault["blocked"] == 1 and await removed(page)
                    assert await stored(page) == before
                    await asyncio.sleep(2)
                    await status(page, "BRIDGE_FAILURE")
                    assert fault["blocked"] == 1 and await stored(page) == before
                    fault["enabled"] = False
                    await reopen(page)
                    await expect(page.get_by_test_id("vault-bridge-error")).to_have_count(0)
                    assert await stored(page) == before
                    passed("owned-wasm-load-failure-preserves-storage-and-recovers-only-after-explicit-reopen",
                           intentionally_blocked_owned_wasm_requests=1, no_automatic_retry_observed_seconds=2,
                           ciphertext_unchanged=True, no_claim_about_all_bridge_failure_causes=True)
                finally:
                    await ctx.close()

            if args.mode in ("contention", "all"):
                ctx = await context()
                try:
                    a, b = await ctx.new_page(), await ctx.new_page()
                    await seed(a)
                    before = await stored(a)
                    await b.goto(origin + "/?view=local-vault", wait_until="load")
                    await reopen(b)
                    await prepare_registration(a, 0)
                    await prepare_registration(b, 1)
                    for page in (a, b):
                        await page.evaluate("""() => {
                          const element = document.querySelector('[data-testid="vault-status"]');
                          window.qaBusyInterval = {start: null, end: null};
                          new MutationObserver(() => {
                            const now = performance.timeOrigin + performance.now();
                            if (element.textContent.startsWith('처리 중')) {
                              if (window.qaBusyInterval.start === null) window.qaBusyInterval.start = now;
                            } else if (window.qaBusyInterval.start !== null && window.qaBusyInterval.end === null) {
                              window.qaBusyInterval.end = now;
                            }
                          }).observe(element, {childList: true, subtree: true, characterData: true});
                        }""")
                    positions = []
                    for page in (a, b):
                        button = page.get_by_test_id("registration-submit")
                        await expect(button).to_be_enabled()
                        await expect(button).to_be_visible()
                        await button.scroll_into_view_if_needed()
                        box = await button.bounding_box()
                        assert box and box["width"] > 0 and box["height"] > 0
                        positions.append((box["x"] + box["width"] / 2, box["y"] + box["height"] / 2))
                    # Schedule actual pointer events on both pages. Locator
                    # actionability polling can serialize short operations;
                    # visibility/enabled checks above remain explicit.
                    await asyncio.gather(a.mouse.click(*positions[0]), b.mouse.click(*positions[1]))
                    for page in (a, b):
                        await expect(page.get_by_test_id("vault-status")).not_to_contain_text("처리 중", timeout=45_000)
                    outcomes = [await page.get_by_test_id("vault-status").inner_text() for page in (a, b)]
                    winner = [i for i, text in enumerate(outcomes) if text.startswith("열림") and "4개 합성 항목" in text]
                    loser = [i for i, text in enumerate(outcomes) if "STORAGE_CONFLICT_PRESERVED" in text]
                    assert len(winner) == 1 and len(loser) == 1
                    assert await removed((a, b)[loser[0]])
                    after = await stored(a)
                    assert after["archive"] != before["archive"] and len(after["conflicts"]) == 1
                    assert after == await stored(b)
                    intervals = [await page.evaluate("window.qaBusyInterval") for page in (a, b)]
                    assert all(isinstance(i["start"], (int, float)) and isinstance(i["end"], (int, float)) for i in intervals)
                    overlap = min(i["end"] for i in intervals) - max(i["start"] for i in intervals)
                    report["contention_timing"] = {"overlap_ms": round(overlap, 2),
                                                   "duration_ms": [round(i["end"] - i["start"], 2) for i in intervals]}
                    assert overlap > 0
                    reader = (a, b)[loser[0]]
                    await reopen(reader)
                    await status(reader, "4개 합성 항목")
                    await reader.get_by_role("button", name="후보 목록 확인", exact=True).click()
                    await expect(reader.get_by_test_id("conflict-review-status")).to_contain_text("인증된 보존 후보 1개", timeout=45_000)
                    assert await stored(reader) == after
                    passed("overlapping-two-tab-registration-has-one-current-head-and-one-authenticated-candidate",
                           overlap_ms=round(overlap, 2), simultaneous_clicks=True, winner_index=winner[0],
                           actual_visibility="headless Chromium", current_count=4, authenticated_conflicts=1)
                finally:
                    await ctx.close()

            if args.mode in ("outbox", "contention", "all"):
                ctx = await context()
                try:
                    writer = await ctx.new_page()
                    await seed(writer)
                    stale_pages = []
                    for _ in range(9):
                        page = await ctx.new_page()
                        stale_pages.append(page)
                        await page.goto(origin + "/?view=local-vault", wait_until="load")
                        await reopen(page)
                        await prepare_registration(page, 1)
                    await prepare_registration(writer, 0)
                    await writer.get_by_test_id("registration-submit").click()
                    await status(writer, "4개 합성 항목")
                    preserved = await stored(writer)
                    assert preserved["conflicts"] == []
                    for index, page in enumerate(stale_pages):
                        await page.get_by_test_id("registration-submit").click()
                        await status(page, "STORAGE_CONFLICT_PRESERVED" if index < 8 else "outbox-full")
                        assert await removed(page)
                        after = await stored(page)
                        assert after["archive"] == preserved["archive"]
                        if index < 8:
                            assert len(after["conflicts"]) == index + 1
                            assert all(value in after["conflicts"] for value in preserved["conflicts"])
                        else:
                            assert after == preserved
                        preserved = after
                        print(json.dumps({"case": "outbox-capacity", "attempt": index + 1,
                                          "preserved_candidates": len(after["conflicts"])}), flush=True)
                    await writer.get_by_role("button", name="후보 목록 확인", exact=True).click()
                    await expect(writer.get_by_test_id("conflict-review-status")).to_contain_text("인증된 보존 후보 8개", timeout=90_000)
                    assert await stored(writer) == preserved
                    passed("eight-candidate-outbox-refuses-ninth-stale-write-without-eviction-or-head-change",
                           current_count=4, authenticated_conflicts=8, rejected_ninth=True,
                           existing_candidate_bytes_unchanged=True)
                finally:
                    await ctx.close()

            if args.mode in ("backup-real-timing", "all"):
                async def real_backup_idle(selected_file):
                    ctx = await context()
                    try:
                        page = await ctx.new_page()
                        await seed(page)
                        before = await stored(page)
                        await page.goto(origin + "/?view=synthetic-backup", wait_until="load")
                        await page.evaluate(OBSERVE_BACKUP_RESOURCES)
                        await page.get_by_role("checkbox").check()
                        started = time.monotonic()
                        if selected_file:
                            path = args.output / "SYN-QA-real-idle.katldemo"
                            path.write_bytes(bytes(32))
                            async with page.expect_file_chooser() as pending:
                                await page.locator('input[type="file"]').click()
                            await (await pending.value).set_files(path)
                            await expect(page.get_by_role("button", name="빈 저장소에 복원", exact=True)).to_be_enabled()
                        else:
                            await page.get_by_role("button", name="합성 백업 파일 준비", exact=True).click()
                            await expect(page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(1, timeout=45_000)
                        await expect(page.get_by_test_id("backup-status")).to_be_focused()
                        while await page.get_by_role("checkbox").is_checked():
                            elapsed = time.monotonic() - started
                            assert elapsed < 315, "QA_BACKUP_IDLE_DEADLINE_NOT_ENFORCED"
                            if int(elapsed) % 30 == 0:
                                print(json.dumps({"case": "backup-real-timing", "selected_file": selected_file,
                                                  "elapsed_seconds": int(elapsed)}), flush=True)
                            await asyncio.sleep(1)
                        elapsed = time.monotonic() - started
                        assert 295 <= elapsed <= 315
                        await expect(page.get_by_role("link", name="백업 파일 다운로드", exact=True)).to_have_count(0)
                        await expect(page.get_by_role("button", name="빈 저장소에 복원", exact=True)).to_be_disabled()
                        await expect(page.locator("main")).to_contain_text("선택된 파일 없음")
                        counts = await page.evaluate("window.qaBackupResourceCounts()")
                        expected = 0 if selected_file else 1
                        assert counts == {"created": expected, "revoked": expected, "active": 0,
                                          "duplicateRevokes": 0, "unknownRevokes": 0, "fileReads": 0}
                        assert await stored(page) == before
                        passed("real-clock-backup-selected-file-cleared-without-read" if selected_file
                               else "real-clock-backup-download-url-revoked",
                               elapsed_seconds=round(elapsed, 2), no_clock_mock=True,
                               native_resource_counts=counts, ciphertext_unchanged=True,
                               no_claim_of_heap_erasure=True)
                    finally:
                        await ctx.close()

                await settle([("backup-url", real_backup_idle(False)), ("backup-file", real_backup_idle(True))])

            if args.mode in ("real-timing", "all"):
                async def real_idle(renew, untrusted=False):
                    ctx = await context()
                    try:
                        page = await ctx.new_page()
                        await seed(page)
                        before = await stored(page)
                        await page.locator("#local-catalog-query").focus()
                        await page.evaluate("""() => {
                          window.qaTrustedKeys = 0;
                          document.addEventListener('keydown', e => { if (e.isTrusted) window.qaTrustedKeys++; }, true);
                        }""")
                        started = time.monotonic()
                        renewed = False
                        untrusted_sent = False
                        deadline = 555 if renew else 315
                        while True:
                            elapsed = time.monotonic() - started
                            if renew and not renewed and elapsed >= 240:
                                await page.keyboard.press("Tab")
                                assert await page.evaluate("window.qaTrustedKeys") == 1
                                renewed = True
                            if untrusted and not untrusted_sent and elapsed >= 240:
                                await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}))")
                                assert await page.evaluate("window.qaTrustedKeys") == 0
                                untrusted_sent = True
                            text = await page.get_by_test_id("vault-status").inner_text()
                            if text.startswith("잠김"):
                                minimum = 535 if renew else 295
                                assert minimum <= elapsed <= deadline
                                assert await removed(page) and await stored(page) == before
                                foreground = await page.evaluate("document.hasFocus() && !document.hidden")
                                if foreground:
                                    await expect(page.get_by_test_id("vault-status")).to_be_focused()
                                passed("real-clock-untrusted-input-does-not-renew-idle" if untrusted
                                       else "real-clock-trusted-input-renews-idle" if renew else "real-clock-five-minute-idle",
                                       elapsed_seconds=round(elapsed, 2), trusted_renewal=renewed,
                                       untrusted_input=untrusted_sent, no_clock_mock=True, ciphertext_unchanged=True,
                                       foreground_focus_checked=foreground,
                                       focus_after_lock=await page.evaluate("document.activeElement?.tagName"))
                                break
                            assert text.startswith("열림"), "QA_UNEXPECTED_PHASE"
                            assert elapsed < deadline, "QA_IDLE_DEADLINE_NOT_ENFORCED"
                            if int(elapsed) % 30 == 0:
                                print(json.dumps({"case": "real-timing", "renew": renew, "untrusted": untrusted, "elapsed_seconds": int(elapsed)}), flush=True)
                            await asyncio.sleep(1)
                        await reopen(page)
                        assert await stored(page) == before
                    finally:
                        await ctx.close()

                await settle([("idle", real_idle(False)), ("trusted-renewal", real_idle(True)),
                              ("untrusted-input", real_idle(False, untrusted=True))])
            assert report["checks"] and not report["errors"]
            report["result"] = "PASS"
        except Exception as error:
            report["result"] = "FAIL"
            report["failure_type"] = type(error).__name__
            report["failure_line"] = [frame.lineno for frame in traceback.extract_tb(error.__traceback__) if frame.filename == __file__]
        finally:
            await browser.close()
            save()
    print(json.dumps({"result": report["result"], "checks": len(report["checks"]), "errors": report["errors"]}), flush=True)
    return 0 if report["result"] == "PASS" else 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dist", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--chromium", type=Path, default=Path("/usr/lib/chromium/chromium"))
    parser.add_argument("--mode", choices=("quick", "rotation-stage", "disk-backup", "runtime-failure", "contention", "outbox", "backup-real-timing", "real-timing", "all"), default="quick")
    args = parser.parse_args()
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=False)
    assert (args.dist / "index.html").is_file(), "Build the production app first"
    dist = args.output / "dist"
    shutil.copytree(args.dist.resolve(), dist)
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(QuietHandler, directory=str(dist)))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        return asyncio.run(run(args, dist, f"http://127.0.0.1:{server.server_port}"))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == "__main__":
    raise SystemExit(main())
