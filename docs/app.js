// weread-dashboard frontend

// ===== Config =====
const DEFAULT_API_BASE = "https://weread-dashboard.huangxindi2002.workers.dev";
const STORAGE_KEYS = {
  apiBase: "wd_api_base",
  dashboard: "wd_dashboard_cache",
  chat: "wd_chat_history",
};

function getApiBase() {
  return localStorage.getItem(STORAGE_KEYS.apiBase) || DEFAULT_API_BASE;
}
function setApiBase(url) {
  localStorage.setItem(STORAGE_KEYS.apiBase, url);
}

// ===== Utils =====
function $(id) { return document.getElementById(id); }
function show(el) { el.classList.remove("hidden"); }
function hide(el) { el.classList.add("hidden"); }
function fmtDate(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fmtDuration(sec) {
  if (!sec || sec < 60) return "<1分钟";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h === 0) return `${m}分钟`;
  if (m === 0) return `${h}小时`;
  return `${h}小时${m}分钟`;
}
function fmtRelative(ts) {
  if (!ts) return "";
  const diff = (Date.now() - ts * 1000) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}天前`;
  return fmtDate(ts);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ===== Settings modal =====
function openSettings() {
  $("setting-api-base").value = getApiBase();
  show($("settings-modal"));
}
function closeSettings() { hide($("settings-modal")); }

$("settings-btn").onclick = openSettings;
$("setting-cancel").onclick = closeSettings;
$("setting-save").onclick = () => {
  const v = $("setting-api-base").value.trim().replace(/\/$/, "");
  setApiBase(v);
  closeSettings();
  loadDashboard(true);
};

// ===== Dashboard =====
async function fetchDashboard() {
  const base = getApiBase();
  if (!base) {
    openSettings();
    throw new Error("请先设置 Worker API 地址");
  }
  const res = await fetch(`${base}/api/dashboard`);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return await res.json();
}

async function loadDashboard(forceRefresh = false) {
  const btn = $("refresh-btn");
  const cached = localStorage.getItem(STORAGE_KEYS.dashboard);
  if (cached && !forceRefresh) {
    try {
      render(JSON.parse(cached));
    } catch (e) { /* ignore */ }
  }
  if (!getApiBase()) { openSettings(); return; }

  btn.disabled = true;
  btn.textContent = "拉取中...";
  try {
    const data = await fetchDashboard();
    localStorage.setItem(STORAGE_KEYS.dashboard, JSON.stringify(data));
    render(data);
  } catch (e) {
    alert("拉取失败: " + e.message);
    console.error(e);
  } finally {
    btn.disabled = false;
    btn.textContent = "刷新数据";
  }
}

function render(data) {
  hide($("empty-state"));
  show($("view-tabs"));
  $("last-updated").textContent = "上次更新 " + fmtRelative(data.updatedAt / 1000);

  // ----- books tab data -----
  lastShelf = data.shelf || null;
  const allItems = (lastShelf && lastShelf.allItems) || [];
  $("view-books-count").textContent = allItems.length ? `(${allItems.length})` : "";
  renderBooksList();

  // ----- overview -----
  show($("overview"));
  const ys = data.yearStat || {};
  $("stat-total-time").textContent = fmtDuration(ys.totalReadTime || 0);
  $("stat-total-time-sub").textContent = `${data.year} 年`;
  $("stat-days").textContent = `${ys.readDays || 0} 天`;
  if (ys.compare != null) {
    const pct = Math.round(ys.compare * 100);
    $("stat-days-sub").textContent = pct >= 0 ? `较去年 +${pct}%` : `较去年 ${pct}%`;
  }
  const readStat = ys.readStat || [];
  const read = readStat.find((s) => s.stat === "读过")?.counts || "";
  const finish = readStat.find((s) => s.stat === "读完")?.counts || "";
  $("stat-books").textContent = read || "—";
  $("stat-books-sub").textContent = finish ? `读完 ${finish}` : "";
  $("stat-avg").textContent = fmtDuration(ys.dayAverageReadTime || 0);
  $("stat-avg-sub").textContent = "日均(全年自然日)";

  // ----- heatmap -----
  show($("heatmap-section"));
  $("heatmap-year-label").textContent = `${data.year}`;
  renderHeatmap(data.dailyHeatmap || {}, data.year);

  // ----- current book -----
  if (data.currentBook) {
    show($("current-book-section"));
    const cb = data.currentBook;
    const prog = cb.progress || {};
    const progPct = prog.progress || 0;
    $("current-book").innerHTML = `
      <img src="${escapeHtml(cb.cover || "")}" alt="" data-book-id="${escapeHtml(cb.bookId)}" data-book-tab="summary" style="cursor:pointer" title="点击查看你对这本书的理解" onerror="this.style.opacity=0" />
      <div>
        <h3 data-book-id="${escapeHtml(cb.bookId)}" data-book-tab="summary" title="点击查看你对这本书的理解">${escapeHtml(cb.title || "")}</h3>
        <div class="meta">${escapeHtml(cb.author || "")} · ${escapeHtml(cb.category || "")}</div>
        ${prog.chapterTitle ? `<div class="meta">读到: ${escapeHtml(prog.chapterTitle)}</div>` : ""}
        <div class="meta">上次阅读 ${fmtRelative(cb.readUpdateTime)}</div>
        <div class="progress-bar"><div class="progress-fill" style="width:${progPct}%"></div></div>
        <div class="meta" style="margin-top:4px">${progPct}%</div>
        <div class="meta" style="margin-top:8px">
          <a href="weread://reading?bId=${cb.bookId}" target="_blank">📖 继续阅读</a>
        </div>
      </div>
    `;
  }

  // ----- top books -----
  if (ys.readLongest && ys.readLongest.length) {
    show($("top-books-section"));
    $("top-books").innerHTML = ys.readLongest.map((b, i) => `
      <li data-book-id="${escapeHtml(b.bookId || "")}" data-book-tab="summary" title="点击查看你对这本书的理解">
        <span class="rank">${i + 1}</span>
        <span>
          <div>${escapeHtml(b.title || "")}</div>
          <div class="meta">${escapeHtml(b.author || "")}</div>
        </span>
        <span class="time">${fmtDuration(b.readTime || 0)}</span>
      </li>
    `).join("");
  }

  // ----- highlights -----
  if (data.recentHighlights && data.recentHighlights.items && data.recentHighlights.items.length) {
    show($("highlights-section"));
    const rh = data.recentHighlights;
    $("highlights-book-label").textContent = `${rh.title || ""} · ${rh.author || ""}`;
    const chMap = {};
    (rh.chapters || []).forEach((c) => { chMap[c.chapterUid] = c.title; });
    $("highlights").innerHTML = rh.items.map((h) => {
      const [rs, re] = (h.range || "0-0").split("-");
      const link = `weread://bestbookmark?bookId=${rh.bookId}&chapterUid=${h.chapterUid}&rangeStart=${rs}&rangeEnd=${re}`;
      return `
        <li>
          <div class="hl-text">${escapeHtml(h.markText || "")}</div>
          <div class="hl-meta">
            ${escapeHtml(chMap[h.chapterUid] || "")} · ${fmtDate(h.createTime)}
            · <a href="${link}" target="_blank">在 App 中打开</a>
          </div>
        </li>
      `;
    }).join("");
  }

  // ----- notebooks -----
  if (data.notebooks && data.notebooks.recentBooks && data.notebooks.recentBooks.length) {
    show($("notebooks-section"));
    const nb = data.notebooks;
    $("notebooks-total").textContent = `共 ${nb.totalBookCount} 本笔记书 / ${nb.totalNoteCount} 条笔记`;
    $("notebooks").innerHTML = nb.recentBooks.map((b) => `
      <div class="notebook-card" data-book-id="${escapeHtml(b.bookId)}" data-book-tab="summary">
        <img src="${escapeHtml(b.cover || "")}" alt="" onerror="this.style.opacity=0.3" />
        <div class="nb-info">
          <div class="nb-title">${escapeHtml(b.title || "")}</div>
          <div class="nb-author">${escapeHtml(b.author || "")}</div>
          <div class="nb-counts">${b.noteCount}笔记 · ${b.bookmarkCount}划线 · ${b.readingProgress}%</div>
        </div>
      </div>
    `).join("");
  }

  // ----- unfinished books -----
  if (data.unfinishedBooks && data.unfinishedBooks.length) {
    show($("unfinished-section"));
    $("unfinished").innerHTML = data.unfinishedBooks.map((b) => `
      <div class="notebook-card" data-book-id="${escapeHtml(b.bookId)}" data-book-tab="footprint">
        <img src="${escapeHtml(b.cover || "")}" alt="" onerror="this.style.opacity=0.3" />
        <div class="nb-info">
          <div class="nb-title">${escapeHtml(b.title || "")}</div>
          <div class="nb-author">${escapeHtml(b.author || "")}</div>
          <div class="nb-counts">${b.progress != null ? b.progress + "%" : "—"} · 上次 ${fmtRelative(b.readUpdateTime)}</div>
          ${b.readingTime ? `<div class="nb-progress">累计 ${fmtDuration(b.readingTime)}</div>` : ""}
        </div>
      </div>
    `).join("");
  }

  // ----- prefer category -----
  if (ys.preferCategory && ys.preferCategory.length) {
    show($("prefer-section"));
    $("prefer-category").innerHTML = ys.preferCategory.map((c) => `
      <span class="prefer-tag">
        ${escapeHtml(c.categoryTitle || "")}
        <span class="pc-time">${fmtDuration(c.readingTime || 0)} · ${c.readingCount || 0}本</span>
      </span>
    `).join("");
  }
}

