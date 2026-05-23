import "dotenv/config";
import { Bot, InlineKeyboard } from "grammy";
import { exec, spawn } from "child_process";
import { promisify } from "util";
import os from "os";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";

const execAsync = promisify(exec);

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN tidak ditemukan di .env");
  process.exit(1);
}

const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const OPENCODE_PATH = process.env.OPENCODE_PATH || "opencode";
const WORK_DIR = process.env.WORK_DIR || (process.platform === "win32" ? "C:\\Projects\\tugas-lokal" : "/root/projects");
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || (process.platform === "win32" ? "enowxlabs/claude-opus-4.6" : "9router/kr/claude-opus-4.6");
const MAX_MSG_LENGTH = 4000;
const DEFAULT_TIMEOUT = 15 * 60 * 1000;

// --- Bot Instance ---
const bot = new Bot(BOT_TOKEN);

// --- Per-user OpenCode session ---
interface UserSession {
  sessionId: string | null;
  busy: boolean;
  model: string;
  agent: string;
  workDir: string;
  timeout: number;
  // Runtime state (gak di-persist)
  _timer?: ReturnType<typeof setTimeout>;
  _startTime?: number;
  _timeoutMs?: number;
  _proc?: any;
  _resolve?: (value: string) => void;
  _outFile?: string;
  _typingInterval?: ReturnType<typeof setInterval>;
}

const sessions: Record<number, UserSession> = {};

// --- Persistent storage ---
const DATA_DIR = path.join(__dirname, "..");
const LABELS_FILE = path.join(DATA_DIR, "session-labels.json");
const STATE_FILE = path.join(DATA_DIR, "session-state.json");

let sessionLabels: Record<string, string> = {};

// Load labels
function loadLabels() {
  try {
    if (fs.existsSync(LABELS_FILE)) {
      sessionLabels = JSON.parse(fs.readFileSync(LABELS_FILE, "utf-8"));
    }
  } catch {}
}

// Save labels
function saveLabels() {
  try {
    fs.writeFileSync(LABELS_FILE, JSON.stringify(sessionLabels, null, 2));
  } catch {}
}

// Load session state (persist antar restart)
function loadSessionState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
      for (const [userId, state] of Object.entries(data)) {
        const s = state as any;
        sessions[Number(userId)] = {
          sessionId: s.sessionId || null,
          busy: false,
          model: s.model || DEFAULT_MODEL,
          agent: s.agent || "build",
          workDir: s.workDir || WORK_DIR,
          timeout: s.timeout || DEFAULT_TIMEOUT,
        };
      }
      console.log(`📂 Loaded session state for ${Object.keys(data).length} user(s)`);
    }
  } catch {}
}

// Save session state
function saveSessionState() {
  try {
    const data: Record<string, any> = {};
    for (const [userId, session] of Object.entries(sessions)) {
      data[userId] = {
        sessionId: session.sessionId,
        model: session.model,
        agent: session.agent,
        workDir: session.workDir,
        timeout: session.timeout,
      };
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch {}
}

loadLabels();
loadSessionState();

function getSession(userId: number): UserSession {
  if (!sessions[userId]) {
    sessions[userId] = {
      sessionId: null,
      busy: false,
      model: DEFAULT_MODEL,
      agent: "build",
      workDir: WORK_DIR,
      timeout: DEFAULT_TIMEOUT,
    };
  }
  return sessions[userId];
}

// --- Helper: Get session list from OpenCode ---
interface OcSession {
  id: string;
  title: string;
  updated: string;
  directory: string;
}

async function getOpenCodeSessions(filterDir?: string): Promise<OcSession[]> {
  try {
    const { stdout } = await execAsync(`${OPENCODE_PATH} session list --format json`, {
      timeout: 10000,
      cwd: WORK_DIR,
      env: { ...process.env, PATH: `/root/.opencode/bin:/usr/bin:/usr/local/bin:/bin:${process.env.PATH || ""}`, OPENCODE_RUN_ID: "", OPENCODE_PID: "", OPENCODE_PROCESS_ROLE: "", OPENCODE: "" },
    });

    const raw = JSON.parse(stdout.trim());
    const results: OcSession[] = [];

    for (const s of raw) {
      // Filter by directory kalau diminta
      if (filterDir) {
        const sessionDir = (s.directory || "").toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
        const targetDir = filterDir.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
        if (sessionDir !== targetDir) continue;
      }

      const date = new Date(s.updated);
      const timeStr = date.toLocaleString("id-ID", {
        hour: "2-digit", minute: "2-digit",
        day: "numeric", month: "short", year: "numeric",
      });

      results.push({
        id: s.id,
        title: (s.title || "Untitled").replace(/\n/g, "").trim(),
        updated: timeStr,
        directory: s.directory || "",
      });
    }

    return results;
  } catch {
    return [];
  }
}

// --- Middleware: Auth Check ---
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId || "")) {
    await ctx.reply("⛔ Akses ditolak.");
    return;
  }
  await next();
});

// --- Helper: Truncate ---
function truncate(text: string, max: number = MAX_MSG_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n\n... (terpotong)";
}

