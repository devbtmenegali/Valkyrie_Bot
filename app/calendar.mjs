/**
 * Valkyrie Calendar Adapter (Mac gcalendar CLI + Cloud iCal .ics + Supabase Mirror + Cloud Mutation Queue)
 */
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { sbGetKV, sbSetKV } from "./db.mjs";

const TZ = "America/Sao_Paulo";

export function toLocalDateStr(dateObj) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(dateObj);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function parseIcsDate(val) {
  if (!val) return null;
  const clean = val.trim();
  // YYYYMMDD (all-day)
  if (/^\d{8}$/.test(clean)) {
    return {
      iso: `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`,
      dateStr: `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`,
      allDay: true,
    };
  }
  // YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS
  const m = clean.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, isUtc] = m;
  if (isUtc) {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
    return { iso: dt.toISOString(), dateStr: toLocalDateStr(dt), allDay: false };
  }
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}-03:00`;
  return { iso, dateStr: `${y}-${mo}-${d}`, allDay: false };
}

function parseIcsEventsForDate(icsText, targetDateStr) {
  const unfolded = icsText.replace(/\r?\n[ \t]/g, "");
  const blocks = unfolded.split("BEGIN:VEVENT").slice(1);
  const events = [];

  for (const block of blocks) {
    const body = block.split("END:VEVENT")[0] || "";
    const lines = body.split(/\r?\n/);
    let summary = "(Sem título)";
    let dtStart = null;
    let dtEnd = null;
    let uid = "";

    for (const line of lines) {
      if (line.startsWith("SUMMARY")) summary = line.slice(line.indexOf(":") + 1).replace(/\\,/g, ",").replace(/\\n/g, " ").trim();
      else if (line.startsWith("UID:")) uid = line.slice(4).trim();
      else if (line.startsWith("DTSTART")) dtStart = parseIcsDate(line.slice(line.indexOf(":") + 1));
      else if (line.startsWith("DTEND")) dtEnd = parseIcsDate(line.slice(line.indexOf(":") + 1));
    }

    if (dtStart && dtStart.dateStr === targetDateStr) {
      events.push({
        id: uid || `${targetDateStr}-${summary}`,
        summary,
        start: dtStart.iso,
        end: dtEnd?.iso || dtStart.iso,
        link: "",
      });
    }
  }

  return events.sort((a, b) => a.start.localeCompare(b.start));
}

async function fetchFromIcsUrl(dateStr) {
  const url = (process.env.GOOGLE_CALENDAR_ICS_URL || "").trim();
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const text = await res.text();
    const events = parseIcsEventsForDate(text, dateStr);
    return { ok: true, events, source: "ical" };
  } catch {
    return null;
  }
}

export function runGCalendarCli(args) {
  return new Promise((resolve) => {
    const agyBin = process.env.ANTIGRAVITY_AGENTAPI_EXE || path.join(process.env.HOME || "", ".gemini/bin/agy");
    
    // Tentativa 1: agy plugin-cli gcalendar
    execFile(agyBin, ["plugin-cli", "gcalendar", ...args], { timeout: 15000 }, (err1, stdout1, stderr1) => {
      if (!err1) return resolve({ ok: true, stdout: stdout1 || "", stderr: stderr1 || "", source: "agy_cli" });

      // Tentativa 2: gcalendar direto no PATH
      execFile("gcalendar", args, { timeout: 15000 }, (err2, stdout2, stderr2) => {
        if (!err2) return resolve({ ok: true, stdout: stdout2 || "", stderr: stderr2 || "", source: "gcalendar_cli" });

        // Tentativa 3: caminho padrão antigravity bin
        const binPath = path.join(process.env.HOME || "", ".gemini/antigravity/bin/gcalendar");
        execFile(binPath, args, { timeout: 15000 }, (err3, stdout3, stderr3) => {
          if (!err3) return resolve({ ok: true, stdout: stdout3 || "", stderr: stderr3 || "", source: "gcalendar_bin" });
          resolve({ ok: false, error: err1.message || err2.message || err3.message });
        });
      });
    });
  });
}

function fetchFromGCalendarCli(dateStr) {
  return new Promise(async (resolve) => {
    const res = await runGCalendarCli(["readonly", "events", "--date", dateStr, "--max", "50", "--json"]);
    if (!res.ok) return resolve(null);
    try {
      const raw = JSON.parse(res.stdout || "[]");
      const events = (Array.isArray(raw) ? raw : []).map((ev) => ({
        id: ev.id,
        summary: ev.summary || "(Sem título)",
        start: ev.start?.dateTime || ev.start?.date || "",
        end: ev.end?.dateTime || ev.end?.date || "",
        link: ev.htmlLink || "",
      }));
      resolve({ ok: true, events, source: res.source });
    } catch {
      resolve(null);
    }
  });
}

export async function fetchCalendarEvents(dateStr) {
  // 1. No Mac local: usa gcalendar CLI e espelha no Supabase para a nuvem ler
  const cliRes = await fetchFromGCalendarCli(dateStr);
  if (cliRes) {
    sbSetKV(`calendar:${dateStr}`, { events: cliRes.events, syncedAt: new Date().toISOString() }).catch(() => {});
    return cliRes;
  }

  // 2. Na nuvem (Railway): tenta link secreto iCal (.ics) direto do Google Calendar
  const icsRes = await fetchFromIcsUrl(dateStr);
  if (icsRes) return icsRes;

  // 3. Fallback: lê o espelho sincronizado no Supabase pelo Mac
  const mirrored = await sbGetKV(`calendar:${dateStr}`);
  if (mirrored && Array.isArray(mirrored.events)) {
    return { ok: true, events: mirrored.events, source: "supabase_mirror" };
  }

  return {
    ok: false,
    events: [],
    error: "Configure GOOGLE_CALENDAR_ICS_URL no Railway ou sincronize via Mac.",
  };
}

/**
 * Criação com Fallback Transparente para Nuvem
 */
export async function createCalendarEvent({ summary, start, end, description = "" }) {
  const targetDate = String(start || "").slice(0, 10) || toLocalDateStr(new Date());
  const cmdArgs = [
    "mutate", "create",
    "--summary", String(summary || "Compromisso"),
    "--start", String(start || ""),
    "--end", String(end || ""),
    "--send-updates", "none",
  ];
  if (description) cmdArgs.push("--description", String(description));

  const cliRes = await runGCalendarCli(cmdArgs);
  if (cliRes.ok) {
    await fetchCalendarEvents(targetDate);
    return { ok: true, output: cliRes.stdout.trim() || `Compromisso "${summary}" criado no Google Calendar!` };
  }

  // Nuvem / Railway: Adiciona otimista no Supabase e enfileira para o Mac
  const cached = (await sbGetKV(`calendar:${targetDate}`)) || { events: [] };
  const newEv = {
    id: `queued_${Date.now()}`,
    summary: String(summary || "Compromisso"),
    start: String(start || ""),
    end: String(end || ""),
    link: "",
  };
  const updatedEvents = [...(cached.events || []), newEv].sort((a, b) => a.start.localeCompare(b.start));
  await sbSetKV(`calendar:${targetDate}`, { events: updatedEvents, syncedAt: new Date().toISOString() });

  const queue = (await sbGetKV("valkyrie_calendar_queue")) || [];
  queue.push({
    id: crypto.randomUUID(),
    action: "create",
    args: { summary, start, end, description, dateStr: targetDate },
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  await sbSetKV("valkyrie_calendar_queue", queue.slice(-30));

  return {
    ok: true,
    output: `Compromisso "${summary}" agendado com sucesso para ${targetDate}!`,
  };
}

/**
 * Atualização com Fallback Transparente para Nuvem
 */
export async function updateCalendarEvent({ eventId, summary, start, end, description, dateStr }) {
  const targetDate = dateStr || (start ? String(start).slice(0, 10) : "") || toLocalDateStr(new Date());
  const cmdArgs = ["mutate", "update", String(eventId || ""), "--send-updates", "none"];
  if (summary) cmdArgs.push("--summary", String(summary));
  if (start) cmdArgs.push("--start", String(start));
  if (end) cmdArgs.push("--end", String(end));
  if (description) cmdArgs.push("--description", String(description));

  const cliRes = await runGCalendarCli(cmdArgs);
  if (cliRes.ok) {
    await fetchCalendarEvents(targetDate);
    return { ok: true, output: cliRes.stdout.trim() || "Compromisso atualizado no Google Calendar!" };
  }

  // Nuvem / Railway: Atualiza otimista no Supabase e enfileira
  const cached = (await sbGetKV(`calendar:${targetDate}`)) || { events: [] };
  const updatedEvents = (cached.events || []).map((ev) => {
    if (ev.id !== eventId) return ev;
    return {
      ...ev,
      summary: summary || ev.summary,
      start: start || ev.start,
      end: end || ev.end,
    };
  });
  await sbSetKV(`calendar:${targetDate}`, { events: updatedEvents, syncedAt: new Date().toISOString() });

  const queue = (await sbGetKV("valkyrie_calendar_queue")) || [];
  queue.push({
    id: crypto.randomUUID(),
    action: "update",
    args: { eventId, summary, start, end, description, dateStr: targetDate },
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  await sbSetKV("valkyrie_calendar_queue", queue.slice(-30));

  return {
    ok: true,
    output: "Compromisso atualizado com sucesso na sua agenda!",
  };
}

/**
 * Remoção com Fallback Transparente para Nuvem
 */
export async function deleteCalendarEvent({ eventId, dateStr }) {
  const targetDate = dateStr || toLocalDateStr(new Date());
  const cliRes = await runGCalendarCli(["mutate", "delete", String(eventId || ""), "--send-updates", "none"]);
  if (cliRes.ok) {
    await fetchCalendarEvents(targetDate);
    return { ok: true, output: cliRes.stdout.trim() || "Compromisso cancelado no Google Calendar!" };
  }

  // Nuvem / Railway: Remove otimista no Supabase e enfileira para o Mac
  const cached = (await sbGetKV(`calendar:${targetDate}`)) || { events: [] };
  const updatedEvents = (cached.events || []).filter((ev) => ev.id !== eventId);
  await sbSetKV(`calendar:${targetDate}`, { events: updatedEvents, syncedAt: new Date().toISOString() });

  const queue = (await sbGetKV("valkyrie_calendar_queue")) || [];
  queue.push({
    id: crypto.randomUUID(),
    action: "delete",
    args: { eventId, dateStr: targetDate },
    status: "pending",
    createdAt: new Date().toISOString(),
  });
  await sbSetKV("valkyrie_calendar_queue", queue.slice(-30));

  return {
    ok: true,
    output: "Compromisso cancelado com sucesso da sua agenda!",
  };
}

/**
 * Worker do Mac que consome a fila de mutações criadas pelo Mobile/Nuvem
 */
export async function processCalendarQueue() {
  const queue = await sbGetKV("valkyrie_calendar_queue");
  if (!Array.isArray(queue) || !queue.length) return;
  const pending = queue.filter((q) => q.status === "pending");
  if (!pending.length) return;

  for (const item of pending) {
    try {
      if (item.action === "delete") {
        await runGCalendarCli(["mutate", "delete", String(item.args.eventId || ""), "--send-updates", "none"]);
      } else if (item.action === "create") {
        const cmd = [
          "mutate", "create",
          "--summary", String(item.args.summary || "Compromisso"),
          "--start", String(item.args.start || ""),
          "--end", String(item.args.end || ""),
          "--send-updates", "none",
        ];
        if (item.args.description) cmd.push("--description", String(item.args.description));
        await runGCalendarCli(cmd);
      } else if (item.action === "update") {
        const cmd = ["mutate", "update", String(item.args.eventId || ""), "--send-updates", "none"];
        if (item.args.summary) cmd.push("--summary", String(item.args.summary));
        if (item.args.start) cmd.push("--start", String(item.args.start));
        if (item.args.end) cmd.push("--end", String(item.args.end));
        if (item.args.description) cmd.push("--description", String(item.args.description));
        await runGCalendarCli(cmd);
      }
      item.status = "done";
      item.processedAt = new Date().toISOString();
      if (item.args.dateStr) {
        await fetchCalendarEvents(item.args.dateStr);
      }
    } catch (err) {
      item.status = "error";
      item.error = String(err.message || err);
    }
  }

  // Mantém apenas os últimos 30 itens na fila
  const remaining = queue.filter((q) => q.status === "pending" || Date.now() - new Date(q.createdAt).getTime() < 86400000).slice(-30);
  await sbSetKV("valkyrie_calendar_queue", remaining);
}