// ===== Heatmap =====
function renderHeatmap(dailyMap, year) {
  // dailyMap: { unix_ts_string: seconds }
  // Build map keyed by YYYY-MM-DD for easy lookup
  const byDate = {};
  let maxVal = 0;
  for (const [ts, sec] of Object.entries(dailyMap)) {
    const d = new Date(parseInt(ts, 10) * 1000);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    byDate[k] = sec;
    if (sec > maxVal) maxVal = sec;
  }
  const buckets = [0, 600, 1800, 3600, 7200]; // 0, 10m, 30m, 1h, 2h
  function level(sec) {
    if (!sec || sec < buckets[0] + 1) return 0;
    if (sec < buckets[1]) return 1;
    if (sec < buckets[2]) return 2;
    if (sec < buckets[3]) return 3;
    return 4;
  }

  const container = $("heatmap");
  container.innerHTML = "";

  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  // Pad start to a Monday-based week column (or Sunday-based — using Sunday=0)
  const startDay = start.getDay(); // 0=Sun
  const totalDays = Math.floor((end - start) / 86400000) + 1 + startDay;
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let i = 0; i <= Math.floor((end - start) / 86400000); i++) {
    const d = new Date(year, 0, 1 + i);
    cells.push(d);
  }
  // Pad to multiple of 7
  while (cells.length % 7 !== 0) cells.push(null);

  cells.forEach((d) => {
    const cell = document.createElement("span");
    cell.className = "hm-cell";
    if (d) {
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const sec = byDate[k] || 0;
      cell.classList.add(`hm-l${level(sec)}`);
      cell.title = `${k} · ${sec ? fmtDuration(sec) : "无阅读"}`;
    } else {
      cell.style.opacity = 0;
    }
    container.appendChild(cell);
  });
}