// --- Helper: Escape HTML ---
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getOpenCodeConfig(): any | null {
  const configPath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

function getModelChoices() {
  const configData = getOpenCodeConfig();
  if (!configData) return [] as Array<{ id: string; label: string; activeLabel: string }>;

  const providers = configData.provider || {};
  const items: Array<{ id: string; label: string; activeLabel: string }> = [];

  for (const [provId, prov] of Object.entries(providers) as any[]) {
    const models = prov.models || {};
    for (const modelId of Object.keys(models)) {
      const fullId = `${provId}/${modelId}`;
      const name = models[modelId]?.name || modelId;
      items.push({
        id: fullId,
        label: `${provId}: ${name}`,
        activeLabel: name,
      });
    }
  }

  return items;
}

function getProviderChoices() {
  const configData = getOpenCodeConfig();
  if (!configData) return [] as Array<{ id: string; name: string; count: number }>;

  const providers = configData.provider || {};
  const items: Array<{ id: string; name: string; count: number }> = [];

  for (const [provId, prov] of Object.entries(providers) as any[]) {
    const models = prov.models || {};
    const count = Object.keys(models).length;
    if (count === 0) continue;
    items.push({ id: provId, name: prov.name || provId, count });
  }

  return items;
}

function getModelsByProvider(providerId: string) {
  return getModelChoices().filter((choice) => choice.id.startsWith(`${providerId}/`));
}

async function getServiceHealthSummary() {
  const services = ["telebot", "kiro-refresh", "9router", "cloudflared-enowxai", "nginx"];
  const results: Array<{ name: string; state: string; since: string; note: string }> = [];

  for (const service of services) {
    try {
      const { stdout } = await execAsync(
        `systemctl show ${service} --property=ActiveState,SubState,ActiveEnterTimestamp --value`,
        { timeout: 5000 }
      );
      const [activeState = "unknown", subState = "unknown", activeEnter = ""] = stdout.trim().split("\n");

      results.push({
        name: service,
        state: `${activeState}/${subState}`,
        since: activeEnter || "-",
        note:
          service === "telebot"
            ? "bot Telegram OpenCode"
            : service === "kiro-refresh"
              ? "refresh token Kiro"
              : service === "9router"
                ? "router model lokal"
                : service === "cloudflared-enowxai"
                  ? "tunnel Cloudflare"
                  : "reverse proxy",
      });
    } catch {
      results.push({ name: service, state: "error", since: "-", note: "gagal dibaca" });
    }
  }

  return results;
}

// --- Helper: Convert Markdown to Telegram HTML ---
function markdownToHtml(text: string): string {
  // Split by code blocks first to handle them separately
  const parts = text.split(/(```[\s\S]*?```)/g);
  
  const converted = parts.map((part, i) => {
    // Code blocks — escape HTML inside, wrap in <pre><code>
    if (part.startsWith("```")) {
      const content = part.replace(/```[\w]*\n?/, "").replace(/\n?```$/, "");
      return `<pre><code>${escapeHtml(content)}</code></pre>`;
    }

    // Regular text — escape first, then apply markdown
    let result = escapeHtml(part);

    // Inline code (`...`) → <code>...</code>
    result = result.replace(/`([^`\n]+)`/g, "<code>$1</code>");

    // Bold+Italic (***...***)
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");

    // Bold (**...**)
    result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

    // Italic (*...*)
    result = result.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<i>$1</i>");

    // Strikethrough (~~...~~)
    result = result.replace(/~~(.+?)~~/g, "<s>$1</s>");

    // Headers (## ...) → bold
    result = result.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

    // Bullet points (- item or * item at start of line) → • item
    result = result.replace(/^[\-]\s+/gm, "• ");

    return result;
  });

  return converted.join("");
}

// --- Helper: Send long message (split if needed) ---
async function sendLongMessage(ctx: any, text: string, parseMode?: "HTML") {
  if (!text || !text.trim()) {
    await ctx.reply("(empty response)");
    return;
  }

  // Sanitize: hapus null bytes dan karakter kontrol aneh
  const clean = text.replace(/\x00/g, "").replace(/[\x01-\x08\x0B\x0C\x0E-\x1F]/g, "");

  const maxLen = 4000;
  const chunks: string[] = [];

  let current = "";
  let inCodeBlock = false;

  for (const line of clean.split("\n")) {
    // Track code block state
    if (line.startsWith("<pre><code>") || line.includes("<pre><code>")) inCodeBlock = true;
    if (line.includes("</code></pre>")) inCodeBlock = false;

    if ((current + "\n" + line).length > maxLen && current.length > 0) {
      // If we're inside a code block, close it before splitting
      if (inCodeBlock) {
        current += "\n</code></pre>";
        chunks.push(current);
        current = "<pre><code>" + line;
      } else {
        chunks.push(current);
        current = line;
      }
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);

  console.log(`📨 Sending ${chunks.length} chunk(s), total ${clean.length} chars`);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      if (parseMode) {
        await ctx.reply(chunk, { parse_mode: parseMode });
      } else {
        await ctx.reply(chunk);
      }
      console.log(`  ✅ Chunk ${i + 1}/${chunks.length} sent (${chunk.length} chars)`);
    } catch (err1: any) {
      console.log(`  ⚠️ Chunk ${i + 1} error: ${err1.message?.slice(0, 150)}`);
      try {
        const plain = chunk.replace(/<[^>]*>/g, "").slice(0, 4000);
        await ctx.reply(plain);
        console.log(`  ✅ Chunk ${i + 1} sent as plain text`);
      } catch (err2: any) {
        console.log(`  ❌ Chunk ${i + 1} failed: ${err2.message?.slice(0, 150)}`);
        try {
          await ctx.reply(`(Chunk ${i + 1} gagal dikirim — ${chunk.length} chars)`);
        } catch {}
      }
    }
  }
}

// --- Parse OpenCode JSON output ---
function parseOpenCodeOutput(raw: string): { text: string; toolUses: string[]; sessionId: string | null } {
  const textParts: string[] = [];
  const toolUses: string[] = [];
  let sessionId: string | null = null;

  for (const line of raw.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.sessionID) sessionId = event.sessionID;
      if (event.type === "text" && event.part?.text) {
        textParts.push(event.part.text);
      }
      // Capture tool output (bash, read, etc.)
      if ((event.type === "tool_use" || event.type === "tool-use") && event.part?.state?.output) {
        const tool = event.part?.tool || "";
        const output = event.part.state.output;
        // Only include substantial output (skip tiny outputs)
        if (output.trim().length > 0 && ["bash", "read", "grep", "glob"].includes(tool)) {
          textParts.push(`\n\`\`\`\n${output.trim()}\n\`\`\`\n`);
        }
      }
      const toolInfo = parseToolInfo(event);
      if (toolInfo) toolUses.push(toolInfo);
    } catch {}
  }

  return { text: textParts.join("").trim(), toolUses, sessionId };
}

// --- Parse tool info from event ---
function parseToolInfo(event: any): string | null {
  if (event.type !== "tool_use" && event.type !== "tool-use") return null;
  const tool = event.part?.tool || "unknown";
  const input = event.part?.state?.input || event.part?.input;
  if (tool === "bash" && input?.command) return `⚡ ${input.command}`;
  if (tool === "edit" && input?.filePath) return `✏️ edit: ${input.filePath}`;
  if (tool === "write" && input?.filePath) return `📝 write: ${input.filePath}`;
  if (tool === "read" && input?.filePath) return `📖 read: ${input.filePath}`;
  if (tool === "webfetch" && input?.url) return `🌐 ${input.url}`;
  if (tool === "grep" && input?.pattern) return `🔍 grep: ${input.pattern}`;
  if (tool === "glob" && input?.pattern) return `📂 glob: ${input.pattern}`;
  return `🔧 ${tool}`;
}

