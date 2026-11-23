/**
 * Valkyrie WhatsApp Active Sweeper Engine (v2 - Anti-Duplicação & Anti-Mensagens Antigas)
 * Varre ativamente os chats da Evolution API, transcreve áudios com Whisper,
 * respeita limites estritos de idade da mensagem e garante ID único determinístico.
 */
import { downloadAndTranscribeEvolutionMedia } from "./audio-transcribe.mjs";

// Cache em memória de IDs do WhatsApp já processados nesta sessão
const processedWaMessageIds = new Set();

// Limite estrito: mensagens com mais de 2.5 horas de envio são consideradas antigas e NUNCA re-ingressam como "novas"
const MAX_MESSAGE_AGE_MS = 2.5 * 60 * 60 * 1000;

function normalizeBaseText(text) {
  return String(text || "")
    .split("\n\n🧠 Kyrie:")[0]
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\s\r\n\t]+/gu, "")
    .toLowerCase()
    .trim()
    .slice(0, 35);
}

export async function runWhatsAppSweeper({
  baseUrl,
  apiKey,
  instance,
  ingestFn,
  existingInbox = [],
  maxChats = 35,
}) {
  if (!baseUrl || !apiKey || !instance) {
    return { ok: false, error: "Evolution API não configurada" };
  }

  try {
    // 1. Mapeia contatos reais para resolver nomes de JIDs @lid
    const contactsRes = await fetch(`${baseUrl}/chat/findContacts/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    const contactMap = new Map();
    if (contactsRes.ok) {
      const contacts = await contactsRes.json();
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          const name = c.pushName || c.name || c.verifiedName || "";
          if (c.remoteJid && name) contactMap.set(c.remoteJid, name);
          if (c.id && name) contactMap.set(c.id, name);
        }
      }
    }

    // 2. Busca os chats mais recentes
    const chatsRes = await fetch(`${baseUrl}/chat/findChats/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
    if (!chatsRes.ok) return { ok: false, error: "Falha ao buscar chats" };
    const chats = await chatsRes.json();
    if (!Array.isArray(chats)) return { ok: false, error: "Retorno inválido de chats" };

    // Ordena por data decrescente
    chats.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    // Mapa e Sets de deduplicação a partir do inbox existente
    const existingIds = new Set(
      existingInbox.map((i) => i.waMessageId || (i.id ? i.id.replace(/^wa_/, "") : "")).filter(Boolean)
    );
    const existingKeys = new Set(
      existingInbox.map((i) => {
        const phone = (i.senderPhone || "").replace(/\D/g, "").slice(-8);
        return `${phone}_${normalizeBaseText(i.text)}`;
      })
    );

    let ingestedCount = 0;
    const scannedItems = [];
    const now = Date.now();

    for (const c of chats.slice(0, maxChats)) {
      const last = c.lastMessage;
      if (!last || !last.key) continue;

      const waMessageId = last.key.id;
      if (!waMessageId) continue;

      // 1. Já processada na memória ou já presente no inbox? Pula!
      if (processedWaMessageIds.has(waMessageId) || existingIds.has(waMessageId)) {
        continue;
      }

      // 2. Checagem rígida de idade: ignorar mensagens com mais de 2.5h
      const msgTimestampSec = Number(last.messageTimestamp || 0);
      const msgTimeMs = msgTimestampSec > 0 ? msgTimestampSec * 1000 : 0;
      if (msgTimeMs > 0 && now - msgTimeMs > MAX_MESSAGE_AGE_MS) {
        // Mensagem antiga (de ontem, fim de semana ou horas atrás). Não reabrir!
        processedWaMessageIds.add(waMessageId);
        continue;
      }

      const isFromMe = Boolean(last.key.fromMe);
      // Mensagens enviadas pelo próprio Bruno não entram como pendência a responder
      if (isFromMe) {
        processedWaMessageIds.add(waMessageId);
        continue;
      }

      const jid = c.remoteJid || last.key.remoteJid || "";
      const isGroup = jid.endsWith("@g.us");

      // Resolve número de telefone real
      const altDigits = (last.key.remoteJidAlt || "").replace(/\D/g, "");
      const jidDigits = jid.replace(/\D/g, "");
      const cleanPhone = altDigits || jidDigits;

      // Resolve nome real
      let name = c.pushName || c.name || contactMap.get(jid) || (last.key.remoteJidAlt ? contactMap.get(last.key.remoteJidAlt) : "") || "";
      if (!name) name = cleanPhone || "Contato WhatsApp";
      if (isGroup) name += " (Grupo)";

      let text = (
        last.message?.conversation ||
        last.message?.extendedTextMessage?.text ||
        last.message?.imageMessage?.caption ||
        last.message?.videoMessage?.caption ||
        ""
      ).trim();

      // Transcrição de áudio se houver
      if (!text && last.message?.audioMessage) {
        const audioSec = last.message.audioMessage.seconds || 0;
        let trans = last.message.audioMessage.transcription;
        if (!trans && last.key.id) {
          trans = await downloadAndTranscribeEvolutionMedia(last.key.id);
        }
        text = trans ? `🎙️ [Áudio de ${audioSec}s]: "${trans}"` : `🎙️ [Áudio de ${audioSec}s recebido no WhatsApp]`;
      }

      // Se não for mensagem de texto nem áudio traduzido, ignora stickers ou reactions
      if (!text || text === "reactionMessage" || text === "stickerMessage") {
        processedWaMessageIds.add(waMessageId);
        continue;
      }

      // Deduplicação secundária por remetente + texto base normalizado
      const dedupeKey = `${cleanPhone.slice(-8)}_${normalizeBaseText(text)}`;
      if (existingKeys.has(dedupeKey)) {
        processedWaMessageIds.add(waMessageId);
        continue;
      }

      // Horário real do envio da mensagem
      const realDate = msgTimeMs > 0 ? new Date(msgTimeMs) : new Date();
      const timeStr = realDate.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });

      scannedItems.push({ senderName: name, senderPhone: cleanPhone, text, isGroup, waMessageId, timeStr });

      if (ingestFn) {
        await ingestFn({
          senderName: name,
          senderPhone: cleanPhone,
          text,
          simulated: false,
          isGroup,
          waMessageId,
          timeStr,
          msgTimestampMs: realDate.getTime(),
        });
        ingestedCount++;
      }

      processedWaMessageIds.add(waMessageId);
      existingKeys.add(dedupeKey);
    }

    return { ok: true, scannedCount: chats.length, newItemsIngested: ingestedCount, items: scannedItems };
  } catch (err) {
    console.error("[WhatsApp Sweeper Erro]", err.message);
    return { ok: false, error: err.message };
  }
}
