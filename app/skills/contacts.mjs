/**
 * Skill: Contatos, Família (Val, Lucca, Caio), Aniversários & Fornecedores (Nossa Casa)
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DEFAULT_CONTACTS = [
  { id: "fam-val", name: "Val", category: "familia", relation: "Família", phone: "", birthday: "", gift_preferences: "", company: "", notes: "Completar WhatsApp e aniversário" },
  { id: "fam-lucca", name: "Lucca", category: "familia", relation: "Família", phone: "", birthday: "", gift_preferences: "", company: "", notes: "Completar WhatsApp e aniversário" },
  { id: "fam-caio", name: "Caio", category: "familia", relation: "Família", phone: "", birthday: "", gift_preferences: "", company: "", notes: "Completar WhatsApp e aniversário" },
];

function sbConfig() {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key, enabled: Boolean(url && key) };
}

async function sbReq(endpoint, options = {}) {
  const { url, key, enabled } = sbConfig();
  if (!enabled) return null;
  try {
    const res = await fetch(`${url}/rest/v1/${endpoint}`, {
      ...options,
      signal: AbortSignal.timeout(7000),
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    if (!res.ok) return null;
    if (res.status === 204) return true;
    const t = await res.text();
    return t ? JSON.parse(t) : true;
  } catch {
    return null;
  }
}

function localPath(appDir) {
  return path.join(appDir, "contacts.json");
}

function readLocal(appDir) {
  const p = localPath(appDir);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_CONTACTS, null, 2), "utf8");
    return [...DEFAULT_CONTACTS];
  }
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return [...DEFAULT_CONTACTS]; }
}

function writeLocal(appDir, list) {
  fs.writeFileSync(localPath(appDir), JSON.stringify(list, null, 2), "utf8");
}

export async function listContacts(appDir, category = null) {
  const remote = await sbReq("valkyrie_contacts?select=*&order=name.asc");
  let list = Array.isArray(remote) ? remote : readLocal(appDir);
  if (Array.isArray(remote)) writeLocal(appDir, remote);
  if (category) {
    list = list.filter((c) => c.category === category);
  }
  return list;
}

export async function upsertContact(appDir, data) {
  const list = await listContacts(appDir);
  const existing = list.find((c) =>
    (data.id && c.id === data.id) ||
    (data.name && c.name.toLowerCase() === String(data.name).trim().toLowerCase())
  );

  const record = {
    id: existing?.id || crypto.randomUUID(),
    name: String(data.name || existing?.name || "Sem nome").trim(),
    category: data.category || existing?.category || "outro",
    relation: data.relation ?? existing?.relation ?? "",
    phone: String(data.phone ?? existing?.phone ?? "").replace(/\D/g, ""),
    email: data.email ?? existing?.email ?? "",
    birthday: String(data.birthday ?? existing?.birthday ?? "").trim(), // MM-DD
    gift_preferences: data.gift_preferences ?? existing?.gift_preferences ?? "",
    company: data.company ?? existing?.company ?? "",
    notes: data.notes ?? existing?.notes ?? "",
  };

  if (existing) {
    const idx = list.findIndex((c) => c.id === existing.id);
    list[idx] = record;
  } else {
    list.push(record);
  }
  writeLocal(appDir, list);

  // Sync Supabase (usa UUID válido se for novo)
  const sbRecord = { ...record };
  if (!/^[0-9a-f-]{36}$/i.test(sbRecord.id)) delete sbRecord.id;
  await sbReq("valkyrie_contacts", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(sbRecord),
  });

  return record;
}

export async function getUpcomingBirthdays(appDir, daysAhead = 15) {
  const list = await listContacts(appDir);
  const now = new Date();
  const results = [];

  for (const c of list) {
    if (!c.birthday || !/^\d{2}-\d{2}$/.test(c.birthday)) continue;
    const [mm, dd] = c.birthday.split("-").map(Number);
    let nextBday = new Date(now.getFullYear(), mm - 1, dd);
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (nextBday < todayStart) nextBday = new Date(now.getFullYear() + 1, mm - 1, dd);
    const diffDays = Math.round((nextBday - todayStart) / 86400000);
    if (diffDays <= daysAhead) {
      results.push({
        name: c.name,
        relation: c.relation || c.category,
        birthday: `${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}`,
        daysUntil: diffDays,
        gift_preferences: c.gift_preferences || "Sem preferências cadastradas ainda",
      });
    }
  }
  return results.sort((a, b) => a.daysUntil - b.daysUntil);
}

export function buildSupplierMessage(contact, subject) {
  return `Olá ${contact.name}, tudo bem? Aqui é a Kyrie, assistente executiva do Bruno da loja Nossa Casa. ${subject} Pode me confirmar por aqui? Obrigada!`;
}

// ---------- Busca ao vivo nos contatos reais do WhatsApp via Evolution API ----------
let evoContactsCache = { at: 0, list: [] };

export async function searchEvolutionContacts(query) {
  const baseUrl = (process.env.EVOLUTION_API_URL || "").replace(/\/+$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY || "";
  const instance = process.env.EVOLUTION_INSTANCE || "";
  if (!baseUrl || !apiKey || !instance) return [];

  const now = Date.now();
  if (!evoContactsCache.list.length || now - evoContactsCache.at > 5 * 60 * 1000) {
    try {
      const res = await fetch(`${baseUrl}/chat/findContacts/${encodeURIComponent(instance)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: apiKey },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({}),
      });
      if (res.ok) {
        const raw = await res.json();
        if (Array.isArray(raw)) {
          evoContactsCache = {
            at: now,
            list: raw
              .filter((c) => typeof c.remoteJid === "string" && c.remoteJid.endsWith("@s.whatsapp.net"))
              .map((c) => ({
                name: String(c.pushName || c.name || "").trim(),
                phone: c.remoteJid.replace(/\D/g, ""),
              }))
              .filter((c) => c.name && c.phone),
          };
        }
      }
    } catch {}
  }

  const q = String(query || "").trim().toLowerCase();
  if (!q) return [];

  const exact = evoContactsCache.list.filter((c) => c.name.toLowerCase() === q);
  if (exact.length) return exact;

  const starts = evoContactsCache.list.filter((c) => c.name.toLowerCase().startsWith(q + " ") || c.name.toLowerCase().startsWith(q));
  if (starts.length) return starts.slice(0, 6);

  return evoContactsCache.list.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6);
}