// --- Core: Run OpenCode (spawn + shell:true — proven works) ---
async function runOpenCode(
  userId: number,
  message: string,
  ctx: any,
  files?: string[], // Optional file attachments
): Promise<string> {
  const session = getSession(userId);

  if (session.busy) {
    return "⏳ OpenCode masih proses pesan sebelumnya. Tunggu ya...";
  }

  session.busy = true;

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  // Temp file sebagai backup — kalau stdout gak ke-capture, baca dari file
  const outFile = path.join(os.tmpdir(), `oc_${userId}_${Date.now()}.jsonl`);

  return new Promise((resolve) => {
    const parts: string[] = [
      OPENCODE_PATH, "run",
      "--model", session.model,
      "--agent", session.agent,
      "--dangerously-skip-permissions",
      "--format", "json",
      "--dir", `"${session.workDir}"`,
    ];

    if (session.sessionId) {
      parts.splice(2, 0, "--session", session.sessionId);
    }

    // Attach files (gambar, dokumen, dll)
    if (files && files.length > 0) {
      for (const f of files) {
        parts.push("--file", `"${f}"`);
      }
    }

    const safeMsg = message.replace(/"/g, '\\"');
    parts.push("--", `"${safeMsg}"`);

    const isWindows = process.platform === "win32";
    console.log(`\n📤 [User ${userId}] → "${message.slice(0, 80)}"`);

    let fullCmd: string;
    let spawnOpts: any;

    if (isWindows) {
      fullCmd = `${parts.join(" ")} | Tee-Object -FilePath "${outFile}"`;
      spawnOpts = {
        cwd: session.workDir,
        shell: "powershell.exe",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      };
    } else {
      // Linux: pakai wrapper script yang redirect ke file
      const scriptPath = path.join(__dirname, "..", "run_oc.sh");
      fullCmd = `bash "${scriptPath}" "${outFile}" ${parts.slice(1).join(" ")}`;
      spawnOpts = {
        cwd: session.workDir,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", PATH: `/root/.opencode/bin:/usr/bin:/usr/local/bin:/bin:${process.env.PATH || ""}` },
      };
    }

    const proc = spawn(fullCmd, [], spawnOpts);

    let output = "";

    proc.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    proc.stderr.on("data", () => {});

    // Simpan references buat extend/cancel
    session._startTime = Date.now();
    session._timeoutMs = session.timeout;
    session._proc = proc;
    session._outFile = outFile;
    session._typingInterval = typingInterval;

    function startTimeout() {
      const remaining = session._timeoutMs! - (Date.now() - session._startTime!);
      if (remaining <= 0) {
        proc.kill();
        cleanup();
        try { fs.unlinkSync(outFile); } catch {}
        resolve(`⏱️ Timeout!\n\n💡 Pakai /extend <menit> untuk nambah waktu saat proses jalan.`);
        return;
      }

      session._timer = setTimeout(() => {
        proc.kill();
        cleanup();
        try { fs.unlinkSync(outFile); } catch {}
        const totalMin = Math.round(session._timeoutMs! / 60000);
        resolve(`⏱️ Timeout setelah ${totalMin} menit.\n\n💡 Pakai /extend <menit> untuk nambah waktu.`);
      }, remaining);
    }

    startTimeout();

    // Simpan resolve buat extend
    session._resolve = resolve;

    function cleanup() {
      if (session._timer) clearTimeout(session._timer);
      clearInterval(typingInterval);
      session.busy = false;
      session._timer = undefined;
      session._proc = undefined;
      session._resolve = undefined;
      session._outFile = undefined;
      session._typingInterval = undefined;
    }

    proc.on("close", (code) => {
      cleanup();

      // Baca output dari file — poll sampe ada "step_finish" atau "error"
      const readOutput = async () => {
        // Initial delay — biar file selesai ditulis
        await new Promise((r) => setTimeout(r, 3000));

        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            if (fs.existsSync(outFile)) {
              const fileOutput = fs.readFileSync(outFile, "utf-8");
              if (fileOutput.length > output.length) {
                output = fileOutput;
              }
              // Cek apakah response complete
              const isComplete = output.includes('"reason":"stop"') ||
                                 output.includes('"reason":"tool-calls"') ||
                                 output.includes('"type":"error"');
              if (isComplete) {
                console.log(`📂 Complete: ${output.length} bytes (attempt ${attempt + 1})`);
                break;
              }
            }
          } catch {}

          // Tunggu 2 detik sebelum retry
          if (attempt < 14) await new Promise((r) => setTimeout(r, 2000));
        }

        // Cleanup temp file
        try { fs.unlinkSync(outFile); } catch {}

        // Parse output
        const parsed = parseOpenCodeOutput(output);

        if (parsed.sessionId) {
          session.sessionId = parsed.sessionId;
          saveSessionState();
          console.log(`📋 Session: ${parsed.sessionId}`);
        }

        parsed.toolUses.forEach((t) => console.log(`  ${t}`));
        console.log(`📥 [User ${userId}] ← ${parsed.text.length}ch, ${parsed.toolUses.length} tools, exit:${code}`);

        if (parsed.text) {
          let tools = "";
          if (parsed.toolUses.length > 0) {
            const toolList = parsed.toolUses.join("\n");
            tools = `\n\n<blockquote expandable>🛠 Tools (${parsed.toolUses.length})\n${toolList}</blockquote>`;
          }
          resolve(parsed.text + tools);
        } else {
          resolve(`(No text, exit ${code})\n\nRaw:\n${output.slice(0, 3000)}`);
        }
      };

      readOutput();
    });

    proc.on("error", (err) => {
      cleanup();
      try { fs.unlinkSync(outFile); } catch {}
      resolve(`❌ ${err.message}`);
    });
  });
}

// --- Helper: Run shell command ---
async function runShell(command: string, timeout: number = 30000): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      timeout,
      maxBuffer: 1024 * 1024,
    });
    return (stdout || "").trim() + (stderr ? `\n${stderr.trim()}` : "");
  } catch (error: any) {
    return `❌ ${error.message}`;
  }
}

// ============================================
// COMMANDS
// ============================================

