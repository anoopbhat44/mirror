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
const diagramBtn = document.getElementById("diagram-toggle");
const filterBtn = document.getElementById("filter-toggle");
const filterMenu = document.getElementById("filter-menu");
const showThinking = document.getElementById("show-thinking");
const showTools = document.getElementById("show-tools");
const resumeBtn = document.getElementById("resume-btn");
const resumeLabel = document.getElementById("resume-label");
const exportBtn = document.getElementById("export-btn");
const findBar = document.getElementById("find-bar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const findPrev = document.getElementById("find-prev");
const findNext = document.getElementById("find-next");
const findClose = document.getElementById("find-close");
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

const CLAMP_PX = 420; // code/result blocks taller than this collapse behind "Show more"
let diagramsOn = true; // global default: render mermaid blocks as diagrams
try { diagramsOn = localStorage.getItem("mirror-diagrams") !== "0"; } catch (e) {}
let mermaidLoaded = false;
let mermaidLoading = null;
let mermaidSeq = 0;

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
  refreshMermaidTheme();
});

// ---------- diagrams toggle ----------
function paintDiagramBtn() {
  diagramBtn.classList.toggle("on", diagramsOn);
  diagramBtn.setAttribute("aria-pressed", String(diagramsOn));
  diagramBtn.title = diagramsOn ? "Diagrams on (click for source)" : "Diagrams off (showing source)";
}
diagramBtn.addEventListener("click", () => {
  diagramsOn = !diagramsOn;
  try { localStorage.setItem("mirror-diagrams", diagramsOn ? "1" : "0"); } catch (e) {}
  paintDiagramBtn();
  conversation.querySelectorAll(".mermaid-block").forEach((c) => c.__mermaid && c.__mermaid.setGlobal(diagramsOn));
});

// ---------- filters (hide thinking / tool blocks) ----------
function applyFilter(attr, key, hidden) {
  if (hidden) root.setAttribute(attr, "1");
  else root.removeAttribute(attr);
  try { localStorage.setItem(key, hidden ? "1" : "0"); } catch (e) {}
}
function initFilters() {
  showThinking.checked = root.getAttribute("data-hide-thinking") !== "1";
  showTools.checked = root.getAttribute("data-hide-tools") !== "1";
  showThinking.addEventListener("change", () =>
    applyFilter("data-hide-thinking", "mirror-hide-thinking", !showThinking.checked));
  showTools.addEventListener("change", () =>
    applyFilter("data-hide-tools", "mirror-hide-tools", !showTools.checked));
}
function closeFilterMenu() {
  filterMenu.hidden = true;
  filterBtn.setAttribute("aria-expanded", "false");
  filterBtn.classList.remove("filter-toggle-on");
}
filterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = filterMenu.hidden;
  filterMenu.hidden = !open;
  filterBtn.setAttribute("aria-expanded", String(open));
  filterBtn.classList.toggle("filter-toggle-on", open);
});
filterMenu.addEventListener("click", (e) => e.stopPropagation());
document.addEventListener("click", () => { if (!filterMenu.hidden) closeFilterMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !filterMenu.hidden) closeFilterMenu(); });

