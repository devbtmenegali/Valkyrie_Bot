/**
 * Valkyrie Calendar Adapter (Mac gcalendar CLI + Cloud iCal .ics + Supabase Mirror)
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { sbGetKV, sbSetKV } from "./db.mjs";

const TZ = "America/Sao_Paulo";

function toLocalDateStr(dateObj) {
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

function fetchFromGCalendarCli(dateStr) {
  return new Promise((resolve) => {
    const gcalPaths = [
      "gcalendar",
      path.join(process.env.HOME || "", ".gemini/antigravity/bin/gcalendar"),
    ];
    const tryBin = (idx) => {
      if (idx >= gcalPaths.length) return resolve(null);
      execFile(
        gcalPaths[idx],
        ["readonly", "events", "--date", dateStr, "--max", "50", "--json"],
        { timeout: 12000 },
        (err, stdout) => {
          if (err) return tryBin(idx + 1);
          try {
            const raw = JSON.parse(stdout || "[]");
            const events = (Array.isArray(raw) ? raw : []).map((ev) => ({
              id: ev.id,
              summary: ev.summary || "(Sem título)",
              start: ev.start?.dateTime || ev.start?.date || "",
              end: ev.end?.dateTime || ev.end?.date || "",
              link: ev.htmlLink || "",
            }));
            resolve({ ok: true, events, source: "gcalendar_cli" });
          } catch {
            resolve(null);
          }
        }
      );
    };
    tryBin(0);
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
    error: "Configure GOOGLE_CALENDAR_ICS_URL no Railway (Endereço secreto iCal do Google Calendar) para leitura 24/7 na nuvem.",
  };
}