// --- /start ---
bot.command("start", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  await ctx.reply(
    `🖥️ <b>OpenCode Remote — Telegram</b>\n\n` +
      `Akses OpenCode langsung dari Telegram!\n` +
      `Semua yang bisa lo lakuin di OpenCode, bisa dari sini.\n\n` +
      `<b>📋 Status:</b>\n` +
      `• Model: <code>${session.model}</code>\n` +
      `• Agent: <code>${session.agent}</code>\n` +
      `• Dir: <code>${session.workDir}</code>\n` +
      `• Session: <code>${session.sessionId || "baru"}</code>\n\n` +
      `<b>💡 Cara pakai:</b>\n` +
      `Ketik langsung aja, sama kayak di OpenCode!\n\n` +
      `Contoh:\n` +
      `• "buatkan file hello.py"\n` +
      `• "fix bug di src/index.ts"\n` +
      `• "jelaskan kode di folder src"\n\n` +
      `/help — Lihat semua command`,
    { parse_mode: "HTML" }
  );
});

// --- /help ---
bot.command("help", async (ctx) => {
  await ctx.reply(
    `📖 <b>OpenCode Remote — Commands</b>\n\n` +
      `<b>🧠 OpenCode:</b>\n` +
      `• Ketik langsung → dikirim ke OpenCode\n` +
      `• /model &lt;model&gt; — Ganti model\n` +
      `• /agent &lt;agent&gt; — Ganti agent\n` +
      `• /dir &lt;path&gt; — Ganti working directory\n\n` +
      `<b>📋 Session Management:</b>\n` +
      `• /sessions — List semua session\n` +
      `• /session — Info session aktif\n` +
      `• /switch &lt;id/label&gt; — Switch ke session lain\n` +
      `• /label &lt;nama&gt; — Kasih label session aktif\n` +
      `• /rename &lt;nama&gt; — Rename session aktif\n` +
      `• /delete &lt;id/label&gt; — Hapus session\n` +
      `• /new — Mulai session baru\n` +
      `• /continue — Lanjut session terakhir\n` +
      `• /reset — Force reset (kalau stuck)\n\n` +
      `<b>🔧 System:</b>\n` +
      `• /shell &lt;cmd&gt; — Jalanin shell command\n` +
      `• /status — Info sistem\n` +
      `• /healthz — Ringkasan health service\n\n` +
      `<b>📦 Models:</b> opus-4.6, sonnet-4.5\n` +
      `<b>🤖 Agents:</b> build, plan`,
    { parse_mode: "HTML" }
  );
});

// --- /model ---
bot.command("model", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const newModel = ctx.match?.trim();

  if (!newModel) {
    await ctx.reply(
      `🧠 <b>Model aktif:</b> <code>${session.model}</code>\n\n` +
        `Ganti dengan:\n` +
        `• /model ${DEFAULT_MODEL}\n` +
        `• /model enowxlabs/claude-sonnet-4.5`,
      { parse_mode: "HTML" }
    );
    return;
  }

  session.model = newModel;
  saveSessionState();
  await ctx.reply(`✅ Model diganti ke <code>${newModel}</code>`, { parse_mode: "HTML" });
});

// --- /agent ---
bot.command("agent", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const newAgent = ctx.match?.trim();

  if (!newAgent) {
    await ctx.reply(
      `🤖 <b>Agent aktif:</b> <code>${session.agent}</code>\n\n` +
        `Ganti dengan:\n` +
        `• /agent build — Full-stack engineer\n` +
        `• /agent plan — Architect (read-only)`,
      { parse_mode: "HTML" }
    );
    return;
  }

  session.agent = newAgent;
  saveSessionState();
  await ctx.reply(`✅ Agent diganti ke <code>${newAgent}</code>`, { parse_mode: "HTML" });
});

// --- /dir ---
bot.command("dir", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const newDir = ctx.match?.trim();

  if (!newDir) {
    await ctx.reply(
      `📁 <b>Working directory:</b>\n<code>${session.workDir}</code>\n\n` +
        `Ganti: /dir C:\\Projects\\my-project`,
      { parse_mode: "HTML" }
    );
    return;
  }

  session.workDir = newDir;
  saveSessionState();
  await ctx.reply(`✅ Working directory: <code>${newDir}</code>`, { parse_mode: "HTML" });
});

// --- /session --- (info session aktif)
bot.command("session", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const label = session.sessionId ? sessionLabels[session.sessionId] : null;
  const shortId = session.sessionId ? session.sessionId.slice(-8) : "—";

  await ctx.reply(
    `📋 <b>Session Aktif</b>\n\n` +
      `• ID: <code>${shortId}</code>${label ? ` (${label})` : ""}\n` +
      `• Full ID: <code>${session.sessionId || "belum ada"}</code>\n` +
      `• Model: <code>${session.model}</code>\n` +
      `• Agent: <code>${session.agent}</code>\n` +
      `• Dir: <code>${session.workDir}</code>\n` +
      `• Timeout: ${Math.round(session.timeout / 60000)} menit\n` +
      `• Busy: ${session.busy ? "⏳ Ya" : "✅ Tidak"}`,
    { parse_mode: "HTML" }
  );
});