// ---------- resume (copy `claude --resume <id>`) ----------
const RESUME_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 8 9 12 5 16"/><line x1="12" y1="16" x2="18" y2="16"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 12 9 17 20 6"/></svg>';
function copyText(text, ok) {
  try { navigator.clipboard.writeText(text).then(ok || (function () {}), function () {}); } catch (e) {}
}
resumeBtn.addEventListener("click", () => {
  if (!currentId) return;
  copyText("claude --resume " + currentId, () => {
    resumeLabel.textContent = "Copied";
    setTimeout(() => { resumeLabel.textContent = "Resume"; }, 1300);
  });
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
  const row = el("div", "session-row");
  const node = el("button", "session" + (viewed ? " current" : ""));
  node.type = "button";
  const title = s.title && s.title.trim() ? s.title : "(untitled session)";
  node.innerHTML =
    '<span class="s-dot' + (s.live ? " live" : "") + '"></span>' +
    '<span class="s-body"><span class="s-title">' + escapeText(title) + "</span>" +
    '<span class="s-meta">' + escapeText(relTime(s.mtime)) + " &middot; " + (s.msg_count || 0) + " msg</span></span>";
  node.addEventListener("click", () => selectSession(s.id));
  row.appendChild(node);
  const resume = el("button", "s-resume", RESUME_SVG);
  resume.type = "button";
  resume.title = "Copy 'claude --resume " + s.id + "'";
  resume.setAttribute("aria-label", "Copy resume command for this session");
  resume.addEventListener("click", (e) => {
    e.stopPropagation();
    copyText("claude --resume " + s.id, () => {
      resume.innerHTML = CHECK_SVG;
      resume.classList.add("done");
      setTimeout(() => { resume.innerHTML = RESUME_SVG; resume.classList.remove("done"); }, 1300);
    });
  });
  row.appendChild(resume);
  return row;
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
  resumeBtn.hidden = !currentId;
  exportBtn.hidden = !currentId;
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
function imgSig(images) {
  return (images || []).map((im) => im.data ? im.data.length : (im.url || "o")).join("|");
}
function itemSig(item) {
  if (item.role === "user") {
    if (item.kind === "command") return "c:" + item.command;
    return "u:" + (item.text || "").length + ":" + (item.text || "").slice(0, 24) + ":i" + imgSig(item.images);
  }
  return "a:" + (item.blocks || []).map((b) =>
    b.type[0] + (b.text ? b.text.length : "") + (b.result ? "r" + b.result.length : "") +
    (b.result_images ? "ri" + imgSig(b.result_images) : "")
  ).join(",");
}

function imgSrc(img) {
  if (img.url) return img.url;
  if (img.data) return "data:" + (img.media_type || "image/png") + ";base64," + img.data;
  return null;
}
function renderImages(images) {
  const wrap = el("div", "images");
  (images || []).forEach((img) => {
    if (img.omitted) {
      wrap.appendChild(el("div", "image-omitted", "image omitted (" + (img.approx_kb || "?") + " KB)"));
      return;
    }
    const src = imgSrc(img);
    if (!src) return;
    const a = el("a", "image-link");
    a.href = src; a.target = "_blank"; a.rel = "noopener";
    const im = document.createElement("img");
    im.className = "msg-image"; im.loading = "lazy"; im.src = src; im.alt = "image";
    a.appendChild(im);
    wrap.appendChild(a);
  });
  return wrap;
}

function renderUserNode(item, showRole) {
  const wrap = el("article", "msg user" + (showRole ? "" : " cont"));
  if (item.kind === "command") {
    wrap.appendChild(el("div", "command-chip", "&#47;" + escapeText((item.command || "").replace(/^\//, ""))));
  } else {
    if (showRole) wrap.appendChild(el("div", "role", "You"));
    if (item.text) wrap.appendChild(el("div", "bubble", md(item.text)));
    if (item.images && item.images.length) wrap.appendChild(renderImages(item.images));
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
  if (block.result_images && block.result_images.length) {
    const out = el("div", "tool-result");
    out.appendChild(el("div", "tool-label", "result image"));
    out.appendChild(renderImages(block.result_images));
    body.appendChild(out);
  }
  details.appendChild(body);
  return details;
}

function renderToolGroup(run) {
  const group = el("div", "tool-group");
  const head = el("div", "tool-group-head");
  const names = [];
  run.forEach((b) => { if (!names.includes(b.name)) names.push(b.name); });
  const label = names.slice(0, 4).join(", ") + (names.length > 4 ? "…" : "");
  head.innerHTML = '<span class="tg-count">' + run.length + " tool calls</span>" +
    '<span class="tg-names">' + escapeText(label) + "</span>";
  const toggle = el("button", "tg-toggle", "expand all");
  toggle.type = "button";
  const list = el("div", "tool-group-list");
  run.forEach((b) => list.appendChild(renderToolUse(b)));
  toggle.addEventListener("click", () => {
    const tools = list.querySelectorAll("details.tool");
    const anyClosed = Array.from(tools).some((d) => !d.open);
    tools.forEach((d) => { d.open = anyClosed; });
    toggle.textContent = anyClosed ? "collapse all" : "expand all";
  });
  head.appendChild(toggle);
  group.appendChild(head);
  group.appendChild(list);
  return group;
}

function renderAssistantNode(item, showRole) {
  const wrap = el("article", "msg assistant" + (showRole ? "" : " cont"));
  if (showRole) wrap.appendChild(el("div", "role", "Claude"));
  const blocks = item.blocks || [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type === "text") { wrap.appendChild(el("div", "bubble", md(block.text))); i++; }
    else if (block.type === "thinking") {
      const d = el("details", "thinking");
      d.appendChild(el("summary", "thinking-summary", "thinking"));
      d.appendChild(el("div", "thinking-body", md(block.text)));
      wrap.appendChild(d);
      i++;
    } else if (block.type === "tool_use") {
      let j = i;
      while (j < blocks.length && blocks[j].type === "tool_use") j++;
      const run = blocks.slice(i, j);
      wrap.appendChild(run.length >= 2 ? renderToolGroup(run) : renderToolUse(run[0]));
      i = j;
    } else { i++; }
  }
  return wrap;
}

function renderNode(item, showRole) {
  return item.role === "user" ? renderUserNode(item, showRole) : renderAssistantNode(item, showRole);
}

// ---------- mermaid (lazy) ----------
function mermaidTheme() {
  return root.getAttribute("data-theme") === "light" ? "neutral" : "dark";
}
function ensureMermaid() {
  if (mermaidLoaded) return Promise.resolve(window.mermaid);
  if (mermaidLoading) return mermaidLoading;
  mermaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/vendor/mermaid.min.js";
    s.onload = () => {
      try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() }); }
      catch (e) {}
      mermaidLoaded = true;
      resolve(window.mermaid);
    };
    s.onerror = () => { mermaidLoading = null; reject(new Error("could not load mermaid")); };
    document.head.appendChild(s);
  });
  return mermaidLoading;
}
function refreshMermaidTheme() {
  if (!mermaidLoaded) return;
  try { window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: mermaidTheme() }); }
  catch (e) {}
  conversation.querySelectorAll(".mermaid-block").forEach((c) => c.__mermaid && c.__mermaid.rerender());
}
function renderMermaidBlock(codeEl) {
  const pre = codeEl.closest("pre");
  if (!pre) return;
  const source = codeEl.textContent;
  const container = el("div", "mermaid-block");
  const bar = el("div", "mermaid-bar");
  const tgl = el("button", "mermaid-tgl"); tgl.type = "button";
  const diagramHost = el("div", "mermaid-diagram");
  const sourceHost = el("pre", "mermaid-source");
  const sc = el("code"); sc.textContent = source; sourceHost.appendChild(sc);
  bar.appendChild(tgl);
  container.appendChild(bar);
  container.appendChild(diagramHost);
  container.appendChild(sourceHost);
  pre.replaceWith(container);

  let mode = diagramsOn ? "diagram" : "source";
  let drawn = false;
  function draw() {
    drawn = true;
    ensureMermaid()
      .then((m) => m.render("mmd-" + (++mermaidSeq), source))
      .then(({ svg }) => { diagramHost.innerHTML = svg; })
      .catch((err) => {
        drawn = false;
        diagramHost.innerHTML = "";
        diagramHost.appendChild(el("div", "mermaid-error", escapeText("diagram error: " + (err && err.message || err))));
      });
  }
  function apply() {
    if (mode === "diagram") {
      sourceHost.hidden = true; diagramHost.hidden = false;
      tgl.textContent = "</> Source";
      if (!drawn) draw();
    } else {
      diagramHost.hidden = true; sourceHost.hidden = false;
      tgl.textContent = "▢ Diagram";
    }
  }
  tgl.addEventListener("click", () => { mode = mode === "diagram" ? "source" : "diagram"; apply(); });
  container.__mermaid = {
    setGlobal(on) { mode = on ? "diagram" : "source"; apply(); },
    rerender() { if (mode === "diagram") { drawn = false; draw(); } },
  };
  apply();
}

