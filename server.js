import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import mammoth from "mammoth";
import WordExtractor from "word-extractor";
import { buildSystemPrompt } from "./prompt.js";
import { loadPackages, assembleKnowledge, isEnabled, packageSummaries } from "./packages.js";
import {
  buildFullOfficeHandbookContext,
  createHandbookDownloadSignature,
  getOfficeAgency,
  handbookContentHash,
  normalizeHandbookText,
  resolveOfficeAgency,
  verifyHandbookDownloadSignature,
  wantsOfficeHandbookDownload,
} from "./office-handbooks.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reader for legacy binary Word (.doc) files. mammoth only handles .docx, so
// without this a .doc decodes to garbage and Benny "learns" nothing from it.
const wordExtractor = new WordExtractor();

const app = express();
// Raised from 1mb so /brain can accept uploaded PDFs/images/docs as base64.
// Chat bodies stay tiny; this is just a ceiling.
app.use(express.json({ limit: "30mb" }));

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const HANDBOOK_DOWNLOAD_SECRET = process.env.HANDBOOK_DOWNLOAD_SECRET || ADMIN_PASSWORD;
const HANDBOOK_PUBLIC_BASE_URL = (
  process.env.PUBLIC_BASE_URL || "https://benny-agent.up.railway.app"
).replace(/\/+$/, "");
const HANDBOOK_LINK_TTL_SECONDS = 10 * 60;
const HANDBOOK_MAX_FILE_BYTES = 5 * 1024 * 1024;
const HANDBOOK_MIME_TYPES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Token prices (USD per 1,000,000 tokens). Defaults are Claude Sonnet 4.6
// ($3.00 input / $15.00 output). Override with env vars if the model or the
// rates ever change. These drive the cost estimate on the /admin dashboard.
const PRICE_IN_PER_MTOK = parseFloat(process.env.PRICE_IN_PER_MTOK || "3.00");
const PRICE_OUT_PER_MTOK = parseFloat(process.env.PRICE_OUT_PER_MTOK || "15.00");

// --- Knowledge packages ----------------------------------------------------
// The knowledge base is split into packages/ (one file per plan or agency).
// The active system prompt is assembled from CORE plus whichever packages are
// enabled. Editing a package's text still means edit + push + redeploy, but
// turning a package on/off is live from /admin (no redeploy) and persists in
// the package_state table. If packages/ is empty, we fall back to the legacy
// single knowledge-base.md so the assistant never goes dark.
//
// On top of packages there are "brain entries" — knowledge added live through
// the /brain page. Those are stored in Postgres and appended to the knowledge
// base with no redeploy, so HR can teach Benny new facts on the fly.
const PACKAGES_DIR = path.join(__dirname, "packages");
let PACKAGES = loadPackages(PACKAGES_DIR);
let packageState = {}; // id -> boolean; loaded from the DB at startup
let brainEntries = []; // live /brain additions, newest first; loaded from the DB
let SYSTEM_PROMPT = "";

// Render the live /brain additions as a knowledge-base section. Newest first,
// and flagged as the most current, authoritative source so Benny prefers them.
function renderBrainEntries() {
  if (!brainEntries.length) return "";
  let out =
    "\n\n=====================================================================\n" +
    "# LIVE ADDITIONS — taught directly through /brain (newest first)\n" +
    "# These are the most current facts available. Treat them as authoritative.\n" +
    "# If a live addition conflicts with older text above, follow the live\n" +
    "# addition. If two live additions conflict, follow the one listed first\n" +
    "# (it was added more recently).\n" +
    "=====================================================================\n";
  for (const e of brainEntries) {
    const d = e.created_at instanceof Date ? e.created_at : new Date(e.created_at);
    const when = isNaN(d) ? "" : ` (added ${d.toISOString().slice(0, 10)})`;
    out += `\n## ${e.title}${when}\n${e.body}\n`;
  }
  return out;
}

function rebuildSystemPrompt() {
  let kb = "";
  if (PACKAGES.length) {
    kb = assembleKnowledge(PACKAGES, packageState);
  } else {
    try {
      kb = fs.readFileSync(path.join(__dirname, "knowledge-base.md"), "utf8");
      console.warn("No packages/ found — using legacy knowledge-base.md.");
    } catch (e) {
      console.warn("No packages and no knowledge-base.md:", e.message);
    }
  }
  kb += renderBrainEntries();
  SYSTEM_PROMPT = buildSystemPrompt(kb);
  return SYSTEM_PROMPT;
}
rebuildSystemPrompt();
console.log(`Loaded ${PACKAGES.length} knowledge package(s); system prompt is ${SYSTEM_PROMPT.length} chars.`);

// --- Question log (Postgres) -----------------------------------------------
// Optional: if DATABASE_URL isn't set, the assistant still runs normally and
// logging plus the /admin page are simply turned off. On Railway, add the
// Postgres plugin and it injects DATABASE_URL automatically.
const { Pool } = pg;
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
  });
  initDb();
} else {
  console.warn("DATABASE_URL not set — question logging, /admin, and /brain are disabled.");
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        question TEXT NOT NULL,
        answer TEXT,
        needs_hr BOOLEAN NOT NULL DEFAULT false,
        reviewed BOOLEAN NOT NULL DEFAULT false,
        session_id TEXT
      );
    `);
    // Add the newer columns if an older table already exists (safe to re-run).
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS input_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS output_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER DEFAULT 0;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS topic TEXT;`);
    await pool.query(`ALTER TABLE questions ADD COLUMN IF NOT EXISTS agency TEXT;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS questions_created_at_idx ON questions (created_at);`);
    // Per-package on/off state for the knowledge packages. Survives redeploys.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS package_state (
        id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Live knowledge added through /brain. Appended to the system prompt with
    // no redeploy; deletable from the /brain Logs tab.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS brain_entries (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        title TEXT NOT NULL,
        summary TEXT,
        body TEXT NOT NULL,
        source_kind TEXT,
        source_name TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS brain_entries_created_at_idx ON brain_entries (created_at);`);
    // Complete office employee handbooks live in Postgres rather than the
    // global prompt. Only the handbook matching the agency named in the chat
    // is attached to that request. Hash uniqueness prevents duplicate uploads.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS office_handbooks (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_date TIMESTAMPTZ NOT NULL,
        source_name TEXT NOT NULL,
        source_attachment_id TEXT,
        content_hash TEXT NOT NULL UNIQUE,
        full_text TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true
      );
    `);
    await pool.query(`ALTER TABLE office_handbooks ADD COLUMN IF NOT EXISTS file_name TEXT;`);
    await pool.query(`ALTER TABLE office_handbooks ADD COLUMN IF NOT EXISTS mime_type TEXT;`);
    await pool.query(`ALTER TABLE office_handbooks ADD COLUMN IF NOT EXISTS file_bytes BYTEA;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS office_handbook_agencies (
        agency_slug TEXT PRIMARY KEY,
        agency_name TEXT NOT NULL,
        handbook_id BIGINT NOT NULL REFERENCES office_handbooks(id) ON DELETE CASCADE,
        source_date TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS office_handbook_agencies_handbook_idx
      ON office_handbook_agencies (handbook_id);`);
    dbReady = true;
    await loadPackageState();
    await loadBrainEntries();
    rebuildSystemPrompt();
    console.log(
      `Question log, package state, and ${brainEntries.length} brain entr${brainEntries.length === 1 ? "y" : "ies"} are ready.`
    );
  } catch (e) {
    console.error("Could not initialize the database tables:", e.message);
  }
}

