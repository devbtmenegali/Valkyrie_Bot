/**
 * Valkyrie Supabase REST Persistence (Zero external dependencies)
 * Sincroniza chat, memória, hábitos, kanban e triagem WhatsApp com Supabase.
 * Se as tabelas valkyrie_* ainda não existirem, faz fallback silencioso para arquivos locais.
 */

function getConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key, enabled: Boolean(url && key) };
}

export async function sbFetch(path, options = {}) {
  const { url, key, enabled } = getConfig();
  if (!enabled) return null;
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      ...options,
      signal: AbortSignal.timeout(8000),
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) return null;
    if (res.status === 204) return true;
    const text = await res.text();
    return text ? JSON.parse(text) : true;
  } catch {
    return null;
  }
}

export function isSupabaseEnabled() {
  return getConfig().enabled;
}

export async function sbCheckReady() {
  const rows = await sbFetch("valkyrie_kv?select=key&limit=1");
  return Array.isArray(rows);
}

// ---------- Chat Messages ----------
export async function sbLoadMessages(limit = 60) {
  const rows = await sbFetch(`valkyrie_messages?select=*&order=created_at.desc&limit=${limit}`);
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows.reverse().map((r) => ({
    role: r.role,
    time: r.time_label || "",
    text: r.content,
    tools: Array.isArray(r.tools_used) ? r.tools_used : [],
    providerUsed: r.provider_used || "",
  }));
}

export async function sbAppendMessage(msg) {
  return sbFetch("valkyrie_messages", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      role: msg.role,
      content: msg.text,
      time_label: msg.time || "",
      tools_used: msg.tools || [],
      provider_used: msg.providerUsed || "",
    }),
  });
}

// ---------- Memory Facts ----------
export async function sbLoadMemory(limit = 50) {
  const rows = await sbFetch(`valkyrie_memory?select=*&order=created_at.desc&limit=${limit}`);
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({ id: r.id, pillar: r.pillar, fact: r.fact, createdAt: r.created_at }));
}

export async function sbSaveMemory({ pillar = "Geral", fact }) {
  return sbFetch("valkyrie_memory", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ pillar, fact }),
  });
}

// ---------- Habits ----------
export async function sbGetHabit(dateStr) {
  try {
    const kv = await sbGetKV(`habits_${dateStr}`);
    if (kv && typeof kv === "object" && kv.date) {
      return kv;
    }
  } catch {}

  const rows = await sbFetch(`valkyrie_habits?date=eq.${encodeURIComponent(dateStr)}&limit=1`);
  if (!Array.isArray(rows) || !rows.length) return null;
  const r = rows[0];
  const workoutStatus = r.workout_done ? "done" : "pending";
  const readingStatus = r.reading_done ? "done" : "pending";
  const tradeText = r.trade_text || "⬜ Meta R$ 500";
  const tradeStatus = tradeText.includes("✅") ? "done" : tradeText.includes("❌") ? "missed" : "pending";
  return {
    date: r.date,
    day: r.day_label,
    workoutName: r.workout_name,
    workoutStatus,
    workoutDone: Boolean(r.workout_done),
    waterStatus: "pending",
    waterDone: false,
    readingStatus,
    readingDone: Boolean(r.reading_done),
    tradeStatus,
    tradeText,
    notes: r.notes || "",
  };
}

export async function sbUpsertHabit(h) {
  await sbSetKV(`habits_${h.date}`, h).catch(() => {});
  return sbFetch("valkyrie_habits", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      date: h.date,
      day_label: h.day,
      workout_name: h.workoutName,
      workout_done: Boolean(h.workoutDone),
      reading_done: Boolean(h.readingDone),
      trade_text: h.tradeText || "⬜",
      notes: h.notes || "",
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

// ---------- Key-Value (Kanban Markdown sync) ----------
export async function sbGetKV(key) {
  const rows = await sbFetch(`valkyrie_kv?key=eq.${encodeURIComponent(key)}&limit=1`);
  if (!Array.isArray(rows) || !rows.length) return null;
  return rows[0].value;
}

export async function sbSetKV(key, value) {
  return sbFetch("valkyrie_kv", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

// ---------- WhatsApp Triage Inbox ----------
export async function sbLoadInbox(limit = 50) {
  const rows = await sbFetch(`valkyrie_whatsapp_inbox?select=*&order=created_at.desc&limit=${limit}`);
  if (!Array.isArray(rows)) return null;
  return rows.map((r) => ({
    id: r.id,
    senderName: r.sender_name,
    senderPhone: r.sender_phone,
    text: r.message_text,
    pillar: r.pillar,
    priority: r.priority,
    draftReply: r.draft_reply,
    sentReply: r.sent_reply,
    deliveryNote: r.delivery_note,
    status: r.status,
    simulated: Boolean(r.simulated),
    time: r.time_label || "",
    sentAt: r.sent_at || "",
    createdAt: r.created_at,
  }));
}

export async function sbInsertInbox(item) {
  return sbFetch("valkyrie_whatsapp_inbox", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({
      id: item.id,
      sender_name: item.senderName,
      sender_phone: item.senderPhone || "",
      message_text: item.text,
      pillar: item.pillar || "Geral",
      priority: item.priority || "media",
      draft_reply: item.draftReply || "",
      sent_reply: item.sentReply || null,
      delivery_note: item.deliveryNote || null,
      status: item.status || "pending",
      simulated: Boolean(item.simulated),
      time_label: item.time || "",
      sent_at: item.sentAt || null,
    }),
  });
}

export async function sbUpdateInbox(id, patch) {
  return sbFetch(`valkyrie_whatsapp_inbox?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
}

