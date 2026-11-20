#!/usr/bin/env node
/**
 * Valkyrie — App Executivo + PWA + Voz (Zero-dependency Node.js server)
 * Porta padrão: http://localhost:3780
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sendWhatsAppMessage } from "../whatsapp/send.mjs";
import { runValkyrieAI, getConfiguredProviders, loadMemoryFacts } from "./brain.mjs";
import { getHolidayInfo } from "./holidays.mjs";
import { fetchCalendarEvents } from "./calendar.mjs";
import {
  isSupabaseEnabled,
  sbCheckReady,
  sbLoadMessages,
  sbAppendMessage,
  sbGetHabit,
  sbUpsertHabit,
  sbGetKV,
  sbSetKV,
} from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const AGENTS_PATH = path.join(ROOT_DIR, "AGENTS.md");
const KANBAN_PATH = path.join(ROOT_DIR, "kanban-backlog.md");
const HABITS_PATH = path.join(ROOT_DIR, "habit-tracker.md");
const HISTORY_PATH = path.join(__dirname, "chat-history.json");
const INBOX_PATH = path.join(__dirname, "whatsapp-inbox.json");
const MEMORY_PATH = path.join(__dirname, "memory.json");
const ENV_PATH = path.join(__dirname, ".env");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(ENV_PATH);
loadEnv(path.join(ROOT_DIR, "whatsapp", ".env"));

const PORT = Number(process.env.PORT || process.env.VALKYRIE_PORT || 3780);
const HOST = process.env.HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const IS_MAC = process.platform === "darwin";
const ACCESS_PIN = (process.env.VALKYRIE_ACCESS_PIN || "").trim();
const SESSION_TOKEN = ACCESS_PIN
  ? crypto.createHash("sha256").update(`valkyrie-session:${ACCESS_PIN}`).digest("hex")
  : "";
const TZ = "America/Sao_Paulo";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
const VOICE_NAME = process.env.VALKYRIE_VOICE || "Luciana";
const NEURAL_VOICE = process.env.VALKYRIE_NEURAL_VOICE || "pt-BR-ThalitaMultilingualNeural";
const EDGE_TTS_BIN = fs.existsSync(path.join(__dirname, ".venv", "bin", "edge-tts"))
  ? path.join(__dirname, ".venv", "bin", "edge-tts")
  : "edge-tts";
let voiceAlertsEnabled = true;
let activeAudioProc = null;
let speechSeq = 0;

function isAuthorized(req) {
  if (!ACCESS_PIN) return true;
  const cookie = req.headers.cookie || "";
  return cookie.includes(`valkyrie_session=${SESSION_TOKEN}`);
}

function generateTtsBuffer(text) {
  return new Promise((resolve, reject) => {
    const cleaned = cleanTextForSpeech(text);
    if (!cleaned) return reject(new Error("Texto vazio"));
    const tmpFile = `/tmp/valkyrie-tts-${crypto.randomUUID()}.mp3`;
    const proc = spawn(
      EDGE_TTS_BIN,
      ["--voice", NEURAL_VOICE, "--rate=+5%", "--text", cleaned, "--write-media", tmpFile],
      { stdio: "ignore" }
    );
    proc.on("error", (err) => reject(err));
    proc.on("exit", (code) => {
      if (code !== 0 || !fs.existsSync(tmpFile)) {
        try { fs.unlinkSync(tmpFile); } catch {}
        return reject(new Error("Falha ao gerar áudio TTS"));
      }
      try {
        const buf = fs.readFileSync(tmpFile);
        fs.unlinkSync(tmpFile);
        resolve(buf);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ---------- Neural Brazilian Voice (edge-tts + afplay, fallback macOS say) ----------
function cleanTextForSpeech(text) {
  return String(text || "")
    .replace(/\*\*/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}✅⬜🔄⚠️☀️📅🗓️📋🏋️📖📈📥🏢🎓💡⚡🔔🎧🎙️🔊]/gu, "")
    .replace(/[•|]/g, ", ")
    .replace(/R\$\s*/g, "reais ")
    .replace(/\s+/g, " ")
    .trim();
}

function stopMacSpeech() {
  speechSeq++;
  if (activeAudioProc) {
    try { activeAudioProc.kill("SIGTERM"); } catch {}
    activeAudioProc = null;
  }
  broadcastEvent("speaking", { speaking: false });
}

