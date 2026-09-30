import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:4173/?view=local-vault';
const RESULT = { scenarios: [] };

async function readVaultRecord(page) {
  return await page.evaluate(async () => {
    const dbs = (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.includes('keyatlas'));
    if (!dbs.length) return { databases: [] };
    const name = dbs[0];
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(name);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const storeNames = [...db.objectStoreNames];
    const out = { databases: dbs, name, version: db.version, stores: storeNames, bundles: {} };
    for (const storeName of storeNames) {
      const tx = db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const keys = await new Promise((res, rej) => { const r = store.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      out.bundles[storeName] = [];
      for (const key of keys) {
        const value = await new Promise((res, rej) => { const r = store.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        let size = -1, hash = null;
        if (value instanceof Uint8Array) {
          size = value.byteLength;
          const digest = await crypto.subtle.digest('SHA-256', value.slice().buffer);
          hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
        }
        out.bundles[storeName].push({ key, size, hash });
      }
    }
    db.close();
    return out;
  });
}

async function openVault(page) {
  await page.goto(BASE);
  await page.getByRole('button', { name: /합성 금고 만들기|저장된 합성 금고 열기/ }).first().click();
  await page.getByText('열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.').waitFor({ timeout: 15000 });
}

function record(name, status, evidence) {
  RESULT.scenarios.push({ name, status, evidence });
  console.log(`${status} ${name}${evidence ? ' — ' + evidence : ''}`);
}

const browser = await chromium.launch();
const context = await browser.newContext();
const ua = await (await context.newPage()).evaluate(() => navigator.userAgent);
console.log('UA:', ua);

// S1: quota save failure preserves archive, shows error UI, vault reopens afterwards
{
  const page = await context.newPage();
  try {
    await openVault(page);
    const before = await readVaultRecord(page);
    await page.evaluate(() => {
      IDBObjectStore.prototype.put = function () {
        throw new DOMException('private browser diagnostic', 'QuotaExceededError');
      };
    });
    await page.getByRole('button', { name: '진행만 암호화 저장' }).click();
    await page.waitForTimeout(2500);
    const after = await readVaultRecord(page);
    const bodyText = await page.locator('body').innerText();
    const errorShown = bodyText.includes('작업을 확인하지 못했습니다 (quota)');
    const bb = before.bundles.bundle?.[0], ab = after.bundles.bundle?.[0];
    const preserved = bb && ab && bb.hash === ab.hash && bb.size === ab.size;
    await page.reload();
    await page.getByRole('button', { name: /합성 금고 만들기|저장된 합성 금고 열기/ }).first().click();
    await page.getByText('열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.').waitFor({ timeout: 15000 });
    const recovered = await readVaultRecord(page);
    const rb = recovered.bundles.bundle?.[0];
    const reopened = rb && rb.hash === bb.hash;
    if (preserved && errorShown && reopened) record('S1-quota-save-failure-preserves-archive', 'PASS', `bytes ${bb.size}, hash ${bb.hash.slice(0, 12)}…, UI 오류 표시, 재열기 성공`);
    else record('S1-quota-save-failure-preserves-archive', 'FAIL', `preserved=${preserved} errorShown=${errorShown} reopened=${reopened}`);
  } catch (e) { record('S1-quota-save-failure-preserves-archive', 'FAIL', String(e.message)); }
  await page.close();
}

// S2: lock removes entry details; reload stays locked; reopen restores
{
  const page = await context.newPage();
  try {
    await openVault(page);
    const before = await readVaultRecord(page);
    await page.getByRole('button', { name: '잠그기 / 작업 취소' }).click();
    await page.getByText('잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.').waitFor({ timeout: 10000 });
    const lockedText = await page.locator('body').innerText();
    const detailsRemoved = !/Example Workshop API Credential/.test(lockedText);
    const after = await readVaultRecord(page);
    const archiveKept = before.bundles.bundle?.[0]?.hash === after.bundles.bundle?.[0]?.hash;
    await page.reload();
    await page.waitForTimeout(1200);
    const reloadText = await page.locator('body').innerText();
    const startsLocked = !/Example Workshop API Credential/.test(reloadText);
    await page.getByRole('button', { name: /합성 금고 만들기|저장된 합성 금고 열기/ }).first().click();
    await page.getByText('열림 · 저장된 암호문에서 3개 합성 항목을 인증하고 복원했습니다.').waitFor({ timeout: 15000 });
    const reopenText = await page.locator('body').innerText();
    const reopenRestores = /Example Workshop API Credential · 예시 1/.test(reopenText);
    if (detailsRemoved && archiveKept && startsLocked && reopenRestores) record('S2-lock-clears-screen-and-reloads-locked', 'PASS', '항목 상세 제거, 암호문 유지, 새로고침 후 잠김, 재열기 복원');
    else record('S2-lock-clears-screen-and-reloads-locked', 'FAIL', `detailsRemoved=${detailsRemoved} archiveKept=${archiveKept} startsLocked=${startsLocked} reopenRestores=${reopenRestores}`);
  } catch (e) { record('S2-lock-clears-screen-and-reloads-locked', 'FAIL', String(e.message)); }
  await page.close();
}

// S3: keyboard lock via Enter; tab order excludes vault controls while locked
{
  const page = await context.newPage();
  try {
    await openVault(page);
    const lockBtn = page.getByRole('button', { name: '잠그기 / 작업 취소' });
    await lockBtn.focus();
    await page.keyboard.press('Enter');
    await page.getByText('잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.').waitFor({ timeout: 10000 });
    let reached = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const t = await page.evaluate(() => document.activeElement?.textContent?.slice(0, 30) || '');
      reached.push(t);
    }
    const leak = reached.some((t) => /진행만 암호화 저장|저장한 교체 최종 확인|선택한 합성 항목 저장|예시 \d/.test(t));
    if (!leak) record('S3-keyboard-lock-and-tab-order', 'PASS', 'Enter로 잠금, Tab 순회 시 금고 컨트롤 미노출');
    else record('S3-keyboard-lock-and-tab-order', 'FAIL', `focus leak: ${reached.filter(Boolean).join(' | ')}`);
  } catch (e) { record('S3-keyboard-lock-and-tab-order', 'FAIL', String(e.message)); }
  await page.close();
}

// S4: mobile viewport 360px, unlocked and locked, no horizontal overflow
{
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 360, height: 800 });
    await openVault(page);
    const m1 = await page.evaluate(() => ({ c: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
    await page.getByRole('button', { name: '잠그기 / 작업 취소' }).click();
    await page.getByText('잠김 · 저장된 암호문은 그대로 두고 화면 내용을 비웠습니다.').waitFor({ timeout: 10000 });
    const m2 = await page.evaluate(() => ({ c: document.documentElement.clientWidth, s: document.documentElement.scrollWidth }));
    if (m1.s <= m1.c && m2.s <= m2.c) record('S4-mobile-viewport-360px', 'PASS', `unlocked ${m1.s}/${m1.c}, locked ${m2.s}/${m2.c}`);
    else record('S4-mobile-viewport-360px', 'FAIL', `overflow unlocked ${m1.s}>${m1.c} or locked ${m2.s}>${m2.c}`);
  } catch (e) { record('S4-mobile-viewport-360px', 'FAIL', String(e.message)); }
  await page.close();
}

// S5: upgrade failure (DB version higher than expected) leaves archive intact
{
  const page = await context.newPage();
  try {
    await openVault(page);
    const before = await readVaultRecord(page);
    // Delete the database and recreate it at a HIGHER version with the same archive bytes,
    // then verify the app reports 'incompatible' and does NOT delete or migrate data.
    const mutated = await page.evaluate(async (archiveBytes) => {
      // read current archive
      const dbs = (await indexedDB.databases()).map((d) => d.name).filter((n) => n && n.includes('keyatlas'));
      const name = dbs[0];
      let archive = null;
      {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        const tx = db.transaction('bundle', 'readonly');
        const req = tx.objectStore('bundle').getAll();
        archive = await new Promise((res) => { req.onsuccess = () => res(req.result[0]); });
        db.close();
      }
      // delete
      await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
      // recreate at higher version with archive and an extra object store
      await new Promise((res, rej) => {
        const r = indexedDB.open(name, 99);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('bundle')) db.createObjectStore('bundle');
          if (!db.objectStoreNames.contains('future-store')) db.createObjectStore('future-store');
        };
        r.onsuccess = () => { const db = r.result; db.close(); res(); };
        r.onerror = () => rej(r.error);
      });
      // put archive back
      await new Promise((res, rej) => {
        const r = indexedDB.open(name, 99);
        r.onsuccess = () => {
          const db = r.result;
          const tx = db.transaction('bundle', 'readwrite');
          const req = tx.objectStore('bundle').put(archive, 'archive');
          req.onsuccess = () => { db.close(); res(); };
          req.onerror = () => rej(req.error);
        };
        r.onerror = () => rej(r.error);
      });
      return true;
    });
    if (!mutated) throw new Error('mutation failed');
    await page.reload();
    await page.getByRole('button', { name: /합성 금고 만들기|저장된 합성 금고 열기/ }).first().click();
    await page.waitForTimeout(2500);
    const bodyText = await page.locator('body').innerText();
    const incompatibleShown = bodyText.includes('incompatible');
    const afterDb = await page.evaluate(async () => {
      const dbs = (await indexedDB.databases()).map((d) => ({ name: d.name, version: d.version }));
      return dbs;
    });
    const after = await readVaultRecord(page);
    const ab = after.bundles?.bundle?.[0];
    const archiveIntact = ab && ab.hash === before.bundles.bundle?.[0]?.hash;
    const versionKept = afterDb.some((d) => d.name === 'keyatlas-synthetic-vault-v1' && d.version === 99);
    if (incompatibleShown && archiveIntact && versionKept) record('S5-upgrade-failure-preserves-archive', 'PASS', `incompatible 표시, 암호문 유지(${ab.hash.slice(0,12)}…), DB 버전 99 유지`);
    else record('S5-upgrade-failure-preserves-archive', 'FAIL', `incompatibleShown=${incompatibleShown} archiveIntact=${archiveIntact} versionKept=${versionKept}`);
  } catch (e) { record('S5-upgrade-failure-preserves-archive', 'FAIL', String(e.message)); }
  await page.close();
}

fs.writeFileSync('/tmp/m05a-qa/final-report.json', JSON.stringify(RESULT, null, 2));
console.log('=== FINAL ===');
for (const s of RESULT.scenarios) console.log(`${s.status} ${s.name}`);
await browser.close();
