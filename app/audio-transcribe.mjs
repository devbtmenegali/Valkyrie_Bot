/**
 * Valkyrie Audio Transcriber
 * Transcrição de áudios do WhatsApp e microfone via OpenAI Whisper / Gemini API
 */

export async function transcribeAudioBuffer(audioBuffer, mimeType = "audio/ogg") {
  const openAiKey = process.env.OPENAI_API_KEY;
  if (openAiKey) {
    try {
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      form.append("file", blob, "audio.ogg");
      form.append("model", "whisper-1");
      form.append("language", "pt");

      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openAiKey}` },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.text) return data.text.trim();
      }
    } catch (e) {
      console.error("[Whisper Erro]", e.message);
    }
  }

  // Fallback Gemini se disponível
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    try {
      const base64 = audioBuffer.toString("base64");
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
      const payload = {
        contents: [
          {
            parts: [
              { text: "Transcreva este áudio em português com exatidão, sem comentários:" },
              { inline_data: { mime_type: mimeType, data: base64 } }
            ]
          }
        ]
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    } catch (e) {
      console.error("[Gemini Audio Erro]", e.message);
    }
  }

  return "";
}

/**
 * Baixa mídia da Evolution API e transcreve
 */
export async function downloadAndTranscribeEvolutionMedia(messageId) {
  const baseUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  const instance = process.env.EVOLUTION_INSTANCE || "";

  if (!baseUrl || !apiKey || !instance || !messageId) return "";

  try {
    const res = await fetch(`${baseUrl}/chat/getBase64FromMediaMessage/${encodeURIComponent(instance)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      body: JSON.stringify({
        message: { key: { id: messageId } },
        convertToMp4: false,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.base64) {
        const buffer = Buffer.from(data.base64, "base64");
        return await transcribeAudioBuffer(buffer, data.mimetype || "audio/ogg");
      }
    }
  } catch (err) {
    console.error("[Download Evolution Media Erro]", err.message);
  }
  return "";
}
