/**
 * Skill: Modo Carro & Idiomas (10 min Inglês + 10 min Espanhol por dia)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const LANGUAGE_VOICES = {
  pt: "pt-BR-ThalitaMultilingualNeural",
  en: "en-US-AvaMultilingualNeural",
  es: "es-MX-DaliaNeural",
};

export function getLanguageCoachPrompt(lang, userText) {
  if (lang === "en") {
    return {
      voice: LANGUAGE_VOICES.en,
      system: `You are Kyrie, Bruno Menegali's executive English coach while he is driving (10-minute daily speaking practice).
Rules:
- Speak ONLY in natural, clear, conversational American English.
- Keep responses SHORT (2 to 4 sentences max, easy to listen while driving).
- If Bruno makes a grammar or phrasing mistake, gently give the natural correction in 1 short sentence, then continue the conversation with an engaging question about business, markets, medicine, travel, or daily life.
- Encourage him naturally like a high-performance private tutor.`,
      user: userText,
    };
  }
  return {
    voice: LANGUAGE_VOICES.es,
    system: `Eres Kyrie, la profesora ejecutiva de español de Bruno Menegali mientras conduce (práctica diaria de 10 minutos).
Reglas:
- Habla SOLO en español natural, claro y fluido.
- Mantén tus respuestas CORTAS (máximo 2 a 4 frases, ideales para escuchar conduciendo).
- Si Bruno comete un error o usa "portuñol", corrígelo amablemente en 1 frase corta y continúa la conversación con una pregunta interesante sobre negocios, viajes, finanzas o su día.
- Motívalo de forma cálida y ejecutiva.`,
    user: userText,
  };
}

function localPath(appDir) {
  return path.join(appDir, "language-sessions.json");
}

export function listLanguageSessions(appDir) {
  const p = localPath(appDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}

export function logLanguageSession(appDir, { date, language, durationSec = 600, topic = "Modo Carro" }) {
  const list = listLanguageSessions(appDir);
  const entry = {
    id: crypto.randomUUID(),
    date,
    language,
    duration_sec: durationSec,
    topic,
    created_at: new Date().toISOString(),
  };
  list.unshift(entry);
  fs.writeFileSync(localPath(appDir), JSON.stringify(list.slice(0, 100), null, 2), "utf8");
  return entry;
}