// Load saved package on/off state from the DB and rebuild the system prompt so
// admin toggles persist across redeploys.
async function loadPackageState() {
  if (!pool || !dbReady) return;
  try {
    const { rows } = await pool.query("SELECT id, enabled FROM package_state");
    packageState = {};
    for (const r of rows) packageState[r.id] = r.enabled;
    rebuildSystemPrompt();
    console.log(`Applied saved state for ${rows.length} package(s).`);
  } catch (e) {
    console.error("Could not load package state:", e.message);
  }
}

// Load the live /brain additions into memory (newest first) for the prompt.
async function loadBrainEntries() {
  if (!pool || !dbReady) {
    brainEntries = [];
    return;
  }
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, title, body FROM brain_entries
       WHERE enabled = true ORDER BY created_at DESC`
    );
    brainEntries = rows;
  } catch (e) {
    console.error("Could not load brain entries:", e.message);
  }
}

// Strip things people shouldn't have typed before anything is stored.
function scrubPII(text) {
  if (!text) return text;
  return text
    .replace(/\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g, "[redacted]") // SSN-like
    .replace(/\b\d{9,}\b/g, "[redacted]"); // long digit runs (account numbers, etc.)
}

function normalizeAgency(slug) {
  if (!slug) return "none";
  const s = String(slug).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return s || "none";
}

async function logQuestion(row) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(
      `INSERT INTO questions
         (question, answer, needs_hr, session_id, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, topic, agency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        scrubPII(row.question)?.slice(0, 4000) || "",
        scrubPII(row.answer)?.slice(0, 8000) || "",
        !!row.needsHr,
        row.sessionId ? String(row.sessionId).slice(0, 100) : null,
        row.inputTokens || 0,
        row.outputTokens || 0,
        row.cacheReadTokens || 0,
        row.cacheWriteTokens || 0,
        row.topic || "other",
        row.agency || "none",
      ]
    );
  } catch (e) {
    console.error("Could not log question:", e.message);
  }
}

// --- Usage limits (protect the API bill) -----------------------------------
// Three layers, all tunable via env vars:
//   MAX_PER_MIN     burst cap per person (per IP), per minute
//   MAX_PER_IP_DAY  total messages one person (per IP) can send in a day
//   MAX_GLOBAL_DAY  total messages from everyone in a day (backstop)
// These are in-memory, so they reset on redeploy. They are the first line of
// defense; for a hard guarantee, also set a monthly spend limit in the
// Anthropic Console.
const MAX_PER_MIN = parseInt(process.env.MAX_PER_MIN || "20", 10);
const MAX_PER_IP_DAY = parseInt(process.env.MAX_PER_IP_DAY || "60", 10);
const MAX_GLOBAL_DAY = parseInt(process.env.MAX_GLOBAL_DAY || "1500", 10);

const minuteHits = new Map(); // ip -> { count, resetAt }
const dayHits = new Map(); // ip -> { count, day }
let globalDay = { day: dayKey(), count: 0 };

function dayKey() {
  return new Date().toISOString().slice(0, 10);
}

// Check all limits and, if the request is allowed, count it. Returns either
// { ok: true } or { ok: false, status, error }.
function checkAndCount(ip) {
  const now = Date.now();
  const day = dayKey();

  if (globalDay.day !== day) globalDay = { day, count: 0 };

  let burst = minuteHits.get(ip);
  if (!burst || now > burst.resetAt) burst = { count: 0, resetAt: now + 60_000 };

  let perDay = dayHits.get(ip);
  if (!perDay || perDay.day !== day) perDay = { count: 0, day };

  if (burst.count >= MAX_PER_MIN) {
    return { ok: false, status: 429, error: "You're sending messages too quickly. Please wait a moment." };
  }
  if (globalDay.count >= MAX_GLOBAL_DAY) {
    return { ok: false, status: 503, error: "The assistant is taking a short break due to high usage. Please try again later, or contact HR for help." };
  }
  if (perDay.count >= MAX_PER_IP_DAY) {
    return { ok: false, status: 429, error: "You've reached today's limit for the assistant. For more help right now, please contact HR." };
  }

  burst.count += 1;
  minuteHits.set(ip, burst);
  perDay.count += 1;
  dayHits.set(ip, perDay);
  globalDay.count += 1;
  return { ok: true };
}

// Light periodic cleanup so the maps don't grow forever.
setInterval(() => {
  const now = Date.now();
  const day = dayKey();
  for (const [ip, b] of minuteHits) if (now > b.resetAt) minuteHits.delete(ip);
  for (const [ip, d] of dayHits) if (d.day !== day) dayHits.delete(ip);
}, 3_600_000).unref();

