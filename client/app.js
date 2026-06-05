// Mirror client: a multi-session reader over the local transcript index.
// Renders the user's own local transcripts, served from localhost only.

const conversation = document.getElementById("conversation");
const sessionListEl = document.getElementById("session-list");
const sideFoot = document.getElementById("side-foot");
const searchEl = document.getElementById("search");
const currentTitleEl = document.getElementById("current-title");
const statusText = document.getElementById("status-text");
const dot = document.getElementById("dot");
const themeBtn = document.getElementById("theme-toggle");
const toBottom = document.getElementById("to-bottom");
const menuBtn = document.getElementById("menu");
const sidebar = document.getElementById("sidebar");
const scrim = document.getElementById("scrim");
const root = document.documentElement;

let activeId = null; // the live session (currently being worked in the terminal)
let currentId = null; // the session being viewed (null until resolved)
let sessionsById = {};
let rendered = []; // last rendered items, for incremental reconcile
let renderedSig = [];
let lastVersion = null;
let pendingHighlight = null; // query to highlight after opening a search result
let searchTimer = null;
let searchMode = false;

// ---------- small helpers ----------
function el(tag, className, html) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}
function escapeText(text) {
  const d = document.createElement("div");
  d.textContent = text == null ? "" : String(text);
  return d.innerHTML;
}
function safeJson(v) {
  try { return JSON.stringify(v, null, 2); } catch (e) { return String(v); }
}
function md(text) {
  try { return marked.parse(text || ""); }
  catch (e) { const p = document.createElement("pre"); p.textContent = text || ""; return p.outerHTML; }
}
function relTime(epochSeconds) {
  if (!epochSeconds) return "";
  const s = Math.max(0, Date.now() / 1000 - epochSeconds);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
function setStatus(state, text) { dot.className = "dot " + state; statusText.textContent = text; }
function nearBottom() {
  return window.innerHeight + window.scrollY >= document.body.scrollHeight - 120;
}
function isViewingActive() { return currentId === null || currentId === activeId; }

// ---------- theme ----------
const SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function paintThemeIcon() { themeBtn.innerHTML = root.getAttribute("data-theme") !== "light" ? SUN : MOON; }
themeBtn.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
  root.setAttribute("data-theme", next);
  try { localStorage.setItem("mirror-theme", next); } catch (e) {}
  paintThemeIcon();
});
async function applyConfigTheme() {
  let stored = null;
  try { stored = localStorage.getItem("mirror-theme"); } catch (e) {}
  if (stored) return; // a user choice always wins
  try {
    const cfg = await (await fetch("/api/config", { cache: "no-store" })).json();
    if (cfg.theme) root.setAttribute("data-theme", cfg.theme);
  } catch (e) {}
  paintThemeIcon();
}

// ---------- session list ----------
async function loadSessions() {
  let data;
  try {
    data = await (await fetch("/api/sessions", { cache: "no-store" })).json();
  } catch (e) { return; }
  activeId = data.active;
  sessionsById = {};
  data.sessions.forEach((s) => { sessionsById[s.id] = s; });
  if (currentId === null) {
    currentId = activeId || (data.sessions[0] && data.sessions[0].id) || null;
  }
  sideFoot.textContent = data.sessions.length + " session" + (data.sessions.length === 1 ? "" : "s");
  if (!searchMode) renderSessionList(data.sessions);
  updateCurrentTitle();
}

function renderSessionList(sessions) {
  sessionListEl.innerHTML = "";
  if (!sessions.length) {
    sessionListEl.appendChild(el("div", "side-empty", "No sessions found yet."));
    return;
  }
  const groups = [];
  const seen = {};
  sessions.forEach((s) => {
    if (!seen[s.project]) { seen[s.project] = []; groups.push([s.project, seen[s.project]]); }
    seen[s.project].push(s);
  });
  groups.forEach(([project, items]) => {
    sessionListEl.appendChild(el("div", "group-head", escapeText(project)));
    items.forEach((s) => sessionListEl.appendChild(sessionItem(s)));
  });
}

function sessionItem(s) {
  const viewed = (currentId === s.id) || (currentId === null && s.id === activeId);
  const node = el("button", "session" + (viewed ? " current" : ""));
  node.type = "button";
  const title = s.title && s.title.trim() ? s.title : "(untitled session)";
  node.innerHTML =
    '<span class="s-dot' + (s.live ? " live" : "") + '"></span>' +
    '<span class="s-body"><span class="s-title">' + escapeText(title) + "</span>" +
    '<span class="s-meta">' + escapeText(relTime(s.mtime)) + " &middot; " + (s.msg_count || 0) + " msg</span></span>";
  node.addEventListener("click", () => selectSession(s.id));
  return node;
}