// --- /sessions --- (list semua session)
bot.command("sessions", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const arg = ctx.match?.trim().toLowerCase();
  const showAll = arg === "all" || arg === "semua";

  await ctx.reply("📋 Mengambil daftar session...");

  // Filter by working directory (sama kayak OpenCode CLI), kecuali /sessions all
  const ocSessions = await getOpenCodeSessions(showAll ? undefined : session.workDir);

  if (ocSessions.length === 0) {
    await ctx.reply(
      showAll
        ? "Tidak ada session ditemukan."
        : `Tidak ada session di <code>${session.workDir}</code>\n\nCoba /sessions all untuk lihat semua.`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = ocSessions.map((s, i) => {
    const label = sessionLabels[s.id];
    const active = s.id === session.sessionId ? " ✅" : "";
    const shortId = s.id.slice(-8);
    const displayName = label || s.title;
    const dirStr = showAll ? `\n   📁 ${s.directory}` : "";
    return `${i + 1}. <b>${escapeHtml(displayName)}</b>${active}\n   <code>${shortId}</code> · ${s.updated}${dirStr}`;
  });

  const header = showAll
    ? `📋 <b>Semua Sessions</b> (${ocSessions.length})`
    : `📋 <b>Sessions</b> di ${escapeHtml(session.workDir)} (${ocSessions.length})`;

  await sendLongMessage(ctx,
    `${header}\n\n` +
      lines.join("\n\n") +
      `\n\n💡 Switch: /switch &lt;nomor/label/id&gt;` +
      (showAll ? "" : `\n📂 /sessions all — lihat semua project`),
    "HTML"
  );
});

// --- /switch <id|label|number> ---
bot.command("switch", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const input = ctx.match?.trim();

  if (!input) {
    await ctx.reply("⚠️ Kasih ID, label, atau nomor session.\nContoh: /switch 3\nAtau: /switch my-project\nAtau: /switch ses_xxx");
    return;
  }

  // Search di semua sessions (gak filter directory, biar bisa switch antar project)
  const ocSessions = await getOpenCodeSessions();

  let targetId: string | null = null;
  let targetTitle = "";
  let targetDir = "";

  // 1. Coba match by nomor (1, 2, 3, ...)
  const num = parseInt(input);
  if (!isNaN(num) && num >= 1 && num <= ocSessions.length) {
    targetId = ocSessions[num - 1].id;
    targetTitle = ocSessions[num - 1].title;
    targetDir = ocSessions[num - 1].directory;
  }

  // 2. Coba match by label
  if (!targetId) {
    const entry = Object.entries(sessionLabels).find(
      ([, label]) => label.toLowerCase() === input.toLowerCase()
    );
    if (entry) {
      targetId = entry[0];
      targetTitle = sessionLabels[targetId] || "";
    }
  }

  // 3. Coba match by session ID (full atau partial)
  if (!targetId) {
    const found = ocSessions.find(
      (s) => s.id === input || s.id.endsWith(input)
    );
    if (found) {
      targetId = found.id;
      targetTitle = found.title;
    }
  }

  // 4. Coba match by title (partial)
  if (!targetId) {
    const found = ocSessions.find(
      (s) => s.title.toLowerCase().includes(input.toLowerCase())
    );
    if (found) {
      targetId = found.id;
      targetTitle = found.title;
    }
  }

  if (!targetId) {
    await ctx.reply(`❌ Session "${input}" tidak ditemukan.\nCoba /sessions untuk lihat daftar.`);
    return;
  }

  session.sessionId = targetId;
  session.busy = false;

  // Update workDir kalau session dari project lain
  if (targetDir) {
    session.workDir = targetDir;
  }
  saveSessionState();

  const label = sessionLabels[targetId];
  const shortId = targetId.slice(-8);

  await ctx.reply(
    `✅ Switched ke: <b>${escapeHtml(targetTitle)}</b>${label ? ` [${label}]` : ""}\n` +
      `ID: <code>${shortId}</code>` +
      (targetDir && targetDir !== session.workDir ? `\n📁 Dir: <code>${escapeHtml(targetDir)}</code>` : ""),
    { parse_mode: "HTML" }
  );
});

// --- /label <nama> ---
bot.command("label", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const label = ctx.match?.trim();

  if (!session.sessionId) {
    await ctx.reply("⚠️ Belum ada session aktif. Kirim pesan dulu ke OpenCode.");
    return;
  }

  if (!label) {
    const current = sessionLabels[session.sessionId];
    if (current) {
      await ctx.reply(`🏷️ Label session ini: <b>${current}</b>\n\nGanti: /label nama-baru`, { parse_mode: "HTML" });
    } else {
      await ctx.reply("⚠️ Session ini belum punya label.\nContoh: /label my-project");
    }
    return;
  }

  sessionLabels[session.sessionId] = label;
  saveLabels();

  await ctx.reply(`🏷️ Label disimpan: <b>${label}</b>`, { parse_mode: "HTML" });
});

// --- /new ---
bot.command("new", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  session.sessionId = null;
  session.busy = false;
  saveSessionState();
  await ctx.reply("🆕 Session baru! Context di-reset.");
});

// --- /continue ---
bot.command("continue", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  const ocSessions = await getOpenCodeSessions();
  if (ocSessions.length === 0) {
    await ctx.reply("❌ Tidak ada session sebelumnya.");
    return;
  }

  // Ambil session paling baru
  const latest = ocSessions[0];
  session.sessionId = latest.id;
  session.busy = false;
  saveSessionState();
  const label = sessionLabels[latest.id];
  const shortId = latest.id.slice(-8);

  await ctx.reply(
    `▶️ Melanjutkan: <b>${latest.title}</b>${label ? ` [${label}]` : ""}\n` +
      `ID: <code>${shortId}</code> · ${latest.updated}`,
    { parse_mode: "HTML" }
  );
});

// --- /timeout ---
bot.command("timeout", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const input = ctx.match?.trim();

  if (!input) {
    const currentMin = Math.round(session.timeout / 60000);
    await ctx.reply(
      `⏱️ Timeout: <b>${currentMin} menit</b>\n\nGanti: /timeout &lt;menit&gt;\nContoh: /timeout 30`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const minutes = parseInt(input);
  if (isNaN(minutes) || minutes < 1 || minutes > 60) {
    await ctx.reply("⚠️ Timeout harus antara 1-60 menit.");
    return;
  }

  session.timeout = minutes * 60 * 1000;
  saveSessionState();
  await ctx.reply(`✅ Timeout diset ke <b>${minutes} menit</b>`, { parse_mode: "HTML" });
});

// --- /stop ---
bot.command("stop", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  if (!session.busy || !session._proc) {
    await ctx.reply("⚠️ Gak ada proses yang lagi jalan.");
    return;
  }

  const elapsed = session._startTime ? Math.round((Date.now() - session._startTime) / 1000) : 0;

  // Kill process
  session._proc.kill();
  if (session._timer) clearTimeout(session._timer);
  if (session._typingInterval) clearInterval(session._typingInterval);

  // Coba baca partial output dari file
  let partialResult = "";
  if (session._outFile) {
    try {
      if (fs.existsSync(session._outFile)) {
        const raw = fs.readFileSync(session._outFile, "utf-8");
        const parsed = parseOpenCodeOutput(raw);
        if (parsed.text) partialResult = `\n\n📝 Partial output:\n${parsed.text}`;
        if (parsed.sessionId) session.sessionId = parsed.sessionId;
      }
    } catch {}
    try { fs.unlinkSync(session._outFile); } catch {}
  }

  session.busy = false;
  session._timer = undefined;
  session._proc = undefined;
  session._outFile = undefined;
  session._typingInterval = undefined;

  if (session._resolve) {
    session._resolve(`🛑 Interrupted setelah ${elapsed} detik.${partialResult}`);
    session._resolve = undefined;
  } else {
    await ctx.reply(`🛑 Proses dihentikan (${elapsed}s).${partialResult}`);
  }

  saveSessionState();
});