// --- Parse and strip the model's hidden review tag -------------------------
// Tag looks like: [[META | topic: premiums_cost | agency: family_care | answered: no]]
// We also still honor the older [[NEEDS_HR]] marker for safety.
const META_RE = /\[\[META\b[^\]]*\]\]/gi;
const LEGACY_NEEDS_HR = /\[\[NEEDS_HR\]\]/gi;

function parseAndStripTag(text) {
  let needsHr = false;
  let topic = "other";
  let agency = "none";

  const metaMatch = text.match(/\[\[META\b[^\]]*\]\]/i);
  if (metaMatch) {
    const raw = metaMatch[0];
    const grab = (key) => {
      const m = raw.match(new RegExp(key + "\\s*:\\s*([A-Za-z0-9_\\-]+)", "i"));
      return m ? m[1].toLowerCase() : null;
    };
    topic = grab("topic") || "other";
    agency = normalizeAgency(grab("agency"));
    needsHr = grab("answered") === "no";
  }
  if (LEGACY_NEEDS_HR.test(text)) needsHr = true;

  const clean = text.replace(META_RE, "").replace(LEGACY_NEEDS_HR, "").trim();
  return { clean, needsHr, topic, agency };
}

function createHandbookDownloadUrl(agencySlug) {
  if (!HANDBOOK_DOWNLOAD_SECRET || !HANDBOOK_PUBLIC_BASE_URL) return "";
  const expires = Math.floor(Date.now() / 1000) + HANDBOOK_LINK_TTL_SECONDS;
  const signature = createHandbookDownloadSignature({
    agencySlug,
    expires,
    secret: HANDBOOK_DOWNLOAD_SECRET,
  });
  if (!signature) return "";
  return `${HANDBOOK_PUBLIC_BASE_URL}/api/office-handbooks/${encodeURIComponent(
    agencySlug
  )}/download?expires=${expires}&sig=${signature}`;
}

async function officeHandbookPrompt(messages) {
  const resolution = resolveOfficeAgency(messages);
  if (!resolution) return null;

  if (resolution.ambiguous) {
    const choices = resolution.candidates?.map((agency) => agency.name).join(" or ");
    return {
      cache: false,
      text:
        "OFFICE HANDBOOK ROUTING\n" +
        (choices
          ? `The office name in the conversation could mean ${choices}. Ask the employee which state or exact office they mean before answering from a handbook.`
          : "The employee asked about another office but did not name it. Ask for the exact agency before answering from an office handbook.") +
        "\nDo not use the previous office's handbook for this question.",
    };
  }

  if (!pool || !dbReady) {
    return {
      cache: false,
      text: `OFFICE HANDBOOK ROUTING\nThe employee named ${resolution.agency.name}, but office handbook storage is unavailable. Do not guess or use another agency's policy.`,
    };
  }

  try {
    const { rows } = await pool.query(
      `SELECT a.agency_slug, a.agency_name, h.source_name, h.source_date, h.full_text,
              h.file_name, octet_length(h.file_bytes) AS file_size
       FROM office_handbook_agencies a
       JOIN office_handbooks h ON h.id = a.handbook_id
       WHERE a.agency_slug = $1 AND h.enabled = true
       LIMIT 1`,
      [resolution.agency.slug]
    );
    if (!rows.length) {
      return {
        cache: false,
        text: `OFFICE HANDBOOK ROUTING\nThe employee named ${resolution.agency.name}, but no approved office handbook is loaded for that agency. Say you cannot verify the office policy and do not use another agency's handbook.`,
      };
    }

    const row = rows[0];
    const wantsDownload = wantsOfficeHandbookDownload(messages);
    const downloadUrl =
      Number(row.file_size) > 0
        ? createHandbookDownloadUrl(row.agency_slug)
        : "";
    const downloadRouting =
      wantsDownload && !downloadUrl
        ? "\nThe employee asked for the file, but no approved downloadable copy is available. Give the exact source name and direct them to HR."
        : "";
    return {
      // The signed URL is returned as structured response metadata and is not
      // embedded in this prompt, so the handbook context remains cacheable.
      cache: true,
      text:
        buildFullOfficeHandbookContext({
          agency: { slug: row.agency_slug, name: row.agency_name },
          sourceName: row.source_name,
          sourceDate: row.source_date,
          fullText: row.full_text,
          downloadUrl,
          downloadRequested: wantsDownload,
        }) + downloadRouting,
      sourceDocument: downloadUrl
        ? {
            name: row.source_name,
            url: downloadUrl,
            expiresInSeconds: HANDBOOK_LINK_TTL_SECONDS,
          }
        : null,
    };
  } catch (error) {
    console.error("Could not retrieve office handbook:", error.message);
    return {
      cache: false,
      text: `OFFICE HANDBOOK ROUTING\nThe employee named ${resolution.agency.name}, but the office handbook could not be retrieved. Do not guess or use another agency's policy.`,
    };
  }
}

// --- Chat endpoint ---------------------------------------------------------
app.post("/api/chat", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip;
    const limit = checkAndCount(ip);
    if (!limit.ok) {
      return res.status(limit.status).json({ error: limit.error });
    }

    if (!API_KEY) {
      console.error("ANTHROPIC_API_KEY is not set.");
      return res.status(500).json({ error: "The assistant isn't configured yet. Please contact HR." });
    }

    const { messages, sessionId } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "No question received." });
    }

    const safeMessages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    if (safeMessages.length === 0) {
      return res.status(400).json({ error: "No question received." });
    }

    const handbookPrompt = await officeHandbookPrompt(safeMessages);
    const system = [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }];
    if (handbookPrompt?.text) {
      const block = { type: "text", text: handbookPrompt.text };
      if (handbookPrompt.cache) block.cache_control = { type: "ephemeral" };
      system.push(block);
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        // Cache the system prompt (persona + knowledge base). It's identical on
        // every request, so after the first call Claude reads it from cache at
        // ~1/10 the input price instead of re-charging the full ~8k tokens.
        system,
        messages: safeMessages,
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      console.error("Anthropic API error:", anthropicRes.status, errText);
      return res.status(502).json({ error: "The assistant is temporarily unavailable. Please try again." });
    }

    const data = await anthropicRes.json();
    let reply = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    const { clean, needsHr, topic, agency } = parseAndStripTag(reply);
    const finalReply = clean || "Sorry, I didn't catch that. Could you rephrase?";

    const usage = data.usage || {};
    const lastUser = [...safeMessages].reverse().find((m) => m.role === "user");

    logQuestion({
      question: lastUser?.content || "",
      answer: finalReply,
      needsHr,
      topic,
      agency,
      sessionId,
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
      cacheWriteTokens: usage.cache_creation_input_tokens || 0,
    });

    res.json({
      reply: finalReply,
      sourceDocument: handbookPrompt?.sourceDocument || null,
    });
  } catch (err) {
    console.error("Chat handler error:", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// --- Admin (HR review page) ------------------------------------------------
function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("The review page isn't configured yet. Set ADMIN_PASSWORD to enable it.");
  }
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString();
    const pass = decoded.slice(decoded.indexOf(":") + 1);
    if (pass && pass === ADMIN_PASSWORD) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="HHN Benefits Review"');
  return res.status(401).send("Authentication required.");
}