function updateCurrentTitle() {
  const s = sessionsById[currentId];
  if (s) {
    const title = s.title && s.title.trim() ? s.title : s.project;
    currentTitleEl.textContent = title;
    currentTitleEl.title = s.project + " / " + s.id;
  } else {
    currentTitleEl.textContent = "Mirror";
  }
}

function selectSession(id) {
  currentId = id;
  lastVersion = null;
  rendered = []; renderedSig = [];
  conversation.innerHTML = "";
  highlightCurrentInList();
  updateCurrentTitle();
  closeSidebar();
  loadConversation(true);
}

function highlightCurrentInList() {
  sessionListEl.querySelectorAll(".session").forEach((n) => n.classList.remove("current"));
  // re-render marks cheaply by matching title text is unreliable; just reload list state
  if (!searchMode) renderSessionList(Object.values(sessionsById).sort((a, b) => b.mtime - a.mtime));
}

// ---------- conversation (incremental render) ----------
function itemSig(item) {
  if (item.role === "user") {
    return item.kind === "command" ? "c:" + item.command : "u:" + (item.text || "").length + ":" + (item.text || "").slice(0, 24);
  }
  return "a:" + (item.blocks || []).map((b) =>
    b.type[0] + (b.text ? b.text.length : "") + (b.result ? "r" + b.result.length : "")
  ).join(",");
}