// ---------- code blocks: copy + show-more ----------
function decoratePre(pre) {
  if (pre.parentElement && pre.parentElement.classList.contains("code-wrap")) return;
  const wrap = el("div", "code-wrap");
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);
  const code = pre.querySelector("code");
  const copy = el("button", "copy-btn", "Copy"); copy.type = "button";
  copy.addEventListener("click", () => {
    const text = code ? code.textContent : pre.textContent;
    try {
      navigator.clipboard.writeText(text).then(
        () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1200); },
        () => {}
      );
    } catch (e) {}
  });
  wrap.appendChild(copy);
  if (pre.scrollHeight > CLAMP_PX) {
    wrap.classList.add("clamped");
    const more = el("button", "more-btn", "Show more"); more.type = "button";
    more.addEventListener("click", () => {
      const clamped = wrap.classList.toggle("clamped");
      more.textContent = clamped ? "Show more" : "Show less";
    });
    wrap.appendChild(more);
  }
}

function enhance(node) {
  node.querySelectorAll("code.language-mermaid").forEach(renderMermaidBlock);
  node.querySelectorAll("pre code").forEach((c) => {
    if (c.closest(".mermaid-block")) return;
    try { hljs.highlightElement(c); } catch (e) {}
  });
  node.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".mermaid-block")) return;
    decoratePre(pre);
  });
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
  reapplyFind();
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