function speakFallbackSay(cleaned, seq) {
  if (seq !== speechSeq) return;
  try {
    broadcastEvent("speaking", { speaking: true });
    const proc = spawn("say", ["-v", VOICE_NAME, "-r", "195", cleaned], { stdio: "ignore" });
    activeAudioProc = proc;
    proc.on("exit", () => {
      if (activeAudioProc === proc) activeAudioProc = null;
      if (seq === speechSeq) broadcastEvent("speaking", { speaking: false });
    });
    proc.on("error", () => {
      if (activeAudioProc === proc) activeAudioProc = null;
      if (seq === speechSeq) broadcastEvent("speaking", { speaking: false });
    });
  } catch {
    broadcastEvent("speaking", { speaking: false });
  }
}

function speakMac(text) {
  if (!IS_MAC) return;
  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return;
  stopMacSpeech();
  const seq = ++speechSeq;

  if (!fs.existsSync(EDGE_TTS_BIN)) {
    return speakFallbackSay(cleaned, seq);
  }

  const outFile = `/tmp/valkyrie-speech-${seq}.mp3`;
  broadcastEvent("speaking", { speaking: true });

  const gen = spawn(
    EDGE_TTS_BIN,
    ["--voice", NEURAL_VOICE, "--rate=+5%", "--text", cleaned, "--write-media", outFile],
    { stdio: "ignore" }
  );
  activeAudioProc = gen;

  gen.on("error", () => speakFallbackSay(cleaned, seq));
  gen.on("exit", (code) => {
    if (seq !== speechSeq) {
      try { fs.unlinkSync(outFile); } catch {}
      return;
    }
    if (code !== 0 || !fs.existsSync(outFile)) {
      return speakFallbackSay(cleaned, seq);
    }
    const player = spawn("afplay", [outFile], { stdio: "ignore" });
    activeAudioProc = player;
    player.on("exit", () => {
      try { fs.unlinkSync(outFile); } catch {}
      if (activeAudioProc === player) activeAudioProc = null;
      if (seq === speechSeq) broadcastEvent("speaking", { speaking: false });
    });
    player.on("error", () => {
      try { fs.unlinkSync(outFile); } catch {}
      if (activeAudioProc === player) activeAudioProc = null;
      if (seq === speechSeq) broadcastEvent("speaking", { speaking: false });
    });
  });
}

// ---------- Real-time SSE Clients ----------
const sseClients = new Set();
function broadcastEvent(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

// ---------- Date & Time Helpers ----------
function getLocalDateStr(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getWeekdayInfo(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const dayName = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "long" }).format(now);
  const shortDay = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short" }).format(now).replace(".", "");
  const isJiu = /ter|qui|sex/i.test(shortDay);
  const isWeekend = /sáb|sab|dom/i.test(shortDay);
  return {
    dayName: dayName.charAt(0).toUpperCase() + dayName.slice(1),
    shortDay: shortDay.charAt(0).toUpperCase() + shortDay.slice(1),
    workout: isJiu ? "Jiu-Jitsu (07:00–08:00)" : "Musculação (07:00–07:30)",
    workoutShort: isJiu ? "Jiu-Jitsu" : "Musculação",
    isWeekend,
  };
}

