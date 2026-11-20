#!/usr/bin/env node
/**
 * Valkyrie — Webhook Evolution API (Pilar 8: Gestão de Ideias & Canal WhatsApp)
 * Recebe mensagens do número autorizado do Bruno, categoriza e salva no kanban-backlog.md.
 * Uso: node whatsapp/webhook.mjs
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sendWhatsAppMessage } from "./send.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const kanbanPath = path.join(rootDir, "kanban-backlog.md");

const PORT = Number(process.env.WEBHOOK_PORT || 3777);
const ALLOWED_NUMBER = (process.env.BRUNO_WHATSAPP_NUMBER || "").replace(/\D/g, "");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";

function detectPillar(text) {
  const lower = text.toLowerCase();
  if (/(glun|holding|estatuto|acionista|cvm|btg|pluggy|leil[aã]o)/.test(lower)) return "GluN Capital";
  if (/(prontomed|soap|pwa|responsabilidade t[eé]cnica)/.test(lower)) return "ProntoMed";
  if (/(clinimind|workspace|kpi|tiktok|instagram|avatar|livro)/.test(lower)) return "CliniMind";
  if (/(nossa casa|loja|estoque|fornecedor|varejo)/.test(lower)) return "Nossa Casa";
  if (/(unisul|unibave|aula|nota|di[aá]rio|aluno)/.test(lower)) return "Docência";
  if (/(trade|mini [ií]ndice|d[oó]lar|stop|meta|mercado)/.test(lower)) return "Day Trade";
  if (/(jiu|muscula[cç][aã]o|treino|leitura|livro)/.test(lower)) return "Saúde/Hábitos";
  if (/(imposto|irpf|cart[aã]o|fatura|investimento|a[cç][oõ]es)/.test(lower)) return "Financeiro PF";
  return "Inbox de Ideias";
}

function appendIdeaToKanban(text, pillar) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const entry = `- [ ] **[${pillar}]** (${now}) ${text.replace(/\s+/g, " ").trim()}\n`;

  let content = fs.existsSync(kanbanPath) ? fs.readFileSync(kanbanPath, "utf8") : "";
  const placeholder = "- *(Novas ideias recebidas entram aqui antes de ir para o projeto correspondente)*";
  if (content.includes(placeholder)) {
    content = content.replace(placeholder, entry.trimEnd());
  } else {
    content = content.trimEnd() + "\n" + entry;
  }
  fs.writeFileSync(kanbanPath, content, "utf8");
}

function extractText(payload) {
  const msg = payload?.data?.message;
  if (!msg) return "";
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ""
  ).trim();
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || !req.url?.startsWith("/webhook/evolution")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "valkyrie-whatsapp-webhook" }));
    return;
  }

  if (WEBHOOK_SECRET && req.headers["x-webhook-secret"] !== WEBHOOK_SECRET) {
    res.writeHead(401);
    res.end("Unauthorized");
    return;
  }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const payload = JSON.parse(body || "{}");
    const remoteJid = payload?.data?.key?.remoteJid || "";
    const fromMe = Boolean(payload?.data?.key?.fromMe);
    const senderDigits = remoteJid.replace(/\D/g, "");

    if (!fromMe && ALLOWED_NUMBER && senderDigits === ALLOWED_NUMBER) {
      const text = extractText(payload);
      if (text) {
        const pillar = detectPillar(text);
        appendIdeaToKanban(text, pillar);
        await sendWhatsAppMessage(
          `✅ *Valkyrie:* Recebido! Categorizei em *${pillar}* e adicionei ao seu backlog (\`kanban-backlog.md\`).`
        );
      }
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ received: true }));
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.writeHead(400);
    res.end("Bad Request");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Valkyrie WhatsApp Webhook ativo em http://localhost:${PORT}/webhook/evolution`);
});