app.get("/admin", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "admin-page.html"));
});

app.get("/api/admin/questions", adminAuth, async (req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false, rows: [] });
  try {
    const filter = req.query.filter;
    let where = "";
    if (filter === "needs_hr") where = "WHERE needs_hr = true AND reviewed = false";
    else if (filter === "unreviewed") where = "WHERE reviewed = false";
    const { rows } = await pool.query(
      `SELECT id, created_at, question, answer, needs_hr, reviewed, session_id, topic, agency
       FROM questions ${where}
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json({ dbReady: true, rows });
  } catch (e) {
    console.error("Could not load questions:", e.message);
    res.status(500).json({ error: "Could not load questions." });
  }
});

app.get("/api/admin/stats", adminAuth, async (_req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false });
  try {
    const [totals, tokens, daily, topics, agencies] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('day', now()))   AS sessions_today,
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('week', now()))  AS sessions_week,
          COUNT(DISTINCT session_id) FILTER (WHERE created_at >= date_trunc('month', now())) AS sessions_month,
          COUNT(DISTINCT session_id) AS sessions_total,
          COUNT(*) AS messages_total,
          COUNT(*) FILTER (WHERE needs_hr) AS needs_hr_total,
          COUNT(*) FILTER (WHERE needs_hr AND NOT reviewed) AS needs_hr_open
        FROM questions
      `),
      pool.query(`
        SELECT
          COALESCE(SUM(input_tokens),0)  AS in_tok,
          COALESCE(SUM(output_tokens),0) AS out_tok,
          COALESCE(SUM(cache_read_tokens),0)  AS cache_read_tok,
          COALESCE(SUM(cache_write_tokens),0) AS cache_write_tok,
          COALESCE(SUM(input_tokens)  FILTER (WHERE created_at >= date_trunc('month', now())),0) AS in_tok_month,
          COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('month', now())),0) AS out_tok_month,
          COALESCE(SUM(cache_read_tokens)  FILTER (WHERE created_at >= date_trunc('month', now())),0) AS cache_read_month,
          COALESCE(SUM(cache_write_tokens) FILTER (WHERE created_at >= date_trunc('month', now())),0) AS cache_write_month
        FROM questions
      `),
      pool.query(`
        SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
               COUNT(DISTINCT session_id) AS sessions,
               COUNT(*) AS messages
        FROM questions
        WHERE created_at >= now() - interval '13 days'
        GROUP BY 1 ORDER BY 1
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(topic,''),'other') AS topic, COUNT(*) AS n
        FROM questions GROUP BY 1 ORDER BY n DESC LIMIT 20
      `),
      pool.query(`
        SELECT COALESCE(NULLIF(agency,''),'unknown') AS agency, COUNT(*) AS n
        FROM questions
        WHERE agency IS NOT NULL AND agency NOT IN ('none','')
        GROUP BY 1 ORDER BY n DESC LIMIT 20
      `),
    ]);

    const t = totals.rows[0];
    const k = tokens.rows[0];
    const num = (x) => Number(x) || 0;
    // Cache reads are billed at ~10% of input; 5-minute cache writes at ~125%.
    const CACHE_READ_PER_MTOK = PRICE_IN_PER_MTOK * 0.1;
    const CACHE_WRITE_PER_MTOK = PRICE_IN_PER_MTOK * 1.25;
    const cost = (inTok, outTok, cacheRead, cacheWrite) =>
      (num(inTok) / 1e6) * PRICE_IN_PER_MTOK +
      (num(outTok) / 1e6) * PRICE_OUT_PER_MTOK +
      (num(cacheRead) / 1e6) * CACHE_READ_PER_MTOK +
      (num(cacheWrite) / 1e6) * CACHE_WRITE_PER_MTOK;

    res.json({
      dbReady: true,
      conversations: {
        today: num(t.sessions_today),
        week: num(t.sessions_week),
        month: num(t.sessions_month),
        total: num(t.sessions_total),
      },
      messagesTotal: num(t.messages_total),
      needsHr: { total: num(t.needs_hr_total), open: num(t.needs_hr_open) },
      limits: {
        globalToday: globalDay.day === dayKey() ? globalDay.count : 0,
        maxGlobalDay: MAX_GLOBAL_DAY,
        maxPerIpDay: MAX_PER_IP_DAY,
        maxPerMin: MAX_PER_MIN,
      },
      cost: {
        inputTokens: num(k.in_tok) + num(k.cache_read_tok) + num(k.cache_write_tok),
        outputTokens: num(k.out_tok),
        cachedReadTokens: num(k.cache_read_tok),
        total: cost(k.in_tok, k.out_tok, k.cache_read_tok, k.cache_write_tok),
        month: cost(k.in_tok_month, k.out_tok_month, k.cache_read_month, k.cache_write_month),
        rates: { input: PRICE_IN_PER_MTOK, output: PRICE_OUT_PER_MTOK },
      },
      daily: daily.rows.map((r) => ({ day: r.day, sessions: num(r.sessions), messages: num(r.messages) })),
      topics: topics.rows.map((r) => ({ topic: r.topic, n: num(r.n) })),
      agencies: agencies.rows.map((r) => ({ agency: r.agency, n: num(r.n) })),
    });
  } catch (e) {
    console.error("Could not load stats:", e.message);
    res.status(500).json({ error: "Could not load stats." });
  }
});