// --- /extend ---
bot.command("extend", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const input = ctx.match?.trim();

  if (!session.busy || !session._timer) {
    await ctx.reply("⚠️ Gak ada proses yang lagi jalan. /extend cuma bisa waktu OpenCode lagi mikir.");
    return;
  }

  const minutes = parseInt(input || "10");
  if (isNaN(minutes) || minutes < 1 || minutes > 60) {
    await ctx.reply("⚠️ Extend antara 1-60 menit.\nContoh: /extend 10");
    return;
  }

  // Clear timer lama, tambah waktu, set timer baru
  clearTimeout(session._timer);
  session._timeoutMs = session._timeoutMs! + (minutes * 60 * 1000);

  const elapsed = Math.round((Date.now() - session._startTime!) / 60000);
  const totalMin = Math.round(session._timeoutMs! / 60000);
  const remaining = totalMin - elapsed;

  // Set timer baru dengan sisa waktu
  session._timer = setTimeout(() => {
    if (session._proc) session._proc.kill();
    if (session._typingInterval) clearInterval(session._typingInterval);
    session.busy = false;
    if (session._outFile) try { fs.unlinkSync(session._outFile); } catch {}
    if (session._resolve) session._resolve(`⏱️ Timeout setelah ${totalMin} menit.`);
    session._timer = undefined;
    session._proc = undefined;
    session._resolve = undefined;
  }, remaining * 60000);

  await ctx.reply(`✅ +${minutes} menit! Total: ${totalMin} menit (sisa: ~${remaining} menit)`, { parse_mode: "HTML" });
});

// --- /delete <id|label|number> ---
bot.command("delete", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const input = ctx.match?.trim();

  if (!input) {
    await ctx.reply(
      "⚠️ Kasih ID, label, atau nomor session yang mau dihapus.\n" +
        "Contoh: /delete 3\nAtau: /delete my-project\nAtau: /delete ses_xxx\n\n" +
        "💡 Pakai /sessions dulu untuk lihat daftar."
    );
    return;
  }

  // Cari session target
  const ocSessions = await getOpenCodeSessions();
  let targetId: string | null = null;
  let targetTitle = "";

  // 1. Match by nomor
  const num = parseInt(input);
  if (!isNaN(num) && num >= 1 && num <= ocSessions.length) {
    targetId = ocSessions[num - 1].id;
    targetTitle = ocSessions[num - 1].title;
  }

  // 2. Match by label
  if (!targetId) {
    const entry = Object.entries(sessionLabels).find(
      ([, label]) => label.toLowerCase() === input.toLowerCase()
    );
    if (entry) {
      targetId = entry[0];
      targetTitle = sessionLabels[targetId] || "";
    }
  }

  // 3. Match by session ID (full atau partial)
  if (!targetId) {
    const found = ocSessions.find(
      (s) => s.id === input || s.id.endsWith(input)
    );
    if (found) {
      targetId = found.id;
      targetTitle = found.title;
    }
  }

  // 4. Match by title (partial)
  if (!targetId) {
    const found = ocSessions.find(
      (s) => s.title.toLowerCase().includes(input.toLowerCase())
    );
    if (found) {
      targetId = found.id;
      targetTitle = found.title;
    }
  }

  if (!targetId) {
    await ctx.reply(`❌ Session "${input}" tidak ditemukan.\nCoba /sessions untuk lihat daftar.`);
    return;
  }

  // Konfirmasi & hapus
  const shortId = targetId.slice(-8);
  const label = sessionLabels[targetId];

  try {
    const envPath = process.platform === "win32"
      ? process.env.PATH || ""
      : `/root/.opencode/bin:/usr/bin:/usr/local/bin:/bin:${process.env.PATH || ""}`;

    await execAsync(`${OPENCODE_PATH} session delete ${targetId}`, {
      timeout: 10000,
      env: { ...process.env, PATH: envPath },
    });

    // Hapus label kalau ada
    if (sessionLabels[targetId]) {
      delete sessionLabels[targetId];
      saveLabels();
    }

    // Kalau session yang dihapus = session aktif, reset
    if (session.sessionId === targetId) {
      session.sessionId = null;
      saveSessionState();
    }

    await ctx.reply(
      `🗑️ Session dihapus!\n\n` +
        `• <b>${escapeHtml(targetTitle)}</b>${label ? ` [${label}]` : ""}\n` +
        `• ID: <code>${shortId}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (err: any) {
    await ctx.reply(`❌ Gagal hapus session: ${err.message?.slice(0, 200)}`);
  }
});

// --- /rename <nama baru> ---
bot.command("rename", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const newName = ctx.match?.trim();

  if (!session.sessionId) {
    await ctx.reply("⚠️ Belum ada session aktif. Kirim pesan dulu ke OpenCode.");
    return;
  }

  if (!newName) {
    const current = sessionLabels[session.sessionId];
    await ctx.reply(
      `🏷️ <b>Rename session aktif</b>\n\n` +
        `Label sekarang: ${current ? `<b>${escapeHtml(current)}</b>` : "(belum ada)"}\n\n` +
        `Contoh: /rename my-project`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const oldLabel = sessionLabels[session.sessionId];
  sessionLabels[session.sessionId] = newName;
  saveLabels();

  const shortId = session.sessionId.slice(-8);
  await ctx.reply(
    `✅ Session renamed!\n\n` +
      `• ID: <code>${shortId}</code>\n` +
      (oldLabel ? `• Sebelumnya: ${oldLabel}\n` : "") +
      `• Sekarang: <b>${escapeHtml(newName)}</b>`,
    { parse_mode: "HTML" }
  );
});

// --- /reset ---
bot.command("reset", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  session.sessionId = null;
  session.busy = false;
  saveSessionState();
  await ctx.reply("🔄 Reset! Session cleared, siap terima pesan baru.");
});

// --- /models ---
bot.command("models", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);

  const providers = getProviderChoices();
  if (providers.length === 0) {
    await ctx.reply("❌ Gagal baca config OpenCode.");
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const provider of providers) {
    keyboard.text(`${provider.name} (${provider.count})`.slice(0, 60), `modelprov:${provider.id}`).row();
  }

  await ctx.reply(
    `🧠 <b>Model Picker</b>\nAktif: <code>${escapeHtml(session.model)}</code>\n\nPilih provider dulu.`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
});

bot.callbackQuery(/^modelprov:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const providerId = ctx.match[1];
  const providers = getProviderChoices();
  const provider = providers.find((p) => p.id === providerId);

  if (!provider) {
    await ctx.answerCallbackQuery({ text: "Provider tidak ditemukan", show_alert: true });
    return;
  }

  const models = getModelsByProvider(providerId);
  const keyboard = new InlineKeyboard();
  for (const model of models) {
    const active = model.id === session.model ? "✅ " : "";
    keyboard.text(`${active}${model.activeLabel}`.slice(0, 60), `setmodel:${model.id}`).row();
  }
  keyboard.text("⬅️ Kembali", "modelprovback");

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🧠 <b>${escapeHtml(provider.name)}</b>\nAktif: <code>${escapeHtml(session.model)}</code>\n\nPilih model:`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
});

bot.callbackQuery("modelprovback", async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const providers = getProviderChoices();
  const keyboard = new InlineKeyboard();

  for (const provider of providers) {
    keyboard.text(`${provider.name} (${provider.count})`.slice(0, 60), `modelprov:${provider.id}`).row();
  }

  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `🧠 <b>Model Picker</b>\nAktif: <code>${escapeHtml(session.model)}</code>\n\nPilih provider dulu.`,
    {
      parse_mode: "HTML",
      reply_markup: keyboard,
    }
  );
});