function renderUserNode(item, showRole) {
  const wrap = el("article", "msg user" + (showRole ? "" : " cont"));
  if (item.kind === "command") {
    wrap.appendChild(el("div", "command-chip", "&#47;" + escapeText((item.command || "").replace(/^\//, ""))));
  } else {
    if (showRole) wrap.appendChild(el("div", "role", "You"));
    wrap.appendChild(el("div", "bubble", md(item.text)));
  }
  return wrap;
}

function toolHint(input) {
  if (!input || typeof input !== "object") return "";
  const keys = ["file_path", "path", "command", "query", "url", "pattern", "description", "prompt", "skill"];
  for (const k of keys) {
    if (input[k]) { let v = String(input[k]).split("\n")[0]; if (v.length > 72) v = v.slice(0, 72) + "…"; return v; }
  }
  return "";
}

function renderToolUse(block) {
  const details = el("details", "tool");
  const hint = toolHint(block.input);
  const summary = el("summary", "tool-summary");
  summary.innerHTML = '<span class="tool-name">' + escapeText(block.name) + "</span>" +
    (hint ? '<span class="tool-hint">' + escapeText(hint) + "</span>" : "");
  details.appendChild(summary);
  const body = el("div", "tool-body");
  const input = el("div", "tool-input");
  input.appendChild(el("div", "tool-label", "input"));
  const pre = el("pre"); const code = el("code"); code.textContent = safeJson(block.input);
  pre.appendChild(code); input.appendChild(pre); body.appendChild(input);
  if (block.result) {
    const out = el("div", "tool-result");
    out.appendChild(el("div", "tool-label", "result"));
    const rpre = el("pre"); const rcode = el("code"); rcode.textContent = block.result;
    rpre.appendChild(rcode); out.appendChild(rpre); body.appendChild(out);
  }
  details.appendChild(body);
  return details;
}

function renderAssistantNode(item, showRole) {
  const wrap = el("article", "msg assistant" + (showRole ? "" : " cont"));
  if (showRole) wrap.appendChild(el("div", "role", "Claude"));
  (item.blocks || []).forEach((block) => {
    if (block.type === "text") wrap.appendChild(el("div", "bubble", md(block.text)));
    else if (block.type === "thinking") {
      const d = el("details", "thinking");
      d.appendChild(el("summary", "thinking-summary", "thinking"));
      d.appendChild(el("div", "thinking-body", md(block.text)));
      wrap.appendChild(d);
    } else if (block.type === "tool_use") wrap.appendChild(renderToolUse(block));
  });
  return wrap;
}

function renderNode(item, showRole) {
  return item.role === "user" ? renderUserNode(item, showRole) : renderAssistantNode(item, showRole);
}

function enhance(node) {
  node.querySelectorAll("pre code").forEach((c) => { try { hljs.highlightElement(c); } catch (e) {} });
  node.querySelectorAll(".bubble table").forEach((t) => {
    if (t.parentElement && t.parentElement.classList.contains("tablewrap")) return;
    const w = el("div", "tablewrap"); t.parentNode.insertBefore(w, t); w.appendChild(t);
  });
}

function reconcile(items) {
  const emptyEl = document.getElementById("empty");
  if (emptyEl) emptyEl.remove();
  const sigs = items.map(itemSig);
  // longest common prefix with what is already on screen
  let k = 0;
  while (k < renderedSig.length && k < sigs.length && renderedSig[k] === sigs[k]) k++;
  while (conversation.children.length > k) conversation.lastChild.remove();
  for (let i = k; i < items.length; i++) {
    const showRole = i === 0 || items[i].role !== items[i - 1].role;
    const node = renderNode(items[i], showRole);
    conversation.appendChild(node);
    enhance(node);
  }
  rendered = items; renderedSig = sigs;
  if (!items.length) conversation.appendChild(el("div", "empty", "This session has no readable messages yet."));
}

async function loadConversation(force) {
  const q = currentId ? "?session=" + encodeURIComponent(currentId) : "";
  let data;
  try {
    data = await (await fetch("/api/conversation" + q, { cache: "no-store" })).json();
  } catch (e) { setStatus("off", "disconnected"); return; }
  if (!force && data.version === lastVersion) return;
  const stick = !force && isViewingActive() && nearBottom();
  lastVersion = data.version;
  reconcile(data.items || []);
  if (pendingHighlight) {
    highlightInConversation(pendingHighlight);
    pendingHighlight = null;
  } else if (force) {
    window.scrollTo(0, isViewingActive() ? document.body.scrollHeight : 0);
  } else if (stick) {
    window.scrollTo(0, document.body.scrollHeight);
  }
  updateToBottom();
  setStatus(isViewingActive() ? "live" : "idle", isViewingActive() ? "live" : "viewing");
}

// ---------- search ----------
searchEl.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchEl.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 200);
});

async function runSearch(q) {
  if (!q) {
    searchMode = false;
    renderSessionList(Object.values(sessionsById).sort((a, b) => b.mtime - a.mtime));
    return;
  }
  searchMode = true;
  let data;
  try {
    data = await (await fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" })).json();
  } catch (e) { return; }
  renderSearchResults(data.results || [], q);
}

function renderSearchResults(results, q) {
  sessionListEl.innerHTML = "";
  if (!results.length) {
    sessionListEl.appendChild(el("div", "side-empty", "No matches for " + escapeText(q)));
    return;
  }
  sessionListEl.appendChild(el("div", "group-head", results.length + " result" + (results.length === 1 ? "" : "s")));
  results.forEach((r) => {
    const node = el("button", "result");
    node.type = "button";
    const title = r.title && r.title.trim() ? r.title : r.project;
    node.innerHTML =
      '<span class="r-title">' + escapeText(title) + "</span>" +
      '<span class="r-snippet">' + r.snippet + "</span>" +
      '<span class="r-meta">' + escapeText(r.project) + "</span>";
    node.addEventListener("click", () => {
      pendingHighlight = q;
      selectSession(r.session_id);
    });
    sessionListEl.appendChild(node);
  });
}

function clearHighlights() {
  conversation.querySelectorAll("mark.hit").forEach((m) => {
    const t = document.createTextNode(m.textContent);
    m.parentNode.replaceChild(t, m);
  });
}

function highlightInConversation(query) {
  clearHighlights();
  if (!query) return;
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(conversation, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      if (n.parentElement && n.parentElement.closest("script,style")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  let first = null;
  targets.forEach((textNode) => {
    const text = textNode.nodeValue;
    const frag = document.createDocumentFragment();
    let i = 0; const low = text.toLowerCase();
    let at;
    while ((at = low.indexOf(needle, i)) !== -1) {
      if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
      const mark = el("mark", "hit");
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      if (!first) first = mark;
      i = at + needle.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    textNode.parentNode.replaceChild(frag, textNode);
  });
  if (first) {
    const open = first.closest("details");
    if (open) open.open = true;
    first.scrollIntoView({ block: "center" });
  }
}

// ---------- sidebar (mobile) ----------
function openSidebar() { sidebar.classList.add("open"); scrim.classList.add("show"); }
function closeSidebar() { sidebar.classList.remove("open"); scrim.classList.remove("show"); }
menuBtn.addEventListener("click", openSidebar);
scrim.addEventListener("click", closeSidebar);

// ---------- jump to latest ----------
toBottom.addEventListener("click", () => window.scrollTo({ top: document.body.scrollHeight }));
function updateToBottom() { toBottom.hidden = nearBottom(); }
window.addEventListener("scroll", updateToBottom, { passive: true });

// ---------- live updates ----------
function connect() {
  const es = new EventSource("/events");
  es.onopen = () => { if (isViewingActive()) setStatus("live", "live"); };
  es.onmessage = async () => {
    await loadSessions();
    if (isViewingActive()) await loadConversation(false);
  };
  es.onerror = () => setStatus("off", "reconnecting");
}

// ---------- boot ----------
(async function init() {
  paintThemeIcon();
  await applyConfigTheme();
  await loadSessions();
  await loadConversation(true);
  connect();
})();