function nowTimeStr() {
  return new Date().toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

// ---------- Google Calendar (CLI local + iCal 24/7 + Espelho Supabase) ----------
async function fetchCalendarDate(dateStr) {
  return fetchCalendarEvents(dateStr);
}

function formatTime(iso) {
  if (!iso || !iso.includes("T")) return "Dia todo";
  return new Date(iso).toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

function detectConflicts(events) {
  const timed = events
    .filter((e) => e.start.includes("T") && e.end.includes("T"))
    .map((e) => ({ ...e, s: Date.parse(e.start), e: Date.parse(e.end) }))
    .sort((a, b) => a.s - b.s);
  const conflicts = [];
  for (let i = 0; i < timed.length - 1; i++) {
    if (timed[i].e > timed[i + 1].s) {
      conflicts.push(`${timed[i].summary} (${formatTime(timed[i].start)}–${formatTime(timed[i].end)}) × ${timed[i + 1].summary} (${formatTime(timed[i + 1].start)}–${formatTime(timed[i + 1].end)})`);
    }
  }
  return conflicts;
}

// ---------- Kanban ----------
function parseKanban() {
  if (!fs.existsSync(KANBAN_PATH)) return [];
  const lines = fs.readFileSync(KANBAN_PATH, "utf8").split(/\r?\n/);
  const sections = [];
  let current = null;
  lines.forEach((line, idx) => {
    if (line.startsWith("## ")) {
      current = { title: line.replace(/^##\s+/, "").trim(), items: [] };
      sections.push(current);
    } else if (current) {
      const m = line.match(/^- \[([ x/])\]\s+(.*)$/);
      if (m) current.items.push({ lineIndex: idx, status: m[1], text: m[2].trim() });
    }
  });
  return sections;
}

function toggleKanbanLine(lineIndex) {
  const lines = fs.readFileSync(KANBAN_PATH, "utf8").split(/\r?\n/);
  const line = lines[lineIndex];
  if (!line) return false;
  const m = line.match(/^- \[([ x/])\](\s+.*)$/);
  if (!m) return false;
  const next = m[1] === "x" ? " " : "x";
  lines[lineIndex] = `- [${next}]${m[2]}`;
  const updatedMd = lines.join("\n");
  fs.writeFileSync(KANBAN_PATH, updatedMd, "utf8");
  sbSetKV("kanban_md", { markdown: updatedMd }).catch(() => {});
  return true;
}

function completeKanbanByQuery(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q || !fs.existsSync(KANBAN_PATH)) return { ok: false, error: "Tarefa não encontrada" };
  const lines = fs.readFileSync(KANBAN_PATH, "utf8").split(/\r?\n/);
  const idx = lines.findIndex((l) => /^- \[[ /]\]\s+/.test(l) && l.toLowerCase().includes(q));
  if (idx === -1) return { ok: false, error: `Nenhuma tarefa aberta encontrada contendo "${query}"` };
  lines[idx] = lines[idx].replace(/^- \[[ /]\]/, "- [x]");
  const updatedMd = lines.join("\n");
  fs.writeFileSync(KANBAN_PATH, updatedMd, "utf8");
  sbSetKV("kanban_md", { markdown: updatedMd }).catch(() => {});
  return { ok: true, completed: lines[idx] };
}

function detectPillar(text) {
  const lower = text.toLowerCase();
  if (/(glun|holding|estatuto|acionista|cvm|btg|pluggy|leil[aã]o|advogad|contador)/.test(lower)) return "GluN Capital";
  if (/(prontomed|soap|pwa|responsabilidade t[eé]cnica|crm|m[eé]dic)/.test(lower)) return "ProntoMed";
  if (/(clinimind|workspace|kpi|tiktok|instagram|avatar|livro)/.test(lower)) return "CliniMind";
  if (/(nossa casa|loja|estoque|fornecedor|varejo|pedido|entrega)/.test(lower)) return "Nossa Casa";
  if (/(unisul|unibave|aula|nota|di[aá]rio|aluno|prova|turma)/.test(lower)) return "Docência";
  if (/(trade|mini [ií]ndice|d[oó]lar|stop|meta|mercado)/.test(lower)) return "Day Trade";
  if (/(jiu|muscula[cç][aã]o|treino|leitura)/.test(lower)) return "Saúde/Hábitos";
  if (/(imposto|irpf|cart[aã]o|fatura|boleto|vencimento|investimento)/.test(lower)) return "Financeiro PF";
  return "Geral";
}

function detectPriority(text, pillar) {
  const lower = text.toLowerCase();
  if (/(urgente|hoje|agora|prazo|vence|contrato|minuta|cvm|erro|fora do ar|cancelar|pagamento)/.test(lower)) return "alta";
  if (["GluN Capital", "ProntoMed", "CliniMind", "Docência", "Financeiro PF"].includes(pillar)) return "media";
  return "baixa";
}

function buildLocalDraftReply(senderName, text, pillar) {
  const first = (senderName || "").split(" ")[0] || "";
  const greeting = first ? `Olá ${first}, tudo bem?` : "Olá, tudo bem?";
  if (pillar === "GluN Capital") return `${greeting} Recebi sua atualização sobre a GluN Capital. Vou revisar os pontos ainda hoje e já te retorno com a validação.`;
  if (pillar === "ProntoMed" || pillar === "CliniMind") return `${greeting} Obrigado pelo retorno sobre o ${pillar}. Já deixei registrado no nosso backlog prioritário e te atualizo em seguida.`;
  if (pillar === "Docência") return `${greeting} Recebi sua mensagem sobre a disciplina. Vou verificar isso e te respondo assim que encerrar meus compromissos de hoje.`;
  if (pillar === "Nossa Casa") return `${greeting} Obrigado pelo contato sobre a Nossa Casa. Já estou verificando essa demanda e te dou um posicionamento em breve.`;
  return `${greeting} Recebi sua mensagem e já vou verificar para te retornar assim que possível.`;
}

function addIdeaToKanban(text, pillarOverride = null) {
  const pillar = pillarOverride || detectPillar(text);
  const now = new Date().toLocaleString("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const entry = `- [ ] **[${pillar}]** (${now}) ${text.replace(/\s+/g, " ").trim()}`;
  let content = fs.existsSync(KANBAN_PATH) ? fs.readFileSync(KANBAN_PATH, "utf8") : "# Kanban\n";
  const placeholder = "- *(Novas ideias recebidas entram aqui antes de ir para o projeto correspondente)*";
  if (content.includes(placeholder)) {
    content = content.replace(placeholder, entry);
  } else {
    content = content.trimEnd() + "\n" + entry + "\n";
  }
  fs.writeFileSync(KANBAN_PATH, content, "utf8");
  sbSetKV("kanban_md", { markdown: content }).catch(() => {});
  return pillar;
}

// ---------- WhatsApp Triage Inbox ----------
function loadInbox() {
  if (!fs.existsSync(INBOX_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(INBOX_PATH, "utf8")); } catch { return []; }
}
function saveInbox(items) {
  fs.writeFileSync(INBOX_PATH, JSON.stringify(items.slice(0, 100), null, 2), "utf8");
}

async function generateSmartDraft(senderName, text, pillar) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: [{
                text: `Você é a Valkyrie, secretária executiva de Bruno Menegali. Escreva um rascunho de resposta curto, educado e profissional de WhatsApp (máx. 2 frases) em nome do Bruno para ${senderName || "o contato"} sobre o pilar ${pillar}. Mensagem recebida: "${text}". Retorne apenas o texto da resposta.`,
              }],
            }],
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        const draft = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (draft) return draft;
      }
    } catch {}
  }
  return buildLocalDraftReply(senderName, text, pillar);
}

