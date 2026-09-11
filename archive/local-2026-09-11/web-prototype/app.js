"use strict";

const TYPE_META = {
  account: { label: "LOGIN", color: "#73a9ff" },
  api: { label: "API KEY", color: "#ff6b35" },
  database: { label: "DATABASE", color: "#c8f04a" },
  mcp: { label: "MCP", color: "#ef9fdb" }
};

const entries = [
  {
    id: "github-personal",
    service: "GitHub",
    initials: "GH",
    account: "atlas.dev@example.test",
    project: "KeyAtlas",
    environment: "Development",
    type: "account",
    secret: "demo_ghp_A7k2x9Qm4SyntheticOnly",
    lastUsed: "방금 전",
    order: 8,
    risk: 0,
    color: "#242c29"
  },
  {
    id: "openai-dev",
    service: "OpenAI",
    initials: "OA",
    account: "proj_demo_keyatlas",
    project: "KeyAtlas AI",
    environment: "Development",
    type: "api",
    secret: "sk-demo-oai_9Lm3SyntheticNotValid",
    lastUsed: "12분 전",
    order: 7,
    risk: 0,
    color: "#117d66"
  },
  {
    id: "neon-staging",
    service: "Neon",
    initials: "NE",
    account: "atlas_owner_demo",
    project: "Vault Sync",
    environment: "Staging",
    type: "database",
    secret: "postgresql://demo:synthetic@localhost/keyatlas",
    lastUsed: "어제",
    order: 6,
    risk: 1,
    color: "#38b889"
  },
  {
    id: "cloudflare-pages",
    service: "Cloudflare",
    initials: "CF",
    account: "preview@example.test",
    project: "Web Preview",
    environment: "Staging",
    type: "api",
    secret: "cf_demo_41ab7SyntheticTokenOnly",
    lastUsed: "2일 전",
    order: 5,
    risk: 0,
    color: "#f48120"
  },
  {
    id: "figma-team",
    service: "Figma",
    initials: "FI",
    account: "design@example.test",
    project: "Design System",
    environment: "Personal",
    type: "account",
    secret: "Synthetic-Passphrase-47!Demo",
    lastUsed: "4일 전",
    order: 4,
    risk: 0,
    color: "#a259ff"
  },
  {
    id: "github-mcp",
    service: "GitHub MCP",
    initials: "GM",
    account: "local-demo-connector",
    project: "Agent Lab",
    environment: "Development",
    type: "mcp",
    secret: "mcp_demo_local_transport_no_real_token",
    lastUsed: "6일 전",
    order: 3,
    risk: 1,
    color: "#3867d6"
  },
  {
    id: "anthropic-lab",
    service: "Anthropic",
    initials: "AN",
    account: "workspace_demo",
    project: "Prompt Lab",
    environment: "Development",
    type: "api",
    secret: "sk-ant-demo-83xSyntheticNotValid",
    lastUsed: "1주 전",
    order: 2,
    risk: 0,
    color: "#d97757"
  },
  {
    id: "notion-account",
    service: "Notion",
    initials: "NO",
    account: "notes@example.test",
    project: "Learning Log",
    environment: "Personal",
    type: "account",
    secret: "DemoOnly-NotARealPassword-2026",
    lastUsed: "2주 전",
    order: 1,
    risk: 1,
    color: "#161c1a"
  }
];

const state = {
  filter: "all",
  search: "",
  sort: "recent",
  selectedId: null,
  revealId: null,
  revealSeconds: 0,
  unlocked: false,
  remainingSeconds: 300
};

const lockScreen = document.querySelector("#lockScreen");
const vaultApp = document.querySelector("#vaultApp");
const entryList = document.querySelector("#entryList");
const emptyState = document.querySelector("#emptyState");
const detailPanel = document.querySelector("#detailPanel");
const pageOverlay = document.querySelector("#pageOverlay");
const sidebar = document.querySelector("#sidebar");
const menuButton = document.querySelector("#menuButton");
const entryDialog = document.querySelector("#entryDialog");
const entryForm = document.querySelector("#entryForm");
const toast = document.querySelector("#toast");
const searchInput = document.querySelector("#vaultSearch");
const sortSelect = document.querySelector("#sortEntries");
const countdown = document.querySelector("#lockCountdown");

