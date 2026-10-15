import { probeSyntheticArchive } from "./synthetic-idb-probe.mjs";

const OPEN = "열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.";
const LOCKED = "잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.";
const PRIVATE_SELECTORS = [
  '[data-testid="relationship-catalog"]', '[data-testid="rotation-stage-panel"]',
  '[data-testid="registration-panel"]', '[data-testid="conflict-review"]',
  '[data-testid="local-tool-panel"]', '[data-testid="connection-editor"]',
  '[data-testid^="connection-edit-open-"]', ".relationship-list", ".issuer-context",
  "#local-catalog-query", "#local-catalog-filter", "#local-tool-query",
];

async function waitStatus(page, expected, contains = false) {
  await page.waitForFunction(({ expected, contains }) => {
    const status = document.querySelector('[data-testid="vault-status"]');
    return status && (contains ? status.textContent.includes(expected) : status.textContent === expected);
  }, { expected, contains }, { timeout: 15000 });
}

async function seed(page, baseUrl) {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitStatus(page, LOCKED);
  // Require the actual synthetic-only entry point, not an arbitrary local page.
  if (await page.locator("main.local-vault header .demo-warning strong").textContent()
      !== "실제 비밀번호·API 키 입력 금지.") throw new Error("QA_WRONG_PAGE");
  await page.getByRole("button", { name: "합성 금고 만들기", exact: true }).click();
  await waitStatus(page, OPEN);
  if (await page.getByTestId("relationship-catalog").count() !== 1) throw new Error("QA_MISSING_CATALOG");
}

async function reopen(page) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitStatus(page, LOCKED);
  // Never create here: that could disguise a missing archive as successful restore.
  await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
  await waitStatus(page, OPEN);
}

async function lock(page, keyboard = false) {
  const button = page.getByRole("button", { name: "잠그기 / 작업 취소", exact: true });
  if (keyboard) {
    await button.focus();
    await page.keyboard.press("Enter");
  } else await button.click();
  await waitStatus(page, LOCKED);
}

async function privateDomRemoved(page) {
  // Requires private nodes to be absent, not merely hidden; no claim of JS heap erasure.
  return page.evaluate((selectors) => selectors.every((selector) => document.querySelectorAll(selector).length === 0), PRIVATE_SELECTORS);
}

async function snapshot(page, action = "read") {
  return page.evaluate(probeSyntheticArchive, { action, acknowledgement: "keyatlas-m05a-synthetic-only" });
}

function same(left, right) {
  return left.bytes === right.bytes && left.sha256 === right.sha256;
}

/** These cases are code, not evidence of an actual browser run. Fresh context per case is mandatory. */
export function createScenarios(baseUrl) {
  return [
    { id: "S1", async run({ page }) {
      await seed(page, baseUrl);
      const before = await snapshot(page);
      // Patch only the exact archive write in this new synthetic page. Reload removes the patch.
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.transaction.db.name === "keyatlas-synthetic-vault-v1"
              && this.name === "bundle" && args[1] === "archive") {
            throw new DOMException("synthetic quota fixture", "QuotaExceededError");
          }
          return Reflect.apply(original, this, args);
        };
      });
      await page.getByTestId("stage-save").click();
      await waitStatus(page, "작업을 확인하지 못했습니다 (quota).", true);
      const after = await snapshot(page);
      await reopen(page);
      const reopened = await snapshot(page);
      return {
        checks: {
          archivePresent: true, quotaReported: true,
          archivePreserved: same(before.archive, after.archive),
          reopenedFromStoredArchive: same(before.archive, reopened.archive),
        },
        observations: { before: before.archive, after: after.archive, reopened: reopened.archive },
      };
    } },
    { id: "S2", async run({ page }) {
      await seed(page, baseUrl);
      const before = await snapshot(page);
      // Open an actual editor first, so lock checks include its mounted input state.
      await page.getByTestId("connection-edit-open-0").click();
      await page.getByTestId("connection-editor").waitFor({ state: "visible" });
      await lock(page);
      const removed = await privateDomRemoved(page);
      const after = await snapshot(page);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitStatus(page, LOCKED);
      const reloadLocked = await privateDomRemoved(page);
      await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
      await waitStatus(page, OPEN);
      const reopened = await snapshot(page);
      return {
        checks: {
          privateDomRemoved: removed, reloadLocked,
          archivePreserved: same(before.archive, after.archive),
          reopenedFromStoredArchive: same(before.archive, reopened.archive),
        },
        observations: { before: before.archive, after: after.archive, reopened: reopened.archive },
      };
    } },
    { id: "S3", async run({ page }) {
      await seed(page, baseUrl);
      await lock(page, true);
      const removed = await privateDomRemoved(page);
      let privateFocus = false;
      for (let index = 0; index < 20; index += 1) {
        await page.keyboard.press("Tab");
        privateFocus ||= await page.evaluate((selectors) => selectors.some((selector) =>
          [...document.querySelectorAll(selector)].some((element) => element.contains(document.activeElement))), PRIVATE_SELECTORS);
      }
      return {
        checks: { enterLocked: true, privateDomRemoved: removed, tabStayedOutsidePrivateControls: !privateFocus },
        observations: {},
      };
    } },
    { id: "S4", async run({ page }) {
      await page.setViewportSize({ width: 360, height: 800 });
      await seed(page, baseUrl);
      const measure = () => page.evaluate(() => ({
        client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth,
      }));
      const unlockedWidth = await measure();
      await lock(page);
      const lockedWidth = await measure();
      return {
        checks: {
          unlockedNoHorizontalOverflow: unlockedWidth.scroll <= unlockedWidth.client,
          lockedNoHorizontalOverflow: lockedWidth.scroll <= lockedWidth.client,
        },
        observations: { unlockedWidth, lockedWidth },
      };
    } },
    { id: "S5", async run({ page }) {
      await seed(page, baseUrl);
      const before = await snapshot(page);
      await lock(page);
      // Version-only upgrade in an owned ephemeral context; no deletion, clear or record rewrite.
      const upgraded = await snapshot(page, "upgrade-future");
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitStatus(page, LOCKED);
      await page.getByRole("button", { name: "저장된 합성 금고 열기", exact: true }).click();
      await waitStatus(page, "작업을 확인하지 못했습니다 (incompatible).", true);
      const after = await snapshot(page);
      return {
        checks: {
          futureVersion: upgraded.version === 99 && after.version === 99,
          incompatibleReported: true,
          archivePreserved: same(before.archive, upgraded.archive) && same(before.archive, after.archive),
          storeLayoutPreserved: JSON.stringify(before.stores) === JSON.stringify(upgraded.stores)
            && JSON.stringify(before.stores) === JSON.stringify(after.stores),
        },
        observations: {
          before: before.archive, after: after.archive,
          versionBefore: before.version, versionAfter: after.version,
        },
      };
    } },
  ];
}