async function ingestWhatsAppMessage({ senderName, senderPhone, text, simulated = false }) {
  const pillar = detectPillar(text);
  const priority = detectPriority(text, pillar);
  const draftReply = await generateSmartDraft(senderName, text, pillar);

  const item = {
    id: crypto.randomUUID(),
    senderName: senderName || senderPhone || "Contato WhatsApp",
    senderPhone: (senderPhone || "").replace(/\D/g, ""),
    text: text.trim(),
    pillar,
    priority,
    draftReply,
    status: "pending",
    simulated,
    time: nowTimeStr(),
    createdAt: new Date().toISOString(),
  };

  const inbox = loadInbox();
  inbox.unshift(item);
  saveInbox(inbox);

  if (priority !== "baixa" || simulated) {
    broadcastEvent("notification", {
      title: `Valkyrie • ${pillar} (${priority.toUpperCase()})`,
      body: `${item.senderName}: "${item.text.slice(0, 100)}" — Rascunho pronto.`,
      tag: item.id,
      item,
    });
    if (voiceAlertsEnabled) {
      speakMac(`Bruno, chegou uma mensagem de prioridade ${priority} de ${item.senderName}, sobre ${pillar}. Já deixei o rascunho pronto para sua aprovação.`);
    }
  } else {
    broadcastEvent("inbox_update", { item });
  }
  return item;
}

// ---------- Habits ----------
function getTodayHabits() {
  const today = getLocalDateStr(0);
  const info = getWeekdayInfo(0);
  const defaults = {
    date: today, day: info.shortDay, workoutName: info.workoutShort,
    workoutDone: false, readingDone: false, tradeText: "⬜", notes: "",
  };
  if (!fs.existsSync(HABITS_PATH)) return defaults;
  const lines = fs.readFileSync(HABITS_PATH, "utf8").split(/\r?\n/);
  const row = lines.find((l) => l.startsWith(`| ${today} |`));
  if (!row) return defaults;
  const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
  return {
    date: today, day: cols[1] || info.shortDay, workoutName: info.workoutShort,
    workoutDone: (cols[2] || "").includes("✅"),
    readingDone: (cols[3] || "").includes("✅"),
    tradeText: cols[4] || "⬜", notes: cols[5] || "",
  };
}

function saveTodayHabits(update) {
  const cur = getTodayHabits();
  const next = { ...cur, ...update };
  const workoutCell = `${next.workoutDone ? "✅" : "⬜"} ${next.workoutName}`;
  const readingCell = next.readingDone ? "✅" : "⬜";
  const tradeCell = next.tradeText || "⬜";
  const newRow = `| ${next.date} | ${next.day} | ${workoutCell} | ${readingCell} | ${tradeCell} | ${next.notes || ""} |`;

  let content = fs.existsSync(HABITS_PATH) ? fs.readFileSync(HABITS_PATH, "utf8") : "";
  const lines = content.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith(`| ${next.date} |`));
  if (idx >= 0) {
    lines[idx] = newRow;
    content = lines.join("\n");
  } else {
    content = content.trimEnd() + "\n" + newRow + "\n";
  }
  fs.writeFileSync(HABITS_PATH, content, "utf8");
  sbUpsertHabit(next).catch(() => {});
  return next;
}