// ===== Chat =====
function loadChatHistory() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.chat) || "[]"); }
  catch { return []; }
}
function saveChatHistory(messages) {
  localStorage.setItem(STORAGE_KEYS.chat, JSON.stringify(messages));
}
function renderChatMessages() {
  const messages = loadChatHistory();
  const c = $("chat-messages");
  if (!messages.length) {
    c.innerHTML = `
      <div class="chat-tip">
        <p>试试问我:</p>
        <ul>
          <li>我这周读了多久?</li>
          <li>今年我读完了几本书?</li>
          <li>把《苏东坡新传》里的最近划线给我</li>
          <li>给我推荐一本类似《万寿寺》的书</li>
        </ul>
      </div>
    `;
    return;
  }
  c.innerHTML = messages.map((m) => {
    if (m.role === "user") {
      const text = typeof m.content === "string" ? m.content : "";
      return `<div class="chat-msg user">${escapeHtml(text)}</div>`;
    }
    if (m.role === "assistant" && typeof m.content === "string") {
      return `<div class="chat-msg assistant">${escapeHtml(m.content)}</div>`;
    }
    // Skip tool messages in UI (we display them as compact pills only when in flight)
    return "";
  }).join("");
  c.scrollTop = c.scrollHeight;
}

function openChat() {
  show($("chat-drawer"));
  renderChatMessages();
}
function closeChat() { hide($("chat-drawer")); }

$("chat-fab").onclick = openChat;
$("chat-close").onclick = closeChat;
$("chat-clear").onclick = () => {
  if (confirm("清空对话历史?")) {
    saveChatHistory([]);
    renderChatMessages();
  }
};