let toastTimer = null;
let revealTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 2400);
}

function typeMeta(type) {
  return TYPE_META[type] || TYPE_META.account;
}

function visibleEntries() {
  const needle = state.search.trim().toLocaleLowerCase("ko");
  const filtered = entries.filter((entry) => {
    const matchesType = state.filter === "all" || entry.type === state.filter;
    const haystack = [entry.service, entry.account, entry.project, entry.environment, typeMeta(entry.type).label]
      .join(" ")
      .toLocaleLowerCase("ko");
    return matchesType && (!needle || haystack.includes(needle));
  });

  return filtered.sort((a, b) => {
    if (state.sort === "name") return a.service.localeCompare(b.service, "ko");
    if (state.sort === "risk") return b.risk - a.risk || b.order - a.order;
    return b.order - a.order;
  });
}

function updateMetrics() {
  document.querySelector("#totalMetric").textContent = String(entries.length).padStart(2, "0");
  document.querySelector("#projectMetric").textContent = String(new Set(entries.map((entry) => entry.project)).size).padStart(2, "0");

  document.querySelectorAll("[data-count]").forEach((element) => {
    const type = element.dataset.count;
    element.textContent = type === "all"
      ? entries.length
      : entries.filter((entry) => entry.type === type).length;
  });
}

function renderEntries() {
  const filtered = visibleEntries();
  entryList.replaceChildren();
  emptyState.hidden = filtered.length !== 0;

  filtered.forEach((entry) => {
    const meta = typeMeta(entry.type);
    const row = document.createElement("button");
    row.type = "button";
    row.className = `entry-row${state.selectedId === entry.id ? " is-selected" : ""}`;
    row.dataset.id = entry.id;
    row.setAttribute("aria-label", `${entry.service} ${entry.account} 상세 보기`);
    row.innerHTML = `
      <span class="service-cell">
        <span class="service-icon" style="--service-color:${escapeHtml(entry.color)}">${escapeHtml(entry.initials)}</span>
        <span class="service-text">
          <strong>${escapeHtml(entry.service)}</strong>
          <small>${escapeHtml(entry.account)}</small>
        </span>
      </span>
      <span class="project-cell">
        <strong>${escapeHtml(entry.project)}</strong>
        <small>${escapeHtml(entry.environment)}</small>
      </span>
      <span class="type-badge" style="--type-color:${meta.color}">${meta.label}</span>
      <span class="last-used">${escapeHtml(entry.lastUsed)}</span>
      <span class="row-arrow" aria-hidden="true">&#8250;</span>
    `;
    row.addEventListener("click", () => selectEntry(entry.id));
    entryList.append(row);
  });
}

function maskedSecret(secret) {
  const length = Math.min(Math.max(secret.length, 18), 30);
  return "\u2022".repeat(length);
}