// ---------- Chat History ----------
function loadHistory() {
  if (!fs.existsSync(HISTORY_PATH)) {
    return [{
      role: "valkyrie",
      time: nowTimeStr(),
      text: "Olá Bruno! Estou livre no seu Mac, com voz e escuta prontas.\n\nVocê pode clicar em 🎙️ Falar, ativar o modo 🎧 Mãos Livres (basta dizer 'Valkyrie...') ou usar os atalhos abaixo.",
    }];
  }
  try { return JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8")); } catch { return []; }
}
function saveHistory(history) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(-80), null, 2), "utf8");
}

// ---------- Valkyrie Brain ----------
let preferredProvider = "auto";

async function generateValkyrieReply(userText, providerOverride = null) {
  const lower = userText.trim().toLowerCase();
  const todayStr = getLocalDateStr(0);
  const tomorrowStr = getLocalDateStr(1);
  const info = getWeekdayInfo(0);
  const habits = getTodayHabits();
  const kanban = parseKanban();

  if (lower === "/treino" || /(fiz|conclu[ií]|pago|feito|marcar).*(jiu|muscula|treino)/.test(lower)) {
    saveTodayHabits({ workoutDone: true });
    return `✅ **Treino registrado!** ${info.workoutShort} marcado como concluído. Disciplina em dia, Bruno.`;
  }

  if (lower === "/leitura" || /(fiz|conclu[ií]|terminei|li|marcar).*(leitura|30\s*min)/.test(lower)) {
    saveTodayHabits({ readingDone: true });
    return `✅ **Leitura registrada!** Bloco de 30 minutos marcado como concluído.`;
  }

  const tradeMatch = userText.match(/(?:\/trade|trade|day\s*trade|bati\s+a\s+meta|meta\s+batida|fechei)\s*[:=]?\s*([+-]?\s*r?\$?\s*\d[\d.,]*)/i);
  if (tradeMatch || /bati a meta/.test(lower)) {
    const val = tradeMatch ? tradeMatch[1].replace(/\s+/g, "") : "R$ 500";
    const formatted = val.includes("R$") ? `✅ ${val}` : `✅ R$ ${val}`;
    saveTodayHabits({ tradeText: formatted });
    return `📈 **Day Trade atualizado!** Registrado **${formatted}**. Excelente disciplina, proteja o resultado.`;
  }

  if (lower === "/briefing" || /\bbriefing\b|\bresumo do dia\b|\bbom dia\b/.test(lower)) {
    const cal = await fetchCalendarDate(todayStr);
    const conflicts = detectConflicts(cal.events);
    const pendingWa = loadInbox().filter((i) => i.status === "pending").length;
    const topItems = kanban
      .flatMap((s) => s.items.filter((i) => i.status !== "x").map((i) => ({ section: s.title, text: i.text })))
      .slice(0, 3);

    const agendaLines = cal.events.length
      ? cal.events.map((e) => `• **${formatTime(e.start)}–${formatTime(e.end)}** | ${e.summary}`).join("\n")
      : "• Nenhum evento marcado no Google Calendar hoje.";

    const conflictNote = conflicts.length ? `\n⚠️ **Conflito detectado:** ${conflicts.join("; ")}` : "";
    const holiday = getHolidayInfo(todayStr);
    const tradeLine = holiday.isHoliday
      ? `🏖️ **Feriado Nacional:** ${holiday.name} — **B3 fechada** (sem Day Trade hoje)`
      : holiday.isWeekend
      ? `📈 **Day Trade:** Fim de semana — **B3 fechada**`
      : `📈 **Day Trade:** Meta R$ 500,00 | Janela inviolável 09:00–11:00 | Status: ${habits.tradeText}`;

    return [
      `☀️ **Briefing Valkyrie — ${info.dayName} (${todayStr.split("-").reverse().join("/")})**`,
      ``,
      `🏋️ **Saúde:** ${info.workout} (${habits.workoutDone ? "✅ Feito" : "⬜ Pendente"}) | Leitura 30m (${habits.readingDone ? "✅ Feita" : "⬜ Pendente"})`,
      tradeLine,
      `📥 **Triagem WhatsApp:** ${pendingWa} mensage${pendingWa === 1 ? "m pendente" : "ns pendentes"}`,
      `🏢 **Foco Corporativo (Top 3):**`,
      ...topItems.map((t, i) => `${i + 1}. ${t.text}`),
      `🎓 **Agenda (Google Calendar):**`,
      agendaLines + conflictNote,
    ].join("\n");
  }

  if (lower === "/agenda" || /\bagenda\b|\bcompromissos\b|\baulas?\b|\bamanh[ãa]\b/.test(lower)) {
    const isTomorrow = /amanh[ãa]/.test(lower);
    const targetDate = isTomorrow ? tomorrowStr : todayStr;
    const cal = await fetchCalendarDate(targetDate);
    const conflicts = detectConflicts(cal.events);
    const header = isTomorrow ? `🗓️ **Agenda de Amanhã (${targetDate.split("-").reverse().join("/")})**` : `📅 **Agenda de Hoje (${targetDate.split("-").reverse().join("/")})**`;
    if (!cal.ok) return `${header}\n⚠️ Não consegui consultar o Google Calendar agora (${cal.error}).`;
    if (!cal.events.length) return `${header}\n• Dia livre no Google Calendar.`;
    const lines = cal.events.map((e) => `• **${formatTime(e.start)}–${formatTime(e.end)}** | ${e.summary}`);
    if (conflicts.length) lines.push(`\n⚠️ **Conflito:** ${conflicts.join("; ")}`);
    return `${header}\n${lines.join("\n")}`;
  }

  if (lower === "/kanban" || /\bprioridades\b|\bkanban\b|\bpend[êe]ncias\b/.test(lower)) {
    const open = kanban
      .map((s) => {
        const items = s.items.filter((i) => i.status !== "x").slice(0, 3);
        if (!items.length) return null;
        return `**${s.title}**\n` + items.map((i) => `• ${i.status === "/" ? "🔄" : "⬜"} ${i.text}`).join("\n");
      })
      .filter(Boolean);
    return `📋 **Prioridades Abertas no Kanban:**\n\n${open.join("\n\n")}`;
  }

  const activeProviders = getConfiguredProviders().filter((p) => p.enabled);
  if (activeProviders.length > 0) {
    try {
      const agentsPrompt = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, "utf8") : "";
      const result = await runValkyrieAI({
        preferredProvider: providerOverride || preferredProvider,
        userText,
        history: loadHistory(),
        agentsPrompt,
        memoryPath: MEMORY_PATH,
        todayStr,
        weekdayInfo: info,
        helpers: {
          fetchCalendarDate,
          parseKanban,
          addIdeaToKanban,
          completeKanbanByQuery,
          saveTodayHabits,
        },
      });
      return result;
    } catch (err) {
      console.error("Erro Multi-AI Brain:", err.message);
      return {
        reply: `⚠️ Todos os motores de IA falharam nesta chamada (${err.message.slice(0, 140)}).`,
        executedTools: [],
        providerUsed: "Fallback Local",
      };
    }
  }

  const pillar = addIdeaToKanban(userText);
  return {
    reply: `💡 **Entendido e registrado!** Categorizei em **${pillar}** e já adicionei ao seu backlog no Kanban.`,
    executedTools: ["add_kanban_task"],
    providerUsed: "Modo Local",
  };
}

