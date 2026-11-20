#!/usr/bin/env node
/**
 * Valkyrie — Envio de mensagens via Evolution API (zero dependências externas)
 * Uso: node whatsapp/send.mjs "Sua mensagem aqui"
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnv(envPath);

export async function sendWhatsAppMessage(text, number = process.env.BRUNO_WHATSAPP_NUMBER) {
  const baseUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  const instance = process.env.EVOLUTION_INSTANCE || "";

  if (!baseUrl || !apiKey || !instance || !number) {
    throw new Error(
      "Configuração incompleta. Copie whatsapp/.env.example para whatsapp/.env e preencha EVOLUTION_API_URL, EVOLUTION_API_KEY, EVOLUTION_INSTANCE e BRUNO_WHATSAPP_NUMBER."
    );
  }

  const url = `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({
      number: number.replace(/\D/g, ""),
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Evolution API erro ${res.status}: ${body}`);
  }

  return res.json();
}

// Execução direta via CLI
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const message = process.argv.slice(2).join(" ").trim();
  if (!message) {
    console.error('Uso: node whatsapp/send.mjs "Mensagem para o Bruno"');
    process.exit(1);
  }
  sendWhatsAppMessage(message)
    .then(() => console.log("✅ Mensagem enviada no WhatsApp com sucesso."))
    .catch((err) => {
      console.error("❌ Falha ao enviar:", err.message);
      process.exit(1);
    });
}