function renderDetail() {
  const entry = entries.find((item) => item.id === state.selectedId);
  if (!entry) {
    detailPanel.innerHTML = `
      <button class="detail-close" id="detailClose" type="button" aria-label="상세 패널 닫기">&#215;</button>
      <div class="detail-placeholder">
        <span class="placeholder-compass" aria-hidden="true">&#10022;</span>
        <strong>항목을 선택하세요</strong>
        <p>지도에서 좌표를 고르면 세부 정보가 여기에 표시됩니다.</p>
      </div>`;
    bindDetailClose();
    return;
  }

  const meta = typeMeta(entry.type);
  const isRevealed = state.revealId === entry.id && state.revealSeconds > 0;
  detailPanel.innerHTML = `
    <button class="detail-close" id="detailClose" type="button" aria-label="상세 패널 닫기">&#215;</button>
    <div class="detail-content">
      <div class="detail-service">
        <span class="service-icon" style="--service-color:${escapeHtml(entry.color)}">${escapeHtml(entry.initials)}</span>
        <div>
          <h3>${escapeHtml(entry.service)}</h3>
          <p><span class="type-badge" style="--type-color:${meta.color}">${meta.label}</span></p>
        </div>
      </div>
      <div class="detail-path">VAULT / ${escapeHtml(entry.project.toUpperCase())} / ${escapeHtml(entry.environment.toUpperCase())}</div>
      <div class="detail-field">
        <label>ACCOUNT IDENTIFIER</label>
        <div class="field-value">
          <span>${escapeHtml(entry.account)}</span>
          <span class="field-actions"><button class="mini-button" type="button" data-copy="account">복사</button></span>
        </div>
      </div>
      <div class="detail-field">
        <label>SECRET VALUE</label>
        <div class="field-value">
          <span>${isRevealed ? escapeHtml(entry.secret) : maskedSecret(entry.secret)}</span>
          <span class="field-actions">
            <button class="mini-button" type="button" data-reveal>${isRevealed ? `${state.revealSeconds}초` : "보기"}</button>
            <button class="mini-button" type="button" data-copy="secret">복사</button>
          </span>
        </div>
      </div>
      <div class="detail-meta">
        <div><span>ENVIRONMENT</span><strong>${escapeHtml(entry.environment)}</strong></div>
        <div><span>LAST USED</span><strong>${escapeHtml(entry.lastUsed)}</strong></div>
      </div>
      <div class="detail-demo-label"><span aria-hidden="true">&#9679;</span> 이 값은 작동하지 않는 합성 예시입니다. 실제 자격증명 저장용으로 사용하지 마세요.</div>
    </div>`;

  bindDetailClose();
  detailPanel.querySelector("[data-reveal]").addEventListener("click", () => toggleReveal(entry.id));
  detailPanel.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => copyValue(button.dataset.copy === "secret" ? entry.secret : entry.account));
  });
}

function bindDetailClose() {
  const closeButton = detailPanel.querySelector("#detailClose");
  if (closeButton) closeButton.addEventListener("click", closeDetail);
}

function selectEntry(id) {
  state.selectedId = id;
  stopReveal();
  renderEntries();
  renderDetail();
  if (window.matchMedia("(max-width: 960px)").matches) {
    detailPanel.classList.add("is-open");
    pageOverlay.hidden = false;
  }
}

function closeDetail() {
  detailPanel.classList.remove("is-open");
  if (!sidebar.classList.contains("is-open")) pageOverlay.hidden = true;
}

function stopReveal() {
  window.clearInterval(revealTimer);
  revealTimer = null;
  state.revealId = null;
  state.revealSeconds = 0;
}

function toggleReveal(id) {
  if (state.revealId === id && state.revealSeconds > 0) {
    stopReveal();
    renderDetail();
    return;
  }

  stopReveal();
  state.revealId = id;
  state.revealSeconds = 8;
  renderDetail();
  revealTimer = window.setInterval(() => {
    state.revealSeconds -= 1;
    if (state.revealSeconds <= 0) stopReveal();
    renderDetail();
  }, 1000);
}

async function copyValue(value) {
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    const helper = document.createElement("textarea");
    helper.value = value;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast("합성 예시 값이 클립보드에 복사되었습니다.");
}

function openSidebar() {
  sidebar.classList.add("is-open");
  menuButton.setAttribute("aria-expanded", "true");
  pageOverlay.hidden = false;
}

function closeSidebar() {
  sidebar.classList.remove("is-open");
  menuButton.setAttribute("aria-expanded", "false");
  if (!detailPanel.classList.contains("is-open")) pageOverlay.hidden = true;
}