// ---------- Proactive Voice + Notification Scheduler ----------
let lastAlertKey = "";
setInterval(() => {
  const now = new Date();
  const hhmm = now.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const dateKey = getLocalDateStr(0);
  const info = getWeekdayInfo(0);
  const key = `${dateKey}-${hhmm}`;
  if (key === lastAlertKey) return;

  const holiday = getHolidayInfo(dateKey);

  if (hhmm === "06:30") {
    lastAlertKey = key;
    const holidaySuffix = holiday.isHoliday ? ` Hoje é feriado de ${holiday.name}, então a B3 está fechada.` : "";
    const msg = `Bom dia, Bruno! Aqui é a Valkyrie.${holidaySuffix} Hoje é dia de ${info.workout}. Seu briefing matinal já está pronto.`;
    broadcastEvent("notification", { title: "☀️ Valkyrie — Briefing Matinal (06:30)", body: msg, tag: "briefing-matinal" });
    if (voiceAlertsEnabled) speakMac(msg);
  } else if (hhmm === "08:45" && !holiday.b3Closed) {
    lastAlertKey = key;
    const msg = "Bruno, faltam quinze minutos para a abertura da sua janela inviolável de Day Trade, das nove às onze. Meta de quinhentos reais e disciplina total no stop.";
    broadcastEvent("notification", { title: "📈 Valkyrie — Pré-Mercado Day Trade (08:45)", body: msg, tag: "pre-mercado" });
    if (voiceAlertsEnabled) speakMac(msg);
  }
}, 20000);