app.post("/api/admin/questions/:id/review", adminAuth, async (req, res) => {
  if (!pool || !dbReady) return res.status(503).json({ error: "Review log isn't available." });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id." });
  const reviewed = req.body?.reviewed !== false;
  try {
    await pool.query("UPDATE questions SET reviewed = $1 WHERE id = $2", [reviewed, id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("Could not update question:", e.message);
    res.status(500).json({ error: "Could not update." });
  }
});

// --- Knowledge packages (admin config) -------------------------------------
// List every package with its on/off state and metadata. `persisted` tells the
// UI whether toggles will survive a redeploy (they only do when the DB is up).
app.get("/api/admin/packages", adminAuth, (_req, res) => {
  res.json({
    persisted: !!(pool && dbReady),
    activePromptChars: SYSTEM_PROMPT.length,
    packages: packageSummaries(PACKAGES, packageState),
  });
});

// Full text of one package, for the admin preview panel.
app.get("/api/admin/packages/:id", adminAuth, (req, res) => {
  const pkg = PACKAGES.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "No such package." });
  res.json({
    id: pkg.id,
    title: pkg.title,
    type: pkg.type,
    locked: pkg.locked,
    enabled: isEnabled(pkg, packageState),
    sizeChars: pkg.sizeChars,
    body: pkg.body,
  });
});

// Turn a package on or off. Takes effect on the next chat within seconds; no
// redeploy. Locked packages (core) cannot be turned off.
app.post("/api/admin/packages/:id", adminAuth, async (req, res) => {
  const pkg = PACKAGES.find((p) => p.id === req.params.id);
  if (!pkg) return res.status(404).json({ error: "No such package." });
  if (pkg.locked) {
    return res.status(400).json({ error: "This package is always on and can't be turned off." });
  }
  const enabled = req.body?.enabled !== false;
  packageState[pkg.id] = enabled;

  let persisted = false;
  if (pool && dbReady) {
    try {
      await pool.query(
        `INSERT INTO package_state (id, enabled, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [pkg.id, enabled]
      );
      persisted = true;
    } catch (e) {
      console.error("Could not persist package state:", e.message);
    }
  }

  rebuildSystemPrompt();
  console.log(`Package "${pkg.id}" turned ${enabled ? "ON" : "OFF"} (prompt now ${SYSTEM_PROMPT.length} chars).`);
  res.json({ ok: true, id: pkg.id, enabled, persisted });
});

// --- Brain (teach Benny live) ----------------------------------------------
// The /brain page lets HR add knowledge without a redeploy. It accepts typed
// text and/or uploaded files (PDF, Word .doc/.docx, images/scans, plain text).
// An "intake agent" turns the material into one clean knowledge entry, saves it
// to brain_entries, rebuilds the prompt, and then asks the live Benny a test
// question so the person can see the new fact took effect. Same admin password.

const INGEST_SYSTEM = `You are the knowledge intake agent for "Benny," a benefits and 401(k) assistant used by Honor Health Network employees. Someone from HR or operations is giving you material — typed notes, a PDF, a Word document, or an image/scan. Your ONLY job is to turn that material into ONE clean knowledge entry that Benny can use to answer employees, and to write a question that proves the entry works.

Rules for the entry body:
- Capture the concrete facts an employee would need: dollar amounts, percentages, dates, deadlines, plan names, eligibility rules, phone numbers, emails, and links. Do not lose specifics.
- If the material clearly applies to a specific agency, plan, or group, say so explicitly (e.g., "For Family Care employees, ...").
- Write the body as clean reference knowledge in Markdown — short headings and bullets are good. It is NOT a chat reply: no greetings, no "Benny will…", no first person.
- Do not invent anything. Include only what the material supports. Ignore page numbers, boilerplate, and legal filler.
- Keep it focused. If the material is long, distill the benefits-relevant parts.

Then write "test_question": a realistic, SELF-CONTAINED question an employee might ask that this new entry now answers. Make it specific enough to answer without a follow-up — if the entry is agency- or plan-specific, name that agency/plan in the question.

Respond with ONLY a JSON object — no code fences, no commentary:
{"title": "short label", "summary": "one short line for a log list", "body": "the Markdown knowledge", "test_question": "..."}

If the material contains nothing useful for a benefits assistant, respond with exactly:
{"title": "", "summary": "", "body": "", "test_question": ""}`;

function guessMediaType(name, mt) {
  if (mt) return mt;
  const n = String(name).toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".webp")) return "image/webp";
  if (n.endsWith(".gif")) return "image/gif";
  if (n.endsWith(".pdf")) return "application/pdf";
  return "";
}

function extractJson(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, "").replace(/```$/g, "").trim();
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a !== -1 && b !== -1 && b > a) t = t.slice(a, b + 1);
  return JSON.parse(t);
}

// Ask the live Benny a single question with the current system prompt. Used to
// prove a freshly added entry took effect.
async function askBenny(question) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: [{ type: "text", text: SYSTEM_PROMPT }],
      messages: [{ role: "user", content: String(question).slice(0, 2000) }],
    }),
  });
  if (!r.ok) throw new Error("benny " + r.status);
  const d = await r.json();
  const raw = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return parseAndStripTag(raw).clean || raw;
}

app.get("/brain", adminAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "brain-page.html"));
});