// ---------- markdown export ----------
const EXPORT_IMG_MAX = 200000; // base64 chars; larger images get a note, not an embed
function mdImage(img) {
  if (img.omitted) return "_[image omitted (" + (img.approx_kb || "?") + " KB)]_";
  if (img.url) return "![image](" + img.url + ")";
  if (img.data) {
    if (img.data.length > EXPORT_IMG_MAX) return "_[image not exported (" + Math.round(img.data.length * 3 / 4 / 1024) + " KB)]_";
    return "![image](data:" + (img.media_type || "image/png") + ";base64," + img.data + ")";
  }
  return "";
}
function conversationToMarkdown(items, meta) {
  const out = ["# " + (meta.title || "Mirror session"), ""];
  const sub = [meta.project, meta.id].filter(Boolean).join(" · ");
  if (sub) { out.push("_" + sub + "_", ""); }
  items.forEach((item) => {
    if (item.role === "user") {
      if (item.kind === "command") {
        out.push("**You:** `/" + (item.command || "").replace(/^\//, "") + "`", "");
      } else {
        out.push("### You", "");
        if (item.text) out.push(item.text, "");
        (item.images || []).forEach((im) => out.push(mdImage(im), ""));
      }
      return;
    }
    out.push("### Claude", "");
    (item.blocks || []).forEach((b) => {
      if (b.type === "text") { out.push(b.text || "", ""); }
      else if (b.type === "thinking") {
        out.push("<details><summary>Thinking</summary>", "", b.text || "", "", "</details>", "");
      } else if (b.type === "tool_use") {
        out.push("**Tool: " + (b.name || "tool") + "**", "", "```json", safeJson(b.input), "```");
        if (b.result) out.push("", "```", b.result, "```");
        (b.result_images || []).forEach((im) => out.push("", mdImage(im)));
        out.push("");
      }
    });
  });
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
function slugify(s) {
  return (s || "session").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "session";
}
function exportMarkdown() {
  if (!rendered.length) return;
  const s = sessionsById[currentId] || {};
  const title = s.title && s.title.trim() ? s.title : (s.project || "Mirror session");
  const text = conversationToMarkdown(rendered, { title: title, project: s.project, id: currentId });
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mirror-" + slugify(title) + ".md";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
exportBtn.addEventListener("click", exportMarkdown);

// ---------- in-page find (searches into collapsed details) ----------
let findHits = [];
let findIdx = -1;
let findQuery = "";

function findSkip(textNode) {
  const p = textNode.parentElement;
  if (!p) return true;
  if (p.closest("script,style")) return true;
  if (p.closest(".mermaid-diagram") || p.closest("svg")) return true; // rendered SVG labels
  const msrc = p.closest(".mermaid-source"); // diagram mode hides the source
  if (msrc && msrc.hidden) return true;
  if (root.getAttribute("data-hide-thinking") === "1" && p.closest("details.thinking")) return true;
  if (root.getAttribute("data-hide-tools") === "1" && (p.closest("details.tool") || p.closest(".tool-group"))) return true;
  return false;
}
function clearFind() {
  conversation.querySelectorAll("mark.find").forEach((m) => {
    m.replaceWith(document.createTextNode(m.textContent));
  });
  conversation.normalize();
  findHits = [];
}
function markFind(needle) {
  const walker = document.createTreeWalker(conversation, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (!n.nodeValue || !n.nodeValue.toLowerCase().includes(needle)) return NodeFilter.FILTER_REJECT;
      return findSkip(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const targets = [];
  while (walker.nextNode()) targets.push(walker.currentNode);
  targets.forEach((textNode) => {
    const text = textNode.nodeValue;
    const low = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let i = 0, at;
    while ((at = low.indexOf(needle, i)) !== -1) {
      if (at > i) frag.appendChild(document.createTextNode(text.slice(i, at)));
      const mark = el("mark", "find");
      mark.textContent = text.slice(at, at + needle.length);
      frag.appendChild(mark);
      i = at + needle.length;
    }
    if (i < text.length) frag.appendChild(document.createTextNode(text.slice(i)));
    textNode.parentNode.replaceChild(frag, textNode);
  });
  return Array.from(conversation.querySelectorAll("mark.find"));
}
function updateFindCount() {
  findCount.textContent = (findHits.length ? findIdx + 1 : 0) + "/" + findHits.length;
}
function setFindCurrent(idx, scroll) {
  if (!findHits.length) { findIdx = -1; updateFindCount(); return; }
  if (findHits[findIdx]) findHits[findIdx].classList.remove("current");
  findIdx = (idx % findHits.length + findHits.length) % findHits.length;
  const cur = findHits[findIdx];
  cur.classList.add("current");
  let d = cur.closest("details");
  while (d) { d.open = true; d = d.parentElement && d.parentElement.closest("details"); }
  const clamped = cur.closest(".code-wrap.clamped"); // reveal a match hidden by the clamp
  if (clamped) {
    clamped.classList.remove("clamped");
    const more = clamped.querySelector(".more-btn");
    if (more) more.textContent = "Show less";
  }
  if (scroll) cur.scrollIntoView({ block: "center" });
  updateFindCount();
}
function runFind(query) {
  clearFind();
  findQuery = query;
  findIdx = -1;
  if (!query) { updateFindCount(); return; }
  findHits = markFind(query.toLowerCase());
  if (findHits.length) setFindCurrent(0, true);
  else updateFindCount();
}
function reapplyFind() {
  if (findBar.hidden || !findQuery) return;
  const prev = findIdx;
  clearFind();
  findHits = markFind(findQuery.toLowerCase());
  if (findHits.length) setFindCurrent(Math.min(Math.max(prev, 0), findHits.length - 1), false);
  else { findIdx = -1; updateFindCount(); }
}
function openFind() {
  findBar.hidden = false;
  let sel = "";
  try { sel = String(window.getSelection()).trim(); } catch (e) {}
  if (sel && sel.length <= 80 && !sel.includes("\n")) findInput.value = sel;
  findInput.focus();
  findInput.select();
  if (findInput.value) runFind(findInput.value);
}
function closeFind() {
  findBar.hidden = true;
  clearFind();
  findQuery = "";
  findIdx = -1;
}
findInput.addEventListener("input", () => runFind(findInput.value));
findInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); setFindCurrent(findIdx + (e.shiftKey ? -1 : 1), true); }
  else if (e.key === "Escape") { e.preventDefault(); closeFind(); }
});
findPrev.addEventListener("click", () => setFindCurrent(findIdx - 1, true));
findNext.addEventListener("click", () => setFindCurrent(findIdx + 1, true));
findClose.addEventListener("click", closeFind);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F")) {
    e.preventDefault();
    openFind();
  }
});

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
  paintDiagramBtn();
  initFilters();
  await applyConfigTheme();
  await loadSessions();
  await loadConversation(true);
  connect();
})();