$("chat-form").onsubmit = async (e) => {
  e.preventDefault();
  await sendChat();
};
$("chat-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

async function sendChat() {
  const ta = $("chat-input");
  const text = ta.value.trim();
  if (!text) return;
  const base = getApiBase();
  if (!base) { openSettings(); return; }

  // Append user message
  const ui = loadChatHistory();
  ui.push({ role: "user", content: text });
  // For API: simplified messages (string content only)
  const apiMessages = ui.map((m) => ({ role: m.role, content: m.content }));
  saveChatHistory(ui);
  renderChatMessages();
  ta.value = "";

  // Pending indicator
  const c = $("chat-messages");
  const pending = document.createElement("div");
  pending.className = "chat-msg tool";
  pending.textContent = "思考中...";
  c.appendChild(pending);
  c.scrollTop = c.scrollHeight;

  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: apiMessages }),
    });
    pending.remove();
    if (!res.ok) {
      const errText = await res.text();
      const errBox = document.createElement("div");
      errBox.className = "chat-msg error";
      errBox.textContent = `请求失败: ${res.status} ${errText.slice(0, 200)}`;
      c.appendChild(errBox);
      return;
    }
    const data = await res.json();
    const reply = data.text || "(空回复)";
    const ui2 = loadChatHistory();
    ui2.push({ role: "assistant", content: reply });
    saveChatHistory(ui2);
    renderChatMessages();
  } catch (e) {
    pending.remove();
    const errBox = document.createElement("div");
    errBox.className = "chat-msg error";
    errBox.textContent = `网络错误: ${e.message}`;
    c.appendChild(errBox);
  }
}

// ===== Book detail modal =====
const bookCache = {};

async function fetchBookEndpoint(kind, bookId) {
  const key = `${kind}:${bookId}`;
  if (bookCache[key]) return bookCache[key];
  const cached = sessionStorage.getItem("wd_book_" + key);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      bookCache[key] = parsed;
      return parsed;
    } catch {}
  }
  const base = getApiBase();
  const res = await fetch(`${base}/api/book/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  bookCache[key] = data;
  try { sessionStorage.setItem("wd_book_" + key, JSON.stringify(data)); } catch {}
  return data;
}

let currentBookId = null;
let currentBookTab = "summary";

function renderBookBody(text) {
  const paragraphs = (text || "").split(/\n\s*\n/).filter(Boolean);
  return paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
}

async function loadBookTab(bookId, tab) {
  currentBookTab = tab;
  document.querySelectorAll(".book-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  const body = $("book-modal-body");
  body.innerHTML = `<div class="loading"><div class="loading-spinner"></div><div>Claude 正在阅读你的划线和想法...</div></div>`;
  try {
    const kind = tab === "footprint" ? "footprint" : "summary";
    const data = await fetchBookEndpoint(kind, bookId);
    if (bookId !== currentBookId) return; // user navigated away
    if (data.meta) {
      // refresh modal header from server meta (in case we opened with stale data)
      if (data.meta.cover) $("book-modal-cover").src = data.meta.cover;
      if (data.meta.title) $("book-modal-title").textContent = data.meta.title;
      if (data.meta.author) $("book-modal-author").textContent = data.meta.author;
      const stats = [];
      if (data.meta.bookmarkCount != null) stats.push(`${data.meta.bookmarkCount} 条划线`);
      if (data.meta.reviewCount != null) stats.push(`${data.meta.reviewCount} 条想法`);
      if (data.meta.progress != null) stats.push(`${data.meta.progress}%`);
      $("book-modal-stats").textContent = stats.join(" · ");
    }
    body.innerHTML = renderBookBody(data.text);
  } catch (e) {
    body.innerHTML = `<div class="error">加载失败: ${escapeHtml(e.message)}</div>`;
  }
}

function openBookModal(bookId, defaultTab = "summary") {
  if (!bookId) return;
  currentBookId = bookId;
  // reset header
  $("book-modal-cover").src = "";
  $("book-modal-title").textContent = "加载中...";
  $("book-modal-author").textContent = "";
  $("book-modal-stats").textContent = "";
  $("book-modal-open").href = `weread://reading?bId=${bookId}`;
  show($("book-modal"));
  loadBookTab(bookId, defaultTab);
}

function closeBookModal() {
  currentBookId = null;
  hide($("book-modal"));
}

$("book-modal-close").onclick = closeBookModal;
$("book-modal").addEventListener("click", (e) => {
  if (e.target.id === "book-modal") closeBookModal();
});
document.querySelectorAll(".book-tab").forEach((btn) => {
  btn.onclick = () => {
    if (!currentBookId) return;
    loadBookTab(currentBookId, btn.dataset.tab);
  };
});