// Add knowledge. Body: { text?: string, files?: [{name, mediaType, dataBase64}] }
app.post("/api/brain/ingest", adminAuth, async (req, res) => {
  if (!API_KEY) return res.status(500).json({ error: "The assistant isn't configured yet (no API key)." });
  if (!pool || !dbReady) {
    return res.status(503).json({ error: "The database isn't connected, so I can't save to Benny's brain yet." });
  }

  const { text, files } = req.body || {};
  const hasText = typeof text === "string" && text.trim().length > 0;
  const fileList = Array.isArray(files) ? files.slice(0, 8) : [];
  if (!hasText && fileList.length === 0) {
    return res.status(400).json({ error: "Add some text or a file first." });
  }

  const blocks = [];
  let sourceKind = null;
  const names = [];      // sources that produced usable material
  const skipped = [];    // { name, reason } for anything we couldn't read

  if (hasText) {
    blocks.push({ type: "text", text: "Typed notes:\n\n" + text.slice(0, 60000) });
    sourceKind = "text";
    names.push("typed notes");
  }

  // Does a decoded string look like real text, or like binary we mis-read?
  // Legacy .doc/.xlsx/.zip etc. decode to mostly control and replacement
  // characters, and we must never feed that garbage to the model as if it were
  // readable content — that is what made Benny silently "learn nothing."
  function looksLikeText(s) {
    if (!s || !s.trim()) return false;
    const sample = s.slice(0, 4000);
    let bad = 0;
    for (let i = 0; i < sample.length; i++) {
      const c = sample.charCodeAt(i);
      if (c === 0xfffd) bad++; // Unicode replacement char
      else if (c < 9 || (c > 13 && c < 32)) bad++; // control chars
    }
    return bad / sample.length < 0.1;
  }

  const TEXT_EXTS = [".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".rtf", ".html", ".htm", ".xml", ".yml", ".yaml"];

  // Read every file on its own. A problem with one file is reported for that
  // file specifically, and never kills the whole upload.
  for (const f of fileList) {
    const name = String(f?.name || "file");
    const b64 = String(f?.dataBase64 || "");
    if (!b64) {
      skipped.push({ name, reason: "no file data came through — try uploading it again" });
      continue;
    }
    if (b64.length > 28_000_000) {
      return res.status(413).json({ error: `"${name}" is too large. Please keep files under about 20 MB.` });
    }
    const mt = guessMediaType(name, String(f?.mediaType || ""));
    const lower = name.toLowerCase();
    const ext = (lower.match(/\.[a-z0-9]+$/) || [""])[0];

    try {
      if (mt === "application/pdf" || lower.endsWith(".pdf")) {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 } });
        sourceKind = sourceKind || "pdf";
        names.push(name);
      } else if (mt.startsWith("image/")) {
        blocks.push({ type: "image", source: { type: "base64", media_type: mt, data: b64 } });
        sourceKind = sourceKind || "image";
        names.push(name);
      } else if (lower.endsWith(".docx") || mt.includes("wordprocessingml")) {
        const buffer = Buffer.from(b64, "base64");
        const { value } = await mammoth.extractRawText({ buffer });
        if (!value || !value.trim()) {
          skipped.push({ name, reason: "it's a Word file with no readable text in it — if it's a scan, save it as a PDF and upload that" });
        } else {
          blocks.push({ type: "text", text: `Contents of ${name}:\n\n` + value.slice(0, 60000) });
          sourceKind = sourceKind || "docx";
          names.push(name);
        }
      } else if (lower.endsWith(".doc") || lower.endsWith(".dot") || mt === "application/msword") {
        // Legacy binary Word. mammoth can't read these; word-extractor can.
        const buffer = Buffer.from(b64, "base64");
        const extracted = await wordExtractor.extract(buffer);
        const value = (extracted.getBody() || "").trim();
        if (!value) {
          skipped.push({ name, reason: "it's an old-format Word file with no readable text — if it's a scan, save it as a PDF and upload that" });
        } else {
          blocks.push({ type: "text", text: `Contents of ${name}:\n\n` + value.slice(0, 60000) });
          sourceKind = sourceKind || "doc";
          names.push(name);
        }
      } else if (TEXT_EXTS.includes(ext) || ext === "") {
        const decoded = Buffer.from(b64, "base64").toString("utf8");
        if (!looksLikeText(decoded)) {
          skipped.push({ name, reason: "I couldn't find readable text in it" });
        } else {
          blocks.push({ type: "text", text: `Contents of ${name}:\n\n` + decoded.slice(0, 60000) });
          sourceKind = sourceKind || "text";
          names.push(name);
        }
      } else {
        skipped.push({ name, reason: `I can't read ${ext || "that kind of"} files yet — I can read PDF, Word (.doc or .docx), images or scans, and plain text` });
      }
    } catch (e) {
      console.error(`Ingest file error (${name}):`, e.message);
      skipped.push({ name, reason: "the file looks damaged, or its contents don't match its file type" });
    }
  }

  // Nothing readable came through (and no typed notes either). Tell the person
  // exactly why, file by file, instead of a vague "nothing useful."
  if (blocks.length === 0) {
    const detail = skipped.length
      ? " Here's what happened: " + skipped.map((s) => `"${s.name}" — ${s.reason}`).join("; ") + "."
      : "";
    return res.json({
      added: false,
      message: "I couldn't read anything to teach Benny from that." + detail,
    });
  }

  blocks.push({
    type: "text",
    text: "Turn the material above into ONE knowledge entry for Benny, following your instructions. Respond with only the JSON object.",
  });

  let parsed;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: [{ type: "text", text: INGEST_SYSTEM }],
        messages: [{ role: "user", content: blocks }],
      }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("Ingest API error:", r.status, t);
      return res.status(502).json({ error: "Benny's intake is temporarily unavailable. Please try again." });
    }
    const d = await r.json();
    const raw = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    parsed = extractJson(raw);
  } catch (e) {
    console.error("Ingest parse error:", e.message);
    return res.status(502).json({ error: "I read the material but the intake step failed before it finished. Please try again." });
  }

  const title = (parsed.title || "").trim();
  const body = (parsed.body || "").trim();
  const summary = (parsed.summary || "").trim();
  const testQuestion = (parsed.test_question || "").trim();

  if (!title || !body) {
    // We DID read the material — there just wasn't anything Benny could use.
    // Say that plainly, and still surface any files we couldn't open.
    const detail = skipped.length
      ? ` (I also couldn't read: ${skipped.map((s) => `"${s.name}" — ${s.reason}`).join("; ")}.)`
      : "";
    return res.json({
      added: false,
      message:
        "I read that, but I couldn't find benefits or 401(k) facts in it that Benny could use to answer employees. If it's the right document, add a sentence of context about what to capture and try again." +
        detail,
    });
  }

  let entryId;
  try {
    const ins = await pool.query(
      `INSERT INTO brain_entries (title, summary, body, source_kind, source_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [title.slice(0, 200), summary.slice(0, 500), body.slice(0, 20000), sourceKind || "text", names.join(", ").slice(0, 300)]
    );
    entryId = ins.rows[0].id;
  } catch (e) {
    console.error("Could not save brain entry:", e.message);
    return res.status(500).json({ error: "I understood it, but couldn't save it to the brain. Please try again." });
  }

  await loadBrainEntries();
  rebuildSystemPrompt();

  const q = testQuestion || `What can you tell me about ${title}?`;
  let bennyAnswer = "";
  try {
    bennyAnswer = await askBenny(q);
  } catch (e) {
    console.error("Test question error:", e.message);
  }

  res.json({
    added: true,
    entry: { id: entryId, title, summary },
    testQuestion: q,
    bennyAnswer: bennyAnswer || "(Benny didn't answer the test just now, but the entry was saved and is live.)",
    skipped: skipped.length ? skipped : undefined,
  });
});

// List every brain entry for the Logs tab.
app.get("/api/brain/entries", adminAuth, async (_req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false, rows: [] });
  try {
    const { rows } = await pool.query(
      `SELECT id, created_at, title, summary, source_kind, source_name, length(body) AS size_chars
       FROM brain_entries ORDER BY created_at DESC LIMIT 500`
    );
    res.json({ dbReady: true, rows });
  } catch (e) {
    console.error("Could not load brain entries:", e.message);
    res.status(500).json({ error: "Could not load entries." });
  }
});

// Delete a brain entry (removes the fact from Benny within seconds).
app.delete("/api/brain/entries/:id", adminAuth, async (req, res) => {
  if (!pool || !dbReady) return res.status(503).json({ error: "The brain log isn't available." });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Bad id." });
  try {
    await pool.query("DELETE FROM brain_entries WHERE id = $1", [id]);
    await loadBrainEntries();
    rebuildSystemPrompt();
    res.json({ ok: true });
  } catch (e) {
    console.error("Could not delete brain entry:", e.message);
    res.status(500).json({ error: "Could not delete that entry." });
  }
});

// Import a complete office employee handbook after text extraction. The
// endpoint is intentionally admin-only and never exposes or stores the source
// API credential. Content is deduplicated by a server-computed SHA-256 hash.
function parseHandbookFile(body, sourceName) {
  const base64 = String(body?.fileBase64 || "").trim();
  if (!base64) return { fileBytes: null, fileName: null, mimeType: null };
  if (base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { error: "The handbook file is not valid base64." };
  }

  const fileBytes = Buffer.from(base64, "base64");
  if (!fileBytes.length || fileBytes.length > HANDBOOK_MAX_FILE_BYTES) {
    return { error: "The handbook file must be between 1 byte and 5 MB." };
  }

  const requestedName = String(body?.fileName || sourceName || "").trim();
  const fileName = requestedName.split(/[\\/]/).pop().slice(0, 300);
  const extension = path.extname(fileName).toLowerCase();
  if (![".doc", ".docx", ".pdf"].includes(extension)) {
    return { error: "Only PDF, DOC, and DOCX handbook files are supported." };
  }
  const inferredMimeType =
    extension === ".pdf"
      ? "application/pdf"
      : extension === ".docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : "application/msword";
  const requestedMimeType = String(body?.mimeType || "").trim().toLowerCase();
  const mimeType = HANDBOOK_MIME_TYPES.has(requestedMimeType) ? requestedMimeType : inferredMimeType;
  if (!HANDBOOK_MIME_TYPES.has(mimeType)) {
    return { error: "Only PDF, DOC, and DOCX handbook files are supported." };
  }

  return { fileBytes, fileName, mimeType };
}

app.post("/api/brain/office-handbooks/import", adminAuth, async (req, res) => {
  if (!pool || !dbReady) {
    return res.status(503).json({ error: "The database isn't connected, so office handbooks cannot be saved." });
  }

  const sourceName = String(req.body?.sourceName || "").trim();
  const sourceAttachmentId = String(req.body?.sourceAttachmentId || "").trim();
  const sourceDate = new Date(req.body?.sourceDate || "");
  const fullText = normalizeHandbookText(req.body?.text);
  const handbookFile = parseHandbookFile(req.body, sourceName);
  const requestedAgencies = Array.isArray(req.body?.agencies) ? req.body.agencies.slice(0, 12) : [];
  const agencies = requestedAgencies
    .map((item) => getOfficeAgency(typeof item === "string" ? item : item?.slug))
    .filter(Boolean);
  const uniqueAgencies = [...new Map(agencies.map((agency) => [agency.slug, agency])).values()];

  if (!sourceName || Number.isNaN(sourceDate.valueOf()) || fullText.length < 500 || !uniqueAgencies.length) {
    return res.status(400).json({
      error: "A source name, valid source date, readable handbook text, and at least one recognized agency are required.",
    });
  }
  if (fullText.length > 500_000) {
    return res.status(413).json({ error: "The extracted handbook text is too large." });
  }
  if (handbookFile.error) {
    return res.status(400).json({ error: handbookFile.error });
  }

  const contentHash = handbookContentHash(fullText);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let handbookId;
    let added = false;
    let fileStored = false;
    const existing = await client.query(
      `SELECT id, file_bytes IS NOT NULL AS has_file FROM office_handbooks WHERE content_hash = $1`,
      [contentHash]
    );
    if (existing.rows.length) {
      handbookId = existing.rows[0].id;
      fileStored = existing.rows[0].has_file || Boolean(handbookFile.fileBytes);
      if (handbookFile.fileBytes) {
        await client.query(
          `UPDATE office_handbooks
           SET file_name = COALESCE(file_name, $2),
               mime_type = COALESCE(mime_type, $3),
               file_bytes = COALESCE(file_bytes, $4)
           WHERE id = $1`,
          [handbookId, handbookFile.fileName, handbookFile.mimeType, handbookFile.fileBytes]
        );
      }
    } else {
      const inserted = await client.query(
        `INSERT INTO office_handbooks
           (source_date, source_name, source_attachment_id, content_hash, full_text,
            file_name, mime_type, file_bytes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          sourceDate.toISOString(),
          sourceName.slice(0, 300),
          sourceAttachmentId.slice(0, 100) || null,
          contentHash,
          fullText,
          handbookFile.fileName,
          handbookFile.mimeType,
          handbookFile.fileBytes,
        ]
      );
      handbookId = inserted.rows[0].id;
      added = true;
      fileStored = Boolean(handbookFile.fileBytes);
    }

    const mapped = [];
    const keptNewer = [];
    for (const agency of uniqueAgencies) {
      const result = await client.query(
        `INSERT INTO office_handbook_agencies
           (agency_slug, agency_name, handbook_id, source_date, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (agency_slug) DO UPDATE SET
           agency_name = EXCLUDED.agency_name,
           handbook_id = EXCLUDED.handbook_id,
           source_date = EXCLUDED.source_date,
           updated_at = now()
         WHERE EXCLUDED.source_date >= office_handbook_agencies.source_date
         RETURNING agency_slug`,
        [agency.slug, agency.name, handbookId, sourceDate.toISOString()]
      );
      if (result.rows.length) mapped.push(agency.slug);
      else keptNewer.push(agency.slug);
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      added,
      duplicate: !added,
      sourceName,
      handbookId,
      mapped,
      keptNewer,
      textChars: fullText.length,
      fileStored,
      fileName: handbookFile.fileName,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("Could not import office handbook:", error.message);
    res.status(500).json({ error: "The office handbook import failed." });
  } finally {
    client.release();
  }
});