// ---------- HTTP Helpers & Routes ----------
function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": contentType });
  res.end(fs.readFileSync(filePath));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/") return serveStatic(res, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/manifest.json") return serveStatic(res, path.join(__dirname, "manifest.json"), "application/manifest+json; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/sw.js") return serveStatic(res, path.join(__dirname, "sw.js"), "application/javascript; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/icon.svg") return serveStatic(res, path.join(__dirname, "icon.svg"), "image/svg+xml");
  if (req.method === "GET" && url.pathname === "/avatar.jpg") return serveStatic(res, path.join(__dirname, "valkyrie-avatar.jpg"), "image/jpeg");

  if (req.method === "GET" && url.pathname === "/api/health") {
    const supabaseReady = isSupabaseEnabled() ? await sbCheckReady() : false;
    return sendJson(res, 200, { ok: true, service: "valkyrie", cloud: !IS_MAC, supabaseReady, time: new Date().toISOString() });
  }

  if (req.method === "GET" && url.pathname === "/api/auth/status") {
    return sendJson(res, 200, { required: Boolean(ACCESS_PIN), authenticated: isAuthorized(req) });
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(req);
    if (!ACCESS_PIN || String(body.pin || "").trim() === ACCESS_PIN) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": `valkyrie_session=${SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }
    return sendJson(res, 401, { ok: false, error: "PIN incorreto" });
  }

  // Protege todas as rotas /api/* quando VALKYRIE_ACCESS_PIN está ativo (produção/nuvem)
  if (url.pathname.startsWith("/api/") && !isAuthorized(req)) {
    return sendJson(res, 401, { error: "Autenticação necessária", authRequired: true });
  }

  if (req.method === "POST" && url.pathname === "/api/tts") {
    const body = await readJsonBody(req);
    try {
      const buf = await generateTtsBuffer(body.text || "");
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length });
      return res.end(buf);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/state") {
    // Hidrata do Supabase quando disponível
    const [calToday, calTomorrow, remoteMsgs, remoteKanban, remoteHabit] = await Promise.all([
      fetchCalendarDate(getLocalDateStr(0)),
      fetchCalendarDate(getLocalDateStr(1)),
      sbLoadMessages(60),
      sbGetKV("kanban_md"),
      sbGetHabit(getLocalDateStr(0)),
    ]);
    if (remoteKanban?.markdown) fs.writeFileSync(KANBAN_PATH, remoteKanban.markdown, "utf8");
    const history = remoteMsgs && remoteMsgs.length ? remoteMsgs : loadHistory();
    const habits = remoteHabit || getTodayHabits();
    return sendJson(res, 200, {
      today: getLocalDateStr(0),
      weekday: getWeekdayInfo(0),
      calendarToday: calToday,
      calendarTomorrow: calTomorrow,
      conflictsToday: detectConflicts(calToday.events),
      kanban: parseKanban(),
      habits,
      history,
      inbox: loadInbox(),
      voiceAlertsEnabled,
      isCloud: !IS_MAC,
      supabaseEnabled: isSupabaseEnabled(),
      preferredProvider,
      providers: getConfiguredProviders(),
      geminiEnabled: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY),
      evolutionConfigured: Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/ai/provider") {
    const body = await readJsonBody(req);
    preferredProvider = String(body.provider || "auto");
    return sendJson(res, 200, { preferredProvider });
  }

  if (req.method === "POST" && url.pathname === "/api/speak") {
    const body = await readJsonBody(req);
    if (body.text) speakMac(body.text);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/speak/stop") {
    stopMacSpeech();
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/voice/toggle") {
    const body = await readJsonBody(req);
    voiceAlertsEnabled = Boolean(body.enabled);
    if (!voiceAlertsEnabled) stopMacSpeech();
    return sendJson(res, 200, { voiceAlertsEnabled });
  }

  if (req.method === "POST" && url.pathname === "/api/config/gemini") {
    const body = await readJsonBody(req);
    const key = String(body.apiKey || "").trim();
    if (!key) return sendJson(res, 400, { error: "Chave vazia" });
    process.env.GEMINI_API_KEY = key;
    let envText = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf8") : "";
    if (/^GEMINI_API_KEY=.*$/m.test(envText)) {
      envText = envText.replace(/^GEMINI_API_KEY=.*$/m, `GEMINI_API_KEY=${key}`);
    } else {
      envText = envText.trimEnd() + `\nGEMINI_API_KEY=${key}\n`;
    }
    fs.writeFileSync(ENV_PATH, envText, "utf8");
    return sendJson(res, 200, { ok: true, geminiEnabled: true });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    const body = await readJsonBody(req);
    const text = (body.text || "").trim();
    if (!text) return sendJson(res, 400, { error: "Mensagem vazia" });

    const history = loadHistory();
    const userMsg = { role: "user", time: nowTimeStr(), text };
    history.push(userMsg);
    sbAppendMessage(userMsg).catch(() => {});

    const rawResult = await generateValkyrieReply(text, body.provider || null);
    const reply = typeof rawResult === "string" ? rawResult : rawResult.reply;
    const tools = typeof rawResult === "string" ? [] : (rawResult.executedTools || []);
    const providerUsed = typeof rawResult === "string" ? "Comando Direto" : (rawResult.providerUsed || "");
    const botMsg = { role: "valkyrie", time: nowTimeStr(), text: reply, tools, providerUsed };
    history.push(botMsg);
    saveHistory(history);
    sbAppendMessage(botMsg).catch(() => {});

    if (body.speak !== false && voiceAlertsEnabled) {
      speakMac(reply);
    }

    const calToday = await fetchCalendarDate(getLocalDateStr(0));
    return sendJson(res, 200, {
      reply,
      tools,
      history,
      calendarToday: calToday,
      conflictsToday: detectConflicts(calToday.events),
      kanban: parseKanban(),
      habits: getTodayHabits(),
      memoriesCount: loadMemoryFacts(MEMORY_PATH).length,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/kanban/toggle") {
    const body = await readJsonBody(req);
    toggleKanbanLine(Number(body.lineIndex));
    return sendJson(res, 200, { kanban: parseKanban() });
  }

  if (req.method === "POST" && url.pathname === "/api/habits/update") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { habits: saveTodayHabits(body) });
  }

  if (req.method === "POST" && url.pathname === "/webhook/evolution") {
    if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
      res.writeHead(401);
      return res.end("Unauthorized");
    }
    const payload = await readJsonBody(req);
    const fromMe = Boolean(payload?.data?.key?.fromMe);
    const remoteJid = payload?.data?.key?.remoteJid || "";
    const isGroup = remoteJid.endsWith("@g.us");
    const msg = payload?.data?.message || {};
    const text = (msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || "").trim();
    if (!fromMe && !isGroup && text) {
      const senderPhone = remoteJid.replace(/\D/g, "");
      const senderName = payload?.data?.pushName || senderPhone;
      await ingestWhatsAppMessage({ senderName, senderPhone, text, simulated: false });
    }
    return sendJson(res, 200, { received: true });
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/simulate") {
    const samples = [
      {
        senderName: "Dr. Rafael (Advogado Societário)",
        senderPhone: "5548999990001",
        text: "Bruno, revisei a Minuta v1.2 do Estatuto da GluN Capital. Precisamos definir ainda hoje o valor nominal da ação (R$ 1.000 ou R$ 3.000) para protocolar.",
      },
      {
        senderName: "Equipe ProntoMed",
        senderPhone: "5548999990002",
        text: "Bruno, subimos o build da Função PWA (KAN-05) para testes. Pode validar o login e o auto-preenchimento SOAP?",
      },
      {
        senderName: "Coordenação UNISUL",
        senderPhone: "5548999990003",
        text: "Lembrete: prazo para fechamento do diário de classe e notas da turma 12K vence amanhã às 18h.",
      },
    ];
    const pick = samples[Math.floor(Math.random() * samples.length)];
    await ingestWhatsAppMessage({ ...pick, simulated: true });
    return sendJson(res, 200, { inbox: loadInbox() });
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/approve") {
    const body = await readJsonBody(req);
    const inbox = loadInbox();
    const item = inbox.find((i) => i.id === body.id);
    if (!item) return sendJson(res, 404, { error: "Mensagem não encontrada" });

    const replyText = (body.replyText || item.draftReply || "").trim();
    let deliveryNote = "Aprovado (modo simulação — preencha whatsapp/.env para disparo real)";
    if (!item.simulated && process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY && item.senderPhone) {
      try {
        await sendWhatsAppMessage(replyText, item.senderPhone);
        deliveryNote = "Enviado via WhatsApp (Evolution API)";
      } catch (err) {
        return sendJson(res, 502, { error: err.message });
      }
    }
    item.status = "sent";
    item.sentReply = replyText;
    item.deliveryNote = deliveryNote;
    item.sentAt = nowTimeStr();
    saveInbox(inbox);
    return sendJson(res, 200, { inbox, deliveryNote });
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/dismiss") {
    const body = await readJsonBody(req);
    const inbox = loadInbox();
    const item = inbox.find((i) => i.id === body.id);
    if (item) { item.status = "dismissed"; saveInbox(inbox); }
    return sendJson(res, 200, { inbox });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`⚡ Valkyrie rodando em http://${HOST}:${PORT} (${IS_MAC ? "Mac Local" : "Cloud 24/7"})`);
});
