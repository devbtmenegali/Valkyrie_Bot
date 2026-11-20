/**
 * Skill: Controle Financeiro PF/PJ, Contas a Pagar & Receber + Cobranças
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

export async function listFinance(appDir) {
  const remote = await sbReq("valkyrie_finance?select=*&order=due_date.asc");
  let list = Array.isArray(remote) ? remote : readLocal(appDir);
  if (Array.isArray(remote)) writeLocal(appDir, remote);

  const today = todayISO();
  return list.map((item) => ({
    ...item,
    amount: Number(item.amount || 0),
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

export async function markFinancePaid(appDir, id) {
  const list = await listFinance(appDir);
  const item = list.find((i) => i.id === id);
  if (!item) return null;
  item.status = "pago";
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

  return {
    totalPagarAberto: sum(openPay),
    totalReceberAberto: sum(openRecv),
    totalAtrasadoReceber: sum(overdueRecv),
    totalAtrasadoPagar: sum(overduePay),
    countPagar: openPay.length,
    countReceber: openRecv.length,
    overdueReceivables: overdueRecv,
    items: list,
  };
}

export function buildCollectionMessage(entry) {
  const valor = Number(entry.amount || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const venc = String(entry.due_date || "").split("-").reverse().join("/");
  return `Olá ${entry.counterparty}, tudo bem? Aqui é a Valkyrie, assistente financeira do Bruno (${entry.scope}). Passando para lembrar gentilmente do pagamento referente a "${entry.description}" no valor de ${valor}, com vencimento em ${venc}. Caso já tenha sido efetuado, pode desconsiderar e me enviar o comprovante por aqui. Obrigada!`;
}
