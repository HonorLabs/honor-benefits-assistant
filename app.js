const GREETING = "Hey, I'm Benny! I'm your handy Honor Benefits agent. Is there something I can help you with?";

const STARTERS = [
  "How does the 401(k) match work?",
  "When can I get health insurance?",
  "How do I enroll?",
  "Can I change my plan mid-year?",
];

const scrollEl = document.getElementById("scroll");
const msgsEl = document.getElementById("msgs");
const emptyEl = document.getElementById("empty");
const startersEl = document.getElementById("starters");
const greetTextEl = document.getElementById("greetText");
const greetDotsEl = document.getElementById("greetDots");
const inputEl = document.getElementById("input");
const sendEl = document.getElementById("send");

const history = []; // { role: "user" | "assistant", content }
let loading = false;

// A random id for this browser session, so HR's review log can group a person's
// questions together. Not tied to identity; resets on page reload.
const SESSION_ID = (crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));

// Build the starter chips (called after Benny "types" his greeting).
function buildChips() {
  STARTERS.forEach((q, i) => {
    const b = document.createElement("button");
    b.className = "chip chip-in";
    b.style.animationDelay = (i * 90) + "ms";
    b.textContent = q;
    b.addEventListener("click", () => send(q));
    startersEl.appendChild(b);
  });
}

// Benny's entrance: show typing dots, then typewrite the greeting, then chips.
function playIntro() {
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    if (greetDotsEl) greetDotsEl.remove();
    greetTextEl.textContent = GREETING;
    buildChips();
    return;
  }
  setTimeout(() => {
    if (greetDotsEl) greetDotsEl.remove();
    greetTextEl.classList.add("typing");
    let i = 0;
    (function step() {
      greetTextEl.textContent = GREETING.slice(0, i);
      if (i < GREETING.length) {
        i += 1;
        setTimeout(step, 24);
      } else {
        greetTextEl.classList.remove("typing");
        buildChips();
      }
    })();
  }, 850);
}
playIntro();

const BOT_AVATAR = `
  <div class="avatar" aria-hidden="true">
    <img src="assistant-avatar.png" alt="" width="30" height="30" />
  </div>`;

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeSourceDocument(sourceDocument) {
  if (!sourceDocument?.name || !sourceDocument?.url) return null;
  try {
    const url = new URL(sourceDocument.url, window.location.origin);
    const isHandbookDownload =
      url.origin === window.location.origin &&
      /^\/api\/office-handbooks\/[^/]+\/download$/.test(url.pathname);
    if (!isHandbookDownload) return null;
    return {
      name: String(sourceDocument.name).slice(0, 300),
      url: url.href,
    };
  } catch {
    return null;
  }
}

// Turn URLs, form paths, emails, and phone numbers into clickable links.
// Everything is escaped first, so this is safe to set as innerHTML.
function renderRich(text, sourceDocument = null) {
  const source = safeSourceDocument(sourceDocument);
  const sourceToken = "__BENNY_SIGNED_HANDBOOK_SOURCE__";
  let richText = text;
  if (source) {
    const sourceLine = new RegExp(
      `(?:\\*{1,2})?Source:\\s*${escapeRegExp(source.name)}(?:\\*{1,2})?`,
      "i"
    );
    richText = sourceLine.test(richText)
      ? richText.replace(sourceLine, `Source: ${sourceToken}`)
      : `${richText.trim()}\n\nSource: ${sourceToken}`;
  }

  const pattern = /(https?:\/\/[^\s<]+)|(\/forms\/[A-Za-z0-9_\-]+\.pdf)|([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})|(\(\d{3}\)\s?\d{3}-\d{4}|\b\d{3}-\d{3}-\d{4}\b)/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = pattern.exec(richText))) {
    out += escapeHtml(richText.slice(last, m.index));
    const token = m[0];
    if (m[1]) {
      out += `<a href="${escapeHtml(token)}" target="_blank" rel="noopener noreferrer">${escapeHtml(token)}</a>`;
    } else if (m[2]) {
      out += `<a href="${escapeHtml(token)}" target="_blank" rel="noopener noreferrer">${escapeHtml(token)}</a>`;
    } else if (m[3]) {
      out += `<a href="mailto:${escapeHtml(token)}">${escapeHtml(token)}</a>`;
    } else if (m[4]) {
      const tel = token.replace(/[^\d]/g, "");
      out += `<a href="tel:${tel}">${escapeHtml(token)}</a>`;
    }
    last = m.index + token.length;
  }
  out += escapeHtml(richText.slice(last));
  if (source) {
    out = out.replace(
      sourceToken,
      `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener noreferrer" title="Download this source document (link expires in 10 minutes)">${escapeHtml(source.name)}</a>`
    );
  }
  return out;
}

function scrollToBottom() {
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

function addBubble(role, text, sourceDocument = null) {
  if (emptyEl) emptyEl.classList.add("hidden");
  const row = document.createElement("div");
  row.className = "row" + (role === "user" ? " user" : "");
  const bubbleClass = role === "user" ? "user" : role === "error" ? "err" : "bot";
  const bubble = document.createElement("div");
  bubble.className = "bubble " + bubbleClass;
  if (role === "assistant") {
    bubble.innerHTML = renderRich(text, sourceDocument); // clickable links in answers
  } else {
    bubble.textContent = text; // user + error stay plain
  }
  if (role !== "user") row.innerHTML = BOT_AVATAR;
  row.appendChild(bubble);
  msgsEl.appendChild(row);
  scrollToBottom();
  return row;
}

function showTyping() {
  const row = document.createElement("div");
  row.className = "row";
  row.id = "typing-row";
  row.innerHTML = BOT_AVATAR + `<div class="bubble bot"><div class="dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div></div>`;
  msgsEl.appendChild(row);
  scrollToBottom();
}

function hideTyping() {
  const t = document.getElementById("typing-row");
  if (t) t.remove();
}

function setLoading(v) {
  loading = v;
  sendEl.disabled = v || !inputEl.value.trim();
}

async function send(text) {
  const trimmed = (text != null ? text : inputEl.value).trim();
  if (!trimmed || loading) return;

  addBubble("user", trimmed);
  history.push({ role: "user", content: trimmed });
  inputEl.value = "";
  inputEl.style.height = "auto";
  setLoading(true);
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, sessionId: SESSION_ID }),
    });
    const data = await res.json();
    hideTyping();

    if (!res.ok) {
      addBubble("error", data.error || "Something went wrong. Please try again.");
    } else {
      addBubble("assistant", data.reply, data.sourceDocument);
      history.push({ role: "assistant", content: data.reply });
    }
  } catch (err) {
    hideTyping();
    addBubble("error", "Couldn't reach the assistant. Please check your connection and try again.");
  } finally {
    setLoading(false);
  }
}

// Composer behavior
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + "px";
  sendEl.disabled = loading || !inputEl.value.trim();
});

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});

sendEl.addEventListener("click", () => send());
sendEl.disabled = true;