app.get("/api/brain/office-handbooks", adminAuth, async (_req, res) => {
  if (!pool || !dbReady) return res.json({ dbReady: false, rows: [] });
  try {
    const { rows } = await pool.query(
      `SELECT h.id, h.created_at, h.source_date, h.source_name,
              length(h.full_text) AS text_chars,
              h.file_name,
              octet_length(h.file_bytes) AS file_bytes,
              array_agg(a.agency_slug ORDER BY a.agency_slug) FILTER (WHERE a.agency_slug IS NOT NULL) AS agencies
       FROM office_handbooks h
       LEFT JOIN office_handbook_agencies a ON a.handbook_id = h.id
       WHERE h.enabled = true
       GROUP BY h.id
       ORDER BY h.source_date DESC, h.source_name`
    );
    res.json({ dbReady: true, rows });
  } catch (error) {
    console.error("Could not list office handbooks:", error.message);
    res.status(500).json({ error: "Could not load office handbooks." });
  }
});

function handbookContentDisposition(fileName) {
  const cleanName = String(fileName || "employee-handbook")
    .replace(/[\r\n]/g, "")
    .split(/[\\/]/)
    .pop()
    .slice(0, 300);
  const asciiName = cleanName.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  const encodedName = encodeURIComponent(cleanName).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;
}