// Delegated click handler for any element with data-book-id
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-book-id]");
  if (!el) return;
  // Ignore clicks on inner anchor links (e.g., 继续阅读 weread://)
  if (e.target.tagName === "A") return;
  const bookId = el.dataset.bookId;
  const tab = el.dataset.bookTab || "summary";
  if (bookId) openBookModal(bookId, tab);
});

// ESC to close any open modal/drawer
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("book-modal").classList.contains("hidden")) closeBookModal();
    else if (!$("settings-modal").classList.contains("hidden")) closeSettings();
    else if (!$("chat-drawer").classList.contains("hidden")) closeChat();
  }
});

// ===== Refresh =====
$("refresh-btn").onclick = () => loadDashboard(true);

// ===== View tabs (overview / books) =====
function switchView(view) {
  document.querySelectorAll(".view-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  $("view-overview").classList.toggle("hidden", view !== "overview");
  $("view-books").classList.toggle("hidden", view !== "books");
}
document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.onclick = () => switchView(btn.dataset.view);
});

// ===== All books list =====
let lastShelf = null;

function renderBooksList() {
  const items = (lastShelf && lastShelf.allItems) || [];
  const q = ($("books-search").value || "").trim().toLowerCase();
  const filter = $("books-filter").value;
  const sortBy = $("books-sort").value;

  let rows = items.slice();
  if (filter === "finished") rows = rows.filter((b) => b.finish);
  else if (filter === "unfinished") rows = rows.filter((b) => !b.finish);
  if (q) {
    rows = rows.filter(
      (b) =>
        (b.title || "").toLowerCase().includes(q) ||
        (b.author || "").toLowerCase().includes(q),
    );
  }
  if (sortBy === "title") {
    rows.sort((a, b) => (a.title || "").localeCompare(b.title || "", "zh"));
  } else {
    rows.sort((a, b) => (b.readUpdateTime || 0) - (a.readUpdateTime || 0));
  }

  const finishedCount = items.filter((b) => b.finish).length;
  const bookCount = items.filter((b) => b.kind === "book").length;
  const albumCount = items.filter((b) => b.kind === "album").length;
  $("books-summary").textContent =
    `共 ${items.length} 本（电子书 ${bookCount} + 有声书 ${albumCount}），已读完 ${finishedCount} 本` +
    (q || filter !== "all" ? `，当前筛选 ${rows.length} 本` : "");

  if (!rows.length) {
    $("books-list").innerHTML = `<li class="books-empty muted">没有匹配的书</li>`;
    return;
  }

  $("books-list").innerHTML = rows
    .map((b, i) => {
      const tags = [];
      if (b.kind === "album") tags.push(`<span class="book-tag tag-audio">有声</span>`);
      if (b.secret) tags.push(`<span class="book-tag tag-secret">私密</span>`);
      if (b.isTop) tags.push(`<span class="book-tag tag-top">置顶</span>`);
      if (b.finish) tags.push(`<span class="book-tag tag-finish">✓已读完</span>`);
      const dataAttrs =
        b.kind === "book" && b.bookId
          ? `data-book-id="${escapeHtml(b.bookId)}" data-book-tab="summary"`
          : "";
      return `
        <li class="book-row" ${dataAttrs} ${b.kind === "book" ? 'title="点击查看你对这本书的理解"' : ""}>
          <span class="book-idx">${i + 1}</span>
          <img class="book-cover" src="${escapeHtml(b.cover || "")}" alt="" onerror="this.style.opacity=0.2" />
          <div class="book-main">
            <div class="book-title">${escapeHtml(b.title || "")}</div>
            <div class="book-sub">
              <span>${escapeHtml(b.author || "")}</span>
              ${b.category ? `<span class="muted">· ${escapeHtml(b.category)}</span>` : ""}
            </div>
            <div class="book-tags">${tags.join("")}</div>
          </div>
          <div class="book-meta-col">
            <div class="book-date">${b.readUpdateTime ? fmtDate(b.readUpdateTime) : "—"}</div>
            ${
              b.kind === "book" && b.bookId
                ? `<a class="book-open" href="weread://reading?bId=${escapeHtml(b.bookId)}" target="_blank" onclick="event.stopPropagation()">📖 打开</a>`
                : ""
            }
          </div>
        </li>
      `;
    })
    .join("");
}

["books-search", "books-filter", "books-sort"].forEach((id) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener(el.tagName === "SELECT" ? "change" : "input", renderBooksList);
});

// ===== Bootstrap =====
loadDashboard(false);
