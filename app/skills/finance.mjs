/**
 * Skill: Controle Financeiro Multiescopo (PF, Nossa Casa, GluN, ProntoMed, CliniMind)
 * Suporte a Contas a Pagar/Receber, Recorrência (Única/Mensal/Anual), Edição Completa, Rollover e Cobranças
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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
  return path.join(appDir, "finance.json");
}

function readLocal(appDir) {
  const p = localPath(appDir);
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return []; }
}

function writeLocal(appDir, list) {
  fs.writeFileSync(localPath(appDir), JSON.stringify(list, null, 2), "utf8");
}

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function computeNextDueDate(currentDueDate, recurrence) {
  const [y, m, d] = (currentDueDate || todayISO()).split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (recurrence === "mensal") {
    date.setUTCMonth(date.getUTCMonth() + 1);
  } else if (recurrence === "anual") {
    date.setUTCFullYear(date.getUTCFullYear() + 1);
  } else if (recurrence === "semanal") {
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return date.toISOString().slice(0, 10);
}

export async function listFinance(appDir) {
  const remote = await sbReq("valkyrie_finance?select=*&order=due_date.asc");
  let list = Array.isArray(remote) ? remote : readLocal(appDir);
  if (Array.isArray(remote)) writeLocal(appDir, remote);

  const today = todayISO();
  return list.map((item) => ({
    ...item,
    amount: Number(item.amount || 0),
    recurrence: item.recurrence || "unica",
    effectiveStatus: item.status === "pago" ? "pago" : item.due_date < today ? "atrasado" : "pendente",
  }));
}

export async function addFinanceEntry(appDir, data) {
  const entry = {
    id: crypto.randomUUID(),
    kind: data.kind === "receber" ? "receber" : "pagar",
    scope: data.scope || "PF",
    counterparty: String(data.counterparty || "Não informado").trim(),
    contact_phone: String(data.contact_phone || "").replace(/\D/g, ""),
    description: String(data.description || "").trim(),
    amount: Number(String(data.amount || "0").replace(/[^\d.,-]/g, "").replace(",", ".")) || 0,
    due_date: data.due_date || todayISO(),
    recurrence: data.recurrence || "mensal",
    status: data.status || "pendente",
    ir_deductible: Boolean(data.ir_deductible),
    notes: data.notes || "",
    created_at: new Date().toISOString(),
  };

  const list = await listFinance(appDir);
  list.push(entry);
  writeLocal(appDir, list);

  await sbReq("valkyrie_finance", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(entry),
  });

  return entry;
}

export async function updateFinanceEntry(appDir, id, updates) {
  const list = await listFinance(appDir);
  const idx = list.findIndex((i) => i.id === id);
  if (idx === -1) return null;

  const cur = list[idx];
  const updated = {
    ...cur,
    kind: updates.kind || cur.kind,
    scope: updates.scope || cur.scope,
    counterparty: updates.counterparty !== undefined ? String(updates.counterparty).trim() : cur.counterparty,
    contact_phone: updates.contact_phone !== undefined ? String(updates.contact_phone).replace(/\D/g, "") : cur.contact_phone,
    description: updates.description !== undefined ? String(updates.description).trim() : cur.description,
    amount: updates.amount !== undefined ? (Number(String(updates.amount).replace(/[^\d.,-]/g, "").replace(",", ".")) || 0) : cur.amount,
    due_date: updates.due_date || cur.due_date,
    recurrence: updates.recurrence || cur.recurrence || "unica",
    status: updates.status || cur.status,
    notes: updates.notes !== undefined ? updates.notes : cur.notes,
    updated_at: new Date().toISOString(),
  };

  list[idx] = updated;
  writeLocal(appDir, list);

  await sbReq(`valkyrie_finance?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(updated),
  });

  return updated;
}

export async function deleteFinanceEntry(appDir, id) {
  let list = await listFinance(appDir);
  list = list.filter((i) => i.id !== id);
  writeLocal(appDir, list);

  await sbReq(`valkyrie_finance?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });

  return true;
}

export async function markFinancePaid(appDir, id) {
  const list = await listFinance(appDir);
  const item = list.find((i) => i.id === id);
  if (!item) return null;
  item.status = "pago";

  // Se for conta recorrente (mensal/anual/semanal), agenda automaticamente o próximo ciclo!
  if (item.recurrence && item.recurrence !== "unica") {
    const nextDate = computeNextDueDate(item.due_date, item.recurrence);
    const nextEntry = {
      id: crypto.randomUUID(),
      kind: item.kind,
      scope: item.scope,
      counterparty: item.counterparty,
      contact_phone: item.contact_phone || "",
      description: item.description,
      amount: item.amount,
      due_date: nextDate,
      recurrence: item.recurrence,
      status: "pendente",
      ir_deductible: item.ir_deductible,
      notes: item.notes || "",
      created_at: new Date().toISOString(),
    };
    list.push(nextEntry);
    sbReq("valkyrie_finance", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(nextEntry),
    }).catch(() => {});
  }

  writeLocal(appDir, list);

  await sbReq(`valkyrie_finance?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "pago" }),
  });

  return item;
}

export async function getFinanceSummary(appDir) {
  const list = await listFinance(appDir);
  const openPay = list.filter((i) => i.kind === "pagar" && i.status !== "pago");
  const openRecv = list.filter((i) => i.kind === "receber" && i.status !== "pago");
  const overdueRecv = openRecv.filter((i) => i.effectiveStatus === "atrasado");
  const overduePay = openPay.filter((i) => i.effectiveStatus === "atrasado");

  const sum = (arr) => arr.reduce((acc, x) => acc + Number(x.amount || 0), 0);

  // Totais por escopo (PF, Nossa Casa, GluN, ProntoMed, CliniMind)
  const byScope = {};
  for (const item of list) {
    const s = item.scope || "PF";
    if (!byScope[s]) byScope[s] = { pagar: 0, receber: 0, count: 0 };
    if (item.status !== "pago") {
      if (item.kind === "pagar") byScope[s].pagar += Number(item.amount || 0);
      else byScope[s].receber += Number(item.amount || 0);
      byScope[s].count++;
    }
  }

  return {
    totalPagarAberto: sum(openPay),
    totalReceberAberto: sum(openRecv),
    totalAtrasadoReceber: sum(overdueRecv),
    totalAtrasadoPagar: sum(overduePay),
    countPagar: openPay.length,
    countReceber: openRecv.length,
    overdueReceivables: overdueRecv,
    byScope,
    items: list,
  };
}

export function buildCollectionMessage(entry) {
  const valor = Number(entry.amount || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const venc = String(entry.due_date || "").split("-").reverse().join("/");
  return `Olá ${entry.counterparty}, tudo bem? Aqui é a Kyrie, assistente financeira do Bruno (${entry.scope}). Passando para lembrar gentilmente do pagamento referente a "${entry.description}" no valor de ${valor}, com vencimento em ${venc}. Caso já tenha sido efetuado, pode desconsiderar e me enviar o comprovante por aqui. Obrigada!`;
}