app.get("/api/office-handbooks/:agencySlug/download", async (req, res) => {
  const agency = getOfficeAgency(req.params.agencySlug);
  const expires = req.query.expires;
  const signature = req.query.sig;
  if (
    !agency ||
    !verifyHandbookDownloadSignature({
      agencySlug: agency.slug,
      expires,
      signature,
      secret: HANDBOOK_DOWNLOAD_SECRET,
    })
  ) {
    return res.status(403).send("This handbook link is invalid or has expired.");
  }
  if (!pool || !dbReady) {
    return res.status(503).send("The handbook service is temporarily unavailable.");
  }

  try {
    const { rows } = await pool.query(
      `SELECT h.source_name, h.file_name, h.mime_type, h.file_bytes
       FROM office_handbook_agencies a
       JOIN office_handbooks h ON h.id = a.handbook_id
       WHERE a.agency_slug = $1 AND h.enabled = true
       LIMIT 1`,
      [agency.slug]
    );
    if (!rows.length || !rows[0].file_bytes) {
      return res.status(404).send("A downloadable copy of this handbook is not available.");
    }

    const row = rows[0];
    const fileName = row.file_name || row.source_name || `${agency.slug}-employee-handbook`;
    const mimeType = HANDBOOK_MIME_TYPES.has(row.mime_type) ? row.mime_type : "application/octet-stream";
    res.set({
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": handbookContentDisposition(fileName),
      "Content-Length": String(row.file_bytes.length),
      "Content-Type": mimeType,
      "X-Content-Type-Options": "nosniff",
    });
    return res.send(row.file_bytes);
  } catch (error) {
    console.error("Could not download office handbook:", error.message);
    return res.status(500).send("The handbook could not be downloaded.");
  }
});

// --- Static site (the employee-facing assistant) ---------------------------
// Everything lives in one flat folder, so we serve ONLY an explicit allow-list.
// This keeps internal files (server.js, prompt.js, knowledge-base.md,
// admin-page.html, brain-page.html, Dockerfile, configs) private even though
// they sit alongside the public assets.
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/styles.css": "styles.css",
  "/app.js": "app.js",
  "/honor-health-logo.jpg": "honor-health-logo.jpg",
  "/assistant-avatar.png": "assistant-avatar.png",
  "/benny-favicon-transparent.png": "benny-favicon-transparent.png",
  "/benny.png": "benny.png",
};
const PUBLIC_PDFS = new Set([
  "2026-engage-benefits-summary.pdf",
  "401k-enrollment-booklet.pdf",
  "accessing-your-account.pdf",
  "hardship-withdrawal-request.pdf",
  "incoming-rollover-request.pdf",
]);

app.get(Object.keys(STATIC_FILES), (req, res) => {
  res.sendFile(path.join(__dirname, STATIC_FILES[req.path]));
});

// The knowledge base links PDFs as /forms/<n>.pdf, but they live at the root.
app.get("/forms/:name", (req, res) => {
  if (PUBLIC_PDFS.has(req.params.name)) {
    return res.sendFile(path.join(__dirname, req.params.name));
  }
  res.status(404).send("Not found.");
});

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HHN Benefits Assistant running on port ${PORT} (model: ${MODEL})`));