function enterVault() {
  state.unlocked = true;
  state.remainingSeconds = 300;
  lockScreen.hidden = true;
  vaultApp.hidden = false;
  vaultApp.setAttribute("aria-hidden", "false");
  renderEntries();
  renderDetail();
  updateMetrics();
  window.setTimeout(() => searchInput.focus(), 120);
}

function lockVault(reason = "금고를 잠갔습니다.") {
  state.unlocked = false;
  state.selectedId = null;
  state.search = "";
  searchInput.value = "";
  stopReveal();
  closeDetail();
  closeSidebar();
  vaultApp.hidden = true;
  vaultApp.setAttribute("aria-hidden", "true");
  lockScreen.hidden = false;
  showToast(reason);
}

function resetAutoLock() {
  if (state.unlocked) state.remainingSeconds = 300;
}

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function updateAutoLock() {
  if (!state.unlocked) return;
  state.remainingSeconds -= 1;
  countdown.textContent = formatTime(Math.max(0, state.remainingSeconds));
  if (state.remainingSeconds <= 0) lockVault("활동이 없어 데모 금고가 자동으로 잠겼습니다.");
}

function openDialog() {
  if (typeof entryDialog.showModal === "function") entryDialog.showModal();
  else entryDialog.setAttribute("open", "");
  window.setTimeout(() => entryForm.elements.service.focus(), 80);
}

function closeDialog() {
  if (typeof entryDialog.close === "function") entryDialog.close();
  else entryDialog.removeAttribute("open");
  entryForm.reset();
}

function addSyntheticEntry(event) {
  event.preventDefault();
  const form = new FormData(entryForm);
  const service = String(form.get("service") || "Demo").trim();
  const account = String(form.get("account") || "demo@example.test").trim();
  const project = String(form.get("project") || "Demo Project").trim();
  const type = String(form.get("type") || "account");
  const environment = String(form.get("environment") || "Development");
  const id = `session-${Date.now()}`;

  entries.unshift({
    id,
    service,
    initials: service.replace(/[^a-zA-Z0-9가-힣]/g, "").slice(0, 2).toUpperCase() || "DE",
    account,
    project,
    environment,
    type,
    secret: `demo_${type}_${Math.random().toString(36).slice(2, 12)}_synthetic`,
    lastUsed: "방금 추가",
    order: entries.length + 10,
    risk: 0,
    color: "#467566"
  });

  state.filter = "all";
  state.search = "";
  searchInput.value = "";
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("is-active", item.dataset.filter === "all"));
  closeDialog();
  updateMetrics();
  selectEntry(id);
  showToast("합성 항목을 현재 세션에 추가했습니다.");
}

document.querySelector("#enterVault").addEventListener("click", enterVault);
document.querySelector("#lockVault").addEventListener("click", () => lockVault());
document.querySelector("#addEntry").addEventListener("click", openDialog);
document.querySelector("#dialogClose").addEventListener("click", closeDialog);
document.querySelector("#dialogCancel").addEventListener("click", closeDialog);
entryForm.addEventListener("submit", addSyntheticEntry);

document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    state.filter = item.dataset.filter;
    document.querySelectorAll(".nav-item").forEach((navItem) => navItem.classList.toggle("is-active", navItem === item));
    renderEntries();
    closeSidebar();
  });
});

searchInput.addEventListener("input", () => {
  state.search = searchInput.value;
  renderEntries();
});

sortSelect.addEventListener("change", () => {
  state.sort = sortSelect.value;
  renderEntries();
});

menuButton.addEventListener("click", () => {
  if (sidebar.classList.contains("is-open")) closeSidebar();
  else openSidebar();
});

pageOverlay.addEventListener("click", () => {
  closeSidebar();
  closeDetail();
});

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && state.unlocked) {
    event.preventDefault();
    searchInput.focus();
  }
  if (event.key === "Escape") {
    closeSidebar();
    closeDetail();
  }
  resetAutoLock();
});

document.addEventListener("pointerdown", resetAutoLock, { passive: true });
window.setInterval(updateAutoLock, 1000);
updateMetrics();