bot.callbackQuery(/^setmodel:(.+)$/, async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const modelId = ctx.match[1];
  const choices = getModelChoices();
  const exists = choices.some((c) => c.id === modelId);

  if (!exists) {
    await ctx.answerCallbackQuery({ text: "Model tidak ditemukan", show_alert: true });
    return;
  }

  session.model = modelId;
  saveSessionState();

  await ctx.answerCallbackQuery({ text: `Model aktif: ${modelId}` });
  await ctx.editMessageText(
    `✅ <b>Model diubah</b>\nAktif sekarang: <code>${escapeHtml(modelId)}</code>`,
    { parse_mode: "HTML" }
  );
});

// --- /shell ---
bot.command("shell", async (ctx) => {
  const command = ctx.match;
  if (!command) {
    await ctx.reply("⚠️ Contoh: /shell dir");
    return;
  }

  await ctx.reply(`⏳ <code>${escapeHtml(command)}</code>`, { parse_mode: "HTML" });
  const output = await runShell(command);
  await sendLongMessage(ctx, `<pre>${escapeHtml(truncate(output))}</pre>`, "HTML");
});

// --- /status ---
const BOT_START_TIME = Date.now();

// --- Helper: Get OpenCode DB path ---
function getOpenCodeDbPath(): string {
  const home = os.homedir();
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

// --- Helper: Get session context (tokens, cost) from OpenCode DB ---
interface SessionContext {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  messages: number;
  compactions: number;
}

function getSessionContext(sessionId: string): SessionContext | null {
  const dbPath = getOpenCodeDbPath();
  if (!fs.existsSync(dbPath)) return null;

  try {
    const db = new Database(dbPath, { readonly: true });

    const row = db.prepare(`
      SELECT 
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) as input_tokens,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as output_tokens,
        COALESCE(SUM(json_extract(data, '$.cost')), 0) as cost,
        COUNT(*) as msg_count
      FROM message 
      WHERE session_id = ?
      AND json_extract(data, '$.role') = 'assistant'
    `).get(sessionId) as any;

    const compactions = db.prepare(`
      SELECT COUNT(*) as cnt FROM session_entry 
      WHERE session_id = ? AND type = 'summary'
    `).get(sessionId) as any;

    db.close();

    if (!row) return null;

    return {
      inputTokens: row.input_tokens || 0,
      outputTokens: row.output_tokens || 0,
      totalTokens: (row.input_tokens || 0) + (row.output_tokens || 0),
      cost: row.cost || 0,
      messages: row.msg_count || 0,
      compactions: compactions?.cnt || 0,
    };
  } catch {
    return null;
  }
}

// --- Helper: Format token count ---
function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return n.toString();
}

bot.command("status", async (ctx) => {
  const userId = ctx.from!.id;
  const session = getSession(userId);
  const cpus = os.cpus();
  const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  const usedMem = (Number(totalMem) - Number(freeMem)).toFixed(2);
  const uptimeSys = (os.uptime() / 3600).toFixed(1);
  const uptimeBot = ((Date.now() - BOT_START_TIME) / 3600000).toFixed(1);
  const platform = process.platform === "win32" ? "Windows" : "Linux";
  const label = session.sessionId ? sessionLabels[session.sessionId] : null;
  const shortId = session.sessionId ? session.sessionId.slice(-8) : "—";
  const timeoutMin = Math.round(session.timeout / 60000);

  // Count total sessions
  const ocSessions = await getOpenCodeSessions();
  const totalSessions = ocSessions.length;

  // Context info from OpenCode DB
  let contextInfo = "";
  if (session.sessionId) {
    const ctx_data = getSessionContext(session.sessionId);
    if (ctx_data) {
      contextInfo =
        `\n<b>🧮 Context:</b>\n` +
        `• Tokens: ${formatTokens(ctx_data.inputTokens)} in / ${formatTokens(ctx_data.outputTokens)} out\n` +
        `• Total: ${formatTokens(ctx_data.totalTokens)}\n` +
        `• Cost: $${ctx_data.cost.toFixed(4)}\n` +
        `• Messages: ${ctx_data.messages}\n` +
        `• Compactions: ${ctx_data.compactions}\n`;
    }
  }

  // Disk usage (best effort)
  let diskInfo = "";
  try {
    if (process.platform !== "win32") {
      const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $3\"/\"$2\" (\"$5\" used)\"}'", { timeout: 5000 });
      diskInfo = stdout.trim();
    } else {
      const { stdout } = await execAsync("powershell -c \"$d=(Get-PSDrive C); '{0:N1}/{1:N1} GB ({2}% used)' -f (($d.Used)/1GB),(($d.Used+$d.Free)/1GB),([math]::Round($d.Used/($d.Used+$d.Free)*100))\"", { timeout: 5000 });
      diskInfo = stdout.trim();
    }
  } catch {}

  await ctx.reply(
    `📊 <b>Status</b>\n\n` +
      `<b>🤖 Bot:</b>\n` +
      `• Platform: ${platform}\n` +
      `• Bot uptime: ${uptimeBot} jam\n` +
      `• Node: ${process.version}\n\n` +
      `<b>🧵 Session:</b>\n` +
      `• Aktif: <code>${shortId}</code>${label ? ` [${label}]` : ""}\n` +
      `• Model: <code>${session.model}</code>\n` +
      `• Agent: <code>${session.agent}</code>\n` +
      `• Dir: <code>${session.workDir}</code>\n` +
      `• Timeout: ${timeoutMin} menit\n` +
      `• Total sessions: ${totalSessions}\n` +
      contextInfo +
      `\n<b>🖥️ System:</b>\n` +
      `• OS: ${os.type()} ${os.release()}\n` +
      `• CPU: ${cpus[0]?.model || "?"} (${cpus.length} cores)\n` +
      `• RAM: ${usedMem} / ${totalMem} GB\n` +
      (diskInfo ? `• Disk: ${diskInfo}\n` : "") +
      `• Uptime: ${uptimeSys} jam`,
    { parse_mode: "HTML" }
  );
});

