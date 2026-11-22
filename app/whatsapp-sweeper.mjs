/**
 * Valkyrie WhatsApp Active Sweeper Engine
 * Varre ativamente os chats da Evolution API, transcreve áudios,
 * resolve nomes de @lid e submete mensagens pendentes para a triagem da Kyrie.
 */
import { downloadAndTranscribeEvolutionMedia } from "./audio-transcribe.mjs";

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

    // Conjunto de textos/remetentes já existentes no inbox para evitar duplicação
    const existingKeys = new Set(
      existingInbox.map((i) => `${(i.senderPhone || "").slice(-8)}_${(i.text || "").slice(0, 30)}`)
    );

    let ingestedCount = 0;
    const scannedItems = [];

    for (const c of chats.slice(0, maxChats)) {
      const last = c.lastMessage;
      if (!last) continue;
      const isFromMe = Boolean(last.key?.fromMe);
      const jid = c.remoteJid;
      const isGroup = jid.endsWith("@g.us");

      // Resolve número de telefone real
      const altDigits = (last.key?.remoteJidAlt || "").replace(/\D/g, "");
      const jidDigits = jid.replace(/\D/g, "");
      const cleanPhone = altDigits || jidDigits;

      // Resolve nome real
      let name = c.pushName || c.name || contactMap.get(jid) || (last.key?.remoteJidAlt ? contactMap.get(last.key.remoteJidAlt) : "") || "";
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
        if (!trans && last.key?.id) {
          trans = await downloadAndTranscribeEvolutionMedia(last.key.id);
        }
        text = trans ? `🎙️ [Áudio de ${audioSec}s]: "${trans}"` : `🎙️ [Áudio de ${audioSec}s recebido no WhatsApp]`;
      }

      // Se não for mensagem de texto nem áudio traduzido, ignora stickers ou reactions
      if (!text || text === "reactionMessage" || text === "stickerMessage") continue;

      const dedupeKey = `${cleanPhone.slice(-8)}_${text.slice(0, 30)}`;
      if (existingKeys.has(dedupeKey)) continue;

      // Apenas mensagens recebidas de terceiros (não enviadas pelo próprio Bruno)
      if (!isFromMe) {
        scannedItems.push({ senderName: name, senderPhone: cleanPhone, text, isGroup });
        if (ingestFn) {
          await ingestFn({ senderName: name, senderPhone: cleanPhone, text, simulated: false, isGroup });
          ingestedCount++;
        }
      }
    }

    return { ok: true, scannedCount: chats.length, newItemsIngested: ingestedCount, items: scannedItems };
  } catch (err) {
    console.error("[WhatsApp Sweeper Erro]", err.message);
    return { ok: false, error: err.message };
  }
}
