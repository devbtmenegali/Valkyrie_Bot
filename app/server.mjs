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
import { runValkyrieAI, runSimplePromptAI, getConfiguredProviders, loadMemoryFacts, saveMemoryFact } from "./brain.mjs";
import { getHolidayInfo } from "./holidays.mjs";
import { fetchCalendarEvents } from "./calendar.mjs";
import { listContacts, upsertContact, getUpcomingBirthdays, buildSupplierMessage } from "./skills/contacts.mjs";
import { listFinance, addFinanceEntry, markFinancePaid, getFinanceSummary, buildCollectionMessage } from "./skills/finance.mjs";
import { LANGUAGE_VOICES, getLanguageCoachPrompt, listLanguageSessions, logLanguageSession } from "./skills/languages.mjs";
import { fetchLiveNews, loadCachedRadar, saveCachedRadar, buildRadarPrompt } from "./skills/radar.mjs";
import { macOpenApp, macOpenUrl, macSearchFiles, macOpenFile, macSystemControl } from "./skills/mac.mjs";
import { createProactiveEngine } from "./proactive.mjs";
import {
  isSupabaseEnabled,
  sbCheckReady,
  sbLoadMessages,
  sbAppendMessage,
  sbGetHabit,
  sbUpsertHabit,
  sbGetKV,
  sbSetKV,
  sbLoadInbox,
  sbInsertInbox,
  sbUpdateInbox,
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

function generateTtsBuffer(text, voiceOverride = null) {
  return new Promise((resolve, reject) => {
    const cleaned = cleanTextForSpeech(text);
    if (!cleaned) return reject(new Error("Texto vazio"));
    const tmpFile = `/tmp/valkyrie-tts-${crypto.randomUUID()}.mp3`;
    const voice = voiceOverride || NEURAL_VOICE;
    const proc = spawn(
      EDGE_TTS_BIN,
      ["--voice", voice, "--rate=+5%", "--text", cleaned, "--write-media", tmpFile],
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

function speakMac(text, voiceOverride = null) {
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
    ["--voice", voiceOverride || NEURAL_VOICE, "--rate=+5%", "--text", cleaned, "--write-media", outFile],
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

async function getAllInbox() {
  const remote = await sbLoadInbox(60);
  if (Array.isArray(remote)) {
    saveInbox(remote);
    return remote;
  }
  return loadInbox();
}

async function getPendingWhatsApp() {
  const list = await getAllInbox();
  const pending = list.filter((i) => i.status === "pending");
  return { count: pending.length, items: pending.slice(0, 15) };
}

async function analyzeWhatsAppWithAI(senderName, text, fallbackPillar, fallbackPriority, isGroup = false) {
  try {
    const ai = await runSimplePromptAI({
      preferredProvider,
      systemPrompt: `Você é a Valkyrie, Chief of Staff de Bruno Menegali. Você lê TODAS as mensagens do WhatsApp (individuais e grupos) e decide o que realmente é para o Bruno.
Responda APENAS com um JSON válido (sem markdown):
{"needs_bruno": true/false, "priority": "alta"|"media"|"baixa", "pillar": "GluN Capital"|"ProntoMed"|"CliniMind"|"Nossa Casa"|"Docência"|"Financeiro PF"|"Família"|"Geral", "summary": "resumo curto do que precisa do Bruno", "draft_reply": "rascunho humano e curto de resposta em nome do Bruno"}
Regras:
- Se for mensagem de GRUPO: marque needs_bruno=true APENAS se citar o Bruno, exigir decisão/resposta dele, envolver prazo/urgência de GluN, ProntoMed, CliniMind, Nossa Casa, UNISUL/UNIBAVE ou família (Val, Lucca, Caio). Conversas paralelas de terceiros em grupo = needs_bruno=false.
- Se for mensagem INDIVIDUAL: marque needs_bruno=false APENAS para ruído puro sem ação necessária (ex: 'bom dia', 'ok', 'obrigado', 'valeu', 'kkk', propaganda).`,
      userText: `Origem: ${isGroup ? "GRUPO" : "CONVERSA INDIVIDUAL"}\nRemetente: ${senderName}\nMensagem: "${text}"`,
    });
    const raw = (ai.reply || "").replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(raw);
    return {
      needsBruno: parsed.needs_bruno !== false,
      priority: ["alta", "media", "baixa"].includes(parsed.priority) ? parsed.priority : fallbackPriority,
      pillar: parsed.pillar || fallbackPillar,
      summary: parsed.summary || "",
      draftReply: parsed.draft_reply || buildLocalDraftReply(senderName, text, fallbackPillar),
    };
  } catch {
    return {
      needsBruno: true,
      priority: fallbackPriority,
      pillar: fallbackPillar,
      summary: "",
      draftReply: buildLocalDraftReply(senderName, text, fallbackPillar),
    };
  }
}

async function ingestWhatsAppMessage({ senderName, senderPhone, text, simulated = false, isGroup = false }) {
  const fallbackPillar = detectPillar(text);
  const fallbackPriority = detectPriority(text, fallbackPillar);
  const analysis = await analyzeWhatsAppWithAI(senderName, text, fallbackPillar, fallbackPriority, isGroup);

  const item = {
    id: crypto.randomUUID(),
    senderName: senderName || senderPhone || "Contato WhatsApp",
    senderPhone: (senderPhone || "").replace(/\D/g, ""),
    text: analysis.summary ? `${text.trim()}\n\n🧠 Valkyrie: ${analysis.summary}` : text.trim(),
    pillar: analysis.pillar,
    priority: analysis.priority,
    draftReply: analysis.draftReply,
    status: analysis.needsBruno || simulated ? "pending" : "dismissed",
    simulated,
    time: nowTimeStr(),
    createdAt: new Date().toISOString(),
  };

  const inbox = await getAllInbox();
  inbox.unshift(item);
  saveInbox(inbox);
  sbInsertInbox(item).catch(() => {});

  if (item.status === "pending" && (item.priority !== "baixa" || simulated)) {
    broadcastEvent("notification", {
      title: `Valkyrie • ${item.pillar} (${item.priority.toUpperCase()})`,
      body: `${item.senderName}: "${text.slice(0, 100)}" — Rascunho pronto.`,
      tag: item.id,
      item,
    });
    if (voiceAlertsEnabled) {
      speakMac(`Bruno, chegou uma mensagem importante de ${item.senderName}, sobre ${item.pillar}. ${analysis.summary || "Já deixei o rascunho pronto para sua aprovação."}`);
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

  // Somente comandos explícitos com barra (/) usam atalho instantâneo;
  // qualquer frase natural vai direto para o Cérebro Multi-IA para resposta 100% humana e inteligente!
  if (lower === "/treino") {
    saveTodayHabits({ workoutDone: true });
    return `Boa, Bruno! Já deixei seu ${info.workoutShort} marcado como pago hoje. Disciplina em dia.`;
  }

  if (lower === "/leitura") {
    saveTodayHabits({ readingDone: true });
    return `Feito! Seus 30 minutos de leitura de hoje já estão registrados.`;
  }

  if (lower.startsWith("/trade")) {
    const tradeMatch = userText.match(/\/trade\s*[:=]?\s*([+-]?\s*r?\$?\s*\d[\d.,]*)/i);
    const val = tradeMatch ? tradeMatch[1].replace(/\s+/g, "") : "R$ 500";
    const formatted = val.includes("R$") ? `✅ ${val}` : `✅ R$ ${val}`;
    saveTodayHabits({ tradeText: formatted });
    return `Anotado, Bruno! Day Trade de hoje registrado em **${formatted}**. Protege esse resultado.`;
  }

  if (lower === "/briefing") {
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

  if (lower === "/agenda") {
    const targetDate = todayStr;
    const cal = await fetchCalendarDate(targetDate);
    const conflicts = detectConflicts(cal.events);
    const header = `📅 **Agenda de Hoje (${targetDate.split("-").reverse().join("/")})**`;
    if (!cal.ok) return `${header}\n⚠️ Não consegui consultar o Google Calendar agora (${cal.error}).`;
    if (!cal.events.length) return `${header}\n• Dia livre no Google Calendar.`;
    const lines = cal.events.map((e) => `• **${formatTime(e.start)}–${formatTime(e.end)}** | ${e.summary}`);
    if (conflicts.length) lines.push(`\n⚠️ **Conflito:** ${conflicts.join("; ")}`);
    return `${header}\n${lines.join("\n")}`;
  }

  if (lower === "/kanban") {
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
          upsertContact: (args) => upsertContact(__dirname, args),
          getUpcomingBirthdays: (days) => getUpcomingBirthdays(__dirname, days),
          addFinanceEntry: (args) => addFinanceEntry(__dirname, args),
          getFinanceSummary: () => getFinanceSummary(__dirname),
          queueOutboundMessage: async ({ recipient_name, message, pillar = "Envio Proativo" }) => {
            const contacts = await listContacts(__dirname);
            const found = contacts.find((c) => c.name.toLowerCase() === String(recipient_name || "").toLowerCase());
            const item = {
              id: crypto.randomUUID(),
              senderName: `📤 Para: ${found?.name || recipient_name}`,
              senderPhone: found?.phone || "",
              text: `[Mensagem preparada pela Valkyrie para ${found?.name || recipient_name}]`,
              pillar,
              priority: "alta",
              draftReply: message,
              status: "pending",
              simulated: !found?.phone,
              time: nowTimeStr(),
              createdAt: new Date().toISOString(),
            };
            const inbox = loadInbox();
            inbox.unshift(item);
            saveInbox(inbox);
            broadcastEvent("inbox_update", { item });
            const connected = Boolean(process.env.EVOLUTION_API_URL && process.env.EVOLUTION_API_KEY);
            return {
              queued: true,
              sentNow: false,
              whatsappConnected: connected,
              instructionForAI: connected
                ? "NÃO diga que já enviou! Diga ao Bruno que o rascunho foi colocado na aba WhatsApp aguardando 1 clique dele em 'Aprovar e Enviar'."
                : "NÃO diga que enviou! Seja honesta: informe que a mensagem ficou salva como rascunho na aba WhatsApp, mas a Evolution API (QR Code do WhatsApp) ainda não está conectada para disparo real.",
              item,
            };
          },
          getStrategicRadar: () => generateOrGetRadar(false),
          getPendingWhatsApp,
          macOpenApp,
          macOpenUrl,
          macSearchFiles,
          macOpenFile,
          macSystemControl,
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

async function generateOrGetRadar(forceRefresh = false) {
  const today = getLocalDateStr(0);
  const cached = loadCachedRadar(__dirname);
  if (!forceRefresh && cached && cached.date === today && cached.briefing) {
    return cached;
  }
  const news = await fetchLiveNews();
  const memories = loadMemoryFacts(MEMORY_PATH);
  const prompt = buildRadarPrompt(news, memories);
  let briefing = "Não foi possível gerar a síntese agora, mas as manchetes ao vivo estão listadas abaixo.";
  let providerUsed = "";
  try {
    const ai = await runSimplePromptAI({ preferredProvider, systemPrompt: prompt.system, userText: prompt.user });
    briefing = ai.reply;
    providerUsed = ai.providerUsed;
  } catch {}
  const result = { date: today, updatedAt: nowTimeStr(), briefing, providerUsed, news };
  saveCachedRadar(__dirname, result);
  return result;
}

// ---------- Proactive Chief of Staff Engine (06:30, 08:45, 11:15, 14:00, 16:30, 21:00 + 15m antes de eventos) ----------
const proactiveEngine = createProactiveEngine({
  runSimplePromptAI,
  getPreferredProvider: () => preferredProvider,
  fetchCalendarDate,
  parseKanban,
  getTodayHabits,
  getWeekdayInfo,
  getFinanceSummary: () => getFinanceSummary(__dirname),
  getUpcomingBirthdays: (days) => getUpcomingBirthdays(__dirname, days),
  getPendingWhatsApp,
  onProactiveMessage: async ({ title, text, providerUsed, tag }) => {
    const history = loadHistory();
    const botMsg = { role: "valkyrie", time: nowTimeStr(), text, tools: ["proactive_checkin"], providerUsed };
    history.push(botMsg);
    saveHistory(history);
    sbAppendMessage(botMsg).catch(() => {});
    broadcastEvent("notification", { title, body: text, tag });
    if (IS_MAC && voiceAlertsEnabled) speakMac(text);
  },
});
proactiveEngine.start();

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
      const voice = body.voice || LANGUAGE_VOICES[body.lang] || NEURAL_VOICE;
      const buf = await generateTtsBuffer(body.text || "", voice);
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
    const [calToday, calTomorrow, remoteMsgs, remoteKanban, remoteHabit, syncedInbox] = await Promise.all([
      fetchCalendarDate(getLocalDateStr(0)),
      fetchCalendarDate(getLocalDateStr(1)),
      sbLoadMessages(60),
      sbGetKV("kanban_md"),
      sbGetHabit(getLocalDateStr(0)),
      getAllInbox(),
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
      inbox: syncedInbox,
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
    if (body.text) speakMac(body.text, body.voice || LANGUAGE_VOICES[body.lang] || null);
    return sendJson(res, 200, { ok: true });
  }

  // ---------- Skill Endpoints: Contatos, Finanças & Modo Carro / Idiomas ----------
  if (req.method === "GET" && url.pathname === "/api/skills/all") {
    const [contacts, birthdays, finance] = await Promise.all([
      listContacts(__dirname),
      getUpcomingBirthdays(__dirname, 30),
      getFinanceSummary(__dirname),
    ]);
    return sendJson(res, 200, {
      contacts,
      birthdays,
      finance,
      languageSessions: listLanguageSessions(__dirname).slice(0, 14),
    });
  }

  if (req.method === "POST" && url.pathname === "/api/contacts") {
    const body = await readJsonBody(req);
    const saved = await upsertContact(__dirname, body);
    return sendJson(res, 200, { ok: true, contact: saved, contacts: await listContacts(__dirname), birthdays: await getUpcomingBirthdays(__dirname, 30) });
  }

  if (req.method === "POST" && url.pathname === "/api/contacts/message") {
    const body = await readJsonBody(req);
    const contacts = await listContacts(__dirname);
    const contact = contacts.find((c) => c.id === body.id || c.name.toLowerCase() === String(body.name || "").toLowerCase());
    if (!contact) return sendJson(res, 404, { error: "Contato não encontrado" });
    const draft = contact.category === "fornecedor"
      ? buildSupplierMessage(contact, body.subject || "Gostaria de confirmar o status do nosso pedido e prazo de entrega.")
      : (body.subject || `Oi ${contact.name}, tudo bem? Passando aqui só para dar um alô!`);

    const item = {
      id: crypto.randomUUID(),
      senderName: `📤 Para: ${contact.name}${contact.company ? ` (${contact.company})` : ""}`,
      senderPhone: contact.phone || "",
      text: `[Rascunho ${contact.category === "fornecedor" ? "Fornecedor Nossa Casa" : "Família/Contato"}]`,
      pillar: contact.category === "fornecedor" ? "Nossa Casa" : "Família",
      priority: "media",
      draftReply: draft,
      status: "pending",
      simulated: !contact.phone,
      time: nowTimeStr(),
      createdAt: new Date().toISOString(),
    };
    const inbox = loadInbox();
    inbox.unshift(item);
    saveInbox(inbox);
    broadcastEvent("inbox_update", { item });
    return sendJson(res, 200, { ok: true, inbox });
  }

  if (req.method === "POST" && url.pathname === "/api/finance") {
    const body = await readJsonBody(req);
    await addFinanceEntry(__dirname, body);
    return sendJson(res, 200, { ok: true, finance: await getFinanceSummary(__dirname) });
  }

  if (req.method === "POST" && url.pathname === "/api/finance/pay") {
    const body = await readJsonBody(req);
    await markFinancePaid(__dirname, body.id);
    return sendJson(res, 200, { ok: true, finance: await getFinanceSummary(__dirname) });
  }

  if (req.method === "POST" && url.pathname === "/api/finance/collect") {
    const body = await readJsonBody(req);
    const fin = await getFinanceSummary(__dirname);
    const entry = fin.items.find((i) => i.id === body.id);
    if (!entry) return sendJson(res, 404, { error: "Lançamento não encontrado" });
    const draft = buildCollectionMessage(entry);
    const item = {
      id: crypto.randomUUID(),
      senderName: `💸 Cobrança: ${entry.counterparty} (${entry.scope})`,
      senderPhone: entry.contact_phone || "",
      text: `Cobrança referente a "${entry.description}" — R$ ${Number(entry.amount).toFixed(2)} (venc. ${entry.due_date})`,
      pillar: "Financeiro/Cobrança",
      priority: "alta",
      draftReply: draft,
      status: "pending",
      simulated: !entry.contact_phone,
      time: nowTimeStr(),
      createdAt: new Date().toISOString(),
    };
    const inbox = loadInbox();
    inbox.unshift(item);
    saveInbox(inbox);
    broadcastEvent("inbox_update", { item });
    return sendJson(res, 200, { ok: true, inbox });
  }

  if (req.method === "POST" && url.pathname === "/api/car/talk") {
    const body = await readJsonBody(req);
    const mode = body.mode || "en"; // en | es | radio
    const text = String(body.text || "").trim();

    if (mode === "radio") {
      const todayStr = getLocalDateStr(0);
      const [cal, fin, bdays] = await Promise.all([
        fetchCalendarDate(todayStr),
        getFinanceSummary(__dirname),
        getUpcomingBirthdays(__dirname, 14),
      ]);
      const holiday = getHolidayInfo(todayStr);
      const topTasks = parseKanban().flatMap((s) => s.items.filter((i) => i.status !== "x")).slice(0, 3).map((t) => t.text);
      const script = [
        `Bom caminho no volante, Bruno! Aqui é a Valkyrie com seu resumo em 60 segundos.`,
        holiday.isHoliday ? `Hoje é feriado de ${holiday.name}, então a B3 está fechada.` : `Janela de Day Trade das nove às onze com meta de quinhentos reais.`,
        cal.events.length ? `Na sua agenda hoje: ${cal.events.map((e) => `${e.summary} às ${formatTime(e.start)}`).join(", ")}.` : `Sua agenda de hoje está livre.`,
        topTasks.length ? `Suas prioridades corporativas são: ${topTasks.join("; ")}.` : "",
        fin.overdueReceivables.length ? `Atenção financeira: você tem ${fin.overdueReceivables.length} cobrança atrasada para receber.` : "",
        bdays.length ? `Aniversário chegando: ${bdays[0].name} em ${bdays[0].daysUntil} dias.` : "",
        `Boa direção! Quando quiser treinar inglês ou espanhol, é só tocar no botão.`,
      ].filter(Boolean).join(" ");
      if (IS_MAC && voiceAlertsEnabled) speakMac(script, LANGUAGE_VOICES.pt);
      return sendJson(res, 200, { reply: script, voice: LANGUAGE_VOICES.pt, lang: "pt" });
    }

    const prompt = getLanguageCoachPrompt(mode, text || (mode === "en" ? "Hi Valkyrie, let's start our 10-minute English practice while I drive!" : "¡Hola Valkyrie, empecemos nuestros 10 minutos de práctica de español mientras conduzco!"));
    const ai = await runSimplePromptAI({ preferredProvider, systemPrompt: prompt.system, userText: prompt.user });
    if (IS_MAC && voiceAlertsEnabled) speakMac(ai.reply, prompt.voice);
    return sendJson(res, 200, { reply: ai.reply, voice: prompt.voice, lang: mode, providerUsed: ai.providerUsed });
  }

  if (req.method === "POST" && url.pathname === "/api/car/complete") {
    const body = await readJsonBody(req);
    const saved = logLanguageSession(__dirname, {
      date: getLocalDateStr(0),
      language: body.lang === "es" ? "es" : "en",
      durationSec: Number(body.durationSec || 600),
      topic: body.topic || "Modo Carro",
    });
    return sendJson(res, 200, { ok: true, saved, languageSessions: listLanguageSessions(__dirname).slice(0, 14) });
  }

  // ---------- Skill Endpoints: Radar Estratégico (Notícias, Oportunidades & Aprendizado) ----------
  if (req.method === "GET" && url.pathname === "/api/radar") {
    return sendJson(res, 200, await generateOrGetRadar(false));
  }

  if (req.method === "POST" && url.pathname === "/api/radar/refresh") {
    const data = await generateOrGetRadar(true);
    return sendJson(res, 200, data);
  }

  if (req.method === "POST" && url.pathname === "/api/proactive/now") {
    const text = await proactiveEngine.triggerNow();
    return sendJson(res, 200, { ok: Boolean(text), reply: text, history: loadHistory() });
  }

  if (req.method === "POST" && url.pathname === "/api/radar/feedback") {
    const body = await readJsonBody(req);
    const action = body.action || "like";
    const note = String(body.note || "").trim();
    if (action === "kanban" && note) {
      addIdeaToKanban(note, "Radar/Oportunidades");
      saveMemoryFact(MEMORY_PATH, { pillar: "Radar/Interesses", fact: `Bruno gostou e transformou em tarefa: ${note.slice(0, 140)}` });
      return sendJson(res, 200, { ok: true, message: "Salvo no Kanban e aprendido na memória!", kanban: parseKanban() });
    }
    const label = action === "like" ? "Bruno gostou deste tema/insight" : "Bruno prefere menos conteúdo sobre";
    saveMemoryFact(MEMORY_PATH, { pillar: "Preferências/Aprendizado", fact: `${label}: ${note.slice(0, 140)}` });
    return sendJson(res, 200, { ok: true, message: "Aprendizado registrado na memória da Valkyrie!" });
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
    const text = (msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || "").trim();
    if (!fromMe && text) {
      const senderPhone = remoteJid.replace(/\D/g, "");
      const senderName = (payload?.data?.pushName || senderPhone) + (isGroup ? " (Grupo)" : "");
      await ingestWhatsAppMessage({ senderName, senderPhone, text, simulated: false, isGroup });
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
    sbUpdateInbox(item.id, { status: "sent", sent_reply: replyText, delivery_note: deliveryNote, sent_at: item.sentAt }).catch(() => {});
    return sendJson(res, 200, { inbox, deliveryNote });
  }

  if (req.method === "POST" && url.pathname === "/api/inbox/dismiss") {
    const body = await readJsonBody(req);
    const inbox = await getAllInbox();
    const item = inbox.find((i) => i.id === body.id);
    if (item) {
      item.status = "dismissed";
      saveInbox(inbox);
      sbUpdateInbox(item.id, { status: "dismissed" }).catch(() => {});
    }
    return sendJson(res, 200, { inbox });
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`⚡ Valkyrie rodando em http://${HOST}:${PORT} (${IS_MAC ? "Mac Local" : "Cloud 24/7"})`);
});