bot.command("healthz", async (ctx) => {
  const health = await getServiceHealthSummary();
  const lines = health.map((item) => {
    const icon = item.state.startsWith("active/") ? "✅" : item.state === "error" ? "⚠️" : "❌";
    return `${icon} <code>${item.name}</code>\n• State: ${escapeHtml(item.state)}\n• Since: ${escapeHtml(item.since)}\n• Note: ${escapeHtml(item.note)}`;
  });

  await ctx.reply(`🩺 <b>Health Check</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
});

// --- /id ---
bot.command("id", async (ctx) => {
  await ctx.reply(`🆔 <code>${ctx.from?.id}</code>`, { parse_mode: "HTML" });
});

// --- Photo handler → download & send to OpenCode ---
bot.on("message:photo", async (ctx) => {
  const userId = ctx.from!.id;
  const caption = ctx.message.caption || "Analisis gambar ini";
  let tmpImg = "";

  console.log(`\n📷 [${userId}] Photo, caption: "${caption.slice(0, 50)}"`);

  try {
    await ctx.replyWithChatAction("typing");

    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1];
    const file = await ctx.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    const ext = file.file_path?.split(".").pop() || "jpg";
    tmpImg = path.join(os.tmpdir(), `oc_img_${userId}_${Date.now()}.${ext}`);

    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpImg, buffer);
    console.log(`📷 Downloaded: ${tmpImg} (${buffer.length} bytes)`);

    const start = Date.now();
    const reply = await runOpenCode(userId, caption, ctx, [tmpImg]);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`⏱️ Response in ${elapsed}s (${reply.length} chars)`);

    await sendLongMessage(ctx, markdownToHtml(reply), "HTML");
  } catch (err: any) {
    console.log(`❌ Photo handler error: ${err.message}`);
    try { await ctx.reply(`❌ Error: ${err.message?.slice(0, 200)}`); } catch {}
  } finally {
    if (tmpImg) try { fs.unlinkSync(tmpImg); } catch {}
  }
});

// --- Document handler → download & send to OpenCode ---
bot.on("message:document", async (ctx) => {
  const userId = ctx.from!.id;
  const caption = ctx.message.caption || "Analisis file ini";
  const doc = ctx.message.document;
  let tmpFile = "";

  console.log(`\n📎 [${userId}] Doc: ${doc.file_name}, caption: "${caption.slice(0, 50)}"`);

  try {
    await ctx.replyWithChatAction("typing");

    const file = await ctx.api.getFile(doc.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;

    tmpFile = path.join(os.tmpdir(), `oc_doc_${userId}_${Date.now()}_${doc.file_name || "file"}`);

    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(tmpFile, buffer);
    console.log(`📎 Downloaded: ${tmpFile} (${buffer.length} bytes)`);

    const start = Date.now();
    const reply = await runOpenCode(userId, caption, ctx, [tmpFile]);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`⏱️ Response in ${elapsed}s (${reply.length} chars)`);

    await sendLongMessage(ctx, markdownToHtml(reply), "HTML");
  } catch (err: any) {
    console.log(`❌ Doc handler error: ${err.message}`);
    try { await ctx.reply(`❌ Error: ${err.message?.slice(0, 200)}`); } catch {}
  } finally {
    if (tmpFile) try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// --- Catch-all: Direct message → OpenCode ---
bot.on("message:text", async (ctx) => {
  const userId = ctx.from!.id;
  const message = ctx.message.text;
  const session = getSession(userId);

  console.log(`\n💬 [${userId}] "${message}" (busy: ${session.busy}, session: ${session.sessionId || "new"})`);

  try {
    await ctx.replyWithChatAction("typing");

    const start = Date.now();
    const reply = await runOpenCode(userId, message, ctx);
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);

    console.log(`⏱️ Response in ${elapsed}s (${reply.length} chars)`);

    await sendLongMessage(ctx, markdownToHtml(reply), "HTML");
  } catch (err: any) {
    console.log(`❌ Handler error: ${err.message}`);
    try { await ctx.reply(`❌ Error: ${err.message?.slice(0, 200)}`); } catch {}
  }
});

// --- Register Menu Commands ---
bot.api.setMyCommands([
  { command: "start", description: "🖥️ Info & status" },
  { command: "help", description: "📖 Bantuan" },
  { command: "session", description: "📋 Info session aktif" },
  { command: "sessions", description: "📋 List semua session" },
  { command: "switch", description: "🔀 Switch session" },
  { command: "label", description: "🏷️ Label session" },
  { command: "rename", description: "🏷️ Rename session" },
  { command: "delete", description: "🗑️ Hapus session" },
  { command: "new", description: "🆕 Session baru" },
  { command: "continue", description: "▶️ Lanjut session terakhir" },
  { command: "model", description: "🧠 Ganti model" },
  { command: "agent", description: "🤖 Ganti agent" },
  { command: "dir", description: "📁 Ganti working directory" },
  { command: "stop", description: "🛑 Stop/interrupt proses" },
  { command: "timeout", description: "⏱️ Set timeout (menit)" },
  { command: "extend", description: "⏱️+ Tambah waktu saat jalan" },
  { command: "models", description: "🧠 List semua model available" },
  { command: "shell", description: "⚡ Shell command" },
  { command: "status", description: "📊 Info sistem" },
  { command: "healthz", description: "🩺 Health service" },
  { command: "reset", description: "🔄 Force reset" },
]);

// --- Start Bot ---
console.log("🚀 OpenCode Remote starting...");
console.log(`📁 Default dir: ${WORK_DIR}`);

// Drop pending updates dari sebelum restart
bot.start({
  drop_pending_updates: true,
  onStart: (botInfo) => {
    console.log(`✅ Bot @${botInfo.username} is running!`);
    console.log(`🖥️ OpenCode: ${OPENCODE_PATH}`);
    console.log(`📋 Allowed users: ${ALLOWED_USER_IDS.length > 0 ? ALLOWED_USER_IDS.join(", ") : "ALL"}`);
    console.log(`\n💡 Ketik di Telegram, langsung masuk ke OpenCode!\n`);
  },
});

// --- Graceful Shutdown ---
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n🛑 Shutting down...");
  bot.stop();
  process.exit(0);
});
