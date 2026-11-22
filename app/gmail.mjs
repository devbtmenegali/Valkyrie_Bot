/**
 * Valkyrie Gmail Adapter
 * Leitura, busca, criação de rascunhos e disparo executivo de e-mails via Gmail REST API / CLI
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { sbGetKV, sbSetKV } from "./db.mjs";

export function runGmailCli(args) {
  return new Promise((resolve) => {
    const agyBin = process.env.ANTIGRAVITY_AGENTAPI_EXE || path.join(process.env.HOME || "", ".gemini/bin/agy");
    const binPath = path.join(process.env.HOME || "", ".gemini/antigravity/bin/gmail");

    // Tentativa 1: agy plugin-cli gmail
    execFile(agyBin, ["plugin-cli", "gmail", ...args], { timeout: 20000 }, (err1, stdout1, stderr1) => {
      if (!err1) return resolve({ ok: true, stdout: stdout1 || "", stderr: stderr1 || "", source: "agy_cli" });

      // Tentativa 2: gmail direto no PATH
      execFile("gmail", args, { timeout: 20000 }, (err2, stdout2, stderr2) => {
        if (!err2) return resolve({ ok: true, stdout: stdout2 || "", stderr: stderr2 || "", source: "gmail_cli" });

        // Tentativa 3: caminho do binário local
        execFile(binPath, args, { timeout: 20000 }, (err3, stdout3, stderr3) => {
          if (!err3) return resolve({ ok: true, stdout: stdout3 || "", stderr: stderr3 || "", source: "gmail_bin" });
          resolve({ ok: false, error: err1.message || err2.message || err3.message });
        });
      });
    });
  });
}

/**
 * Busca e-mails no Gmail (ex: 'is:unread', 'from:stone', 'fatura', 'prontomed')
 */
export async function searchEmails({ query = "is:unread", max = 8 } = {}) {
  const res = await runGmailCli(["readonly", "search", query, "--max", String(max), "--json"]);
  if (!res.ok) {
    // Fallback: tentar ler cache do Supabase se estiver na nuvem
    const cached = await sbGetKV(`gmail:search:${query}`);
    return { ok: Boolean(cached?.messages), messages: cached?.messages || [], source: "cache", error: res.error };
  }
  try {
    const messages = JSON.parse(res.stdout || "[]");
    sbSetKV(`gmail:search:${query}`, { messages, syncedAt: new Date().toISOString() }).catch(() => {});
    return { ok: true, messages, source: res.source };
  } catch (e) {
    return { ok: false, messages: [], error: e.message };
  }
}

/**
 * Lê uma mensagem ou thread completa pelo ID
 */
export async function readEmail({ id }) {
  const res = await runGmailCli(["readonly", "read", id, "--json"]);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    const data = JSON.parse(res.stdout || "{}");
    return { ok: true, email: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Cria rascunho de e-mail no Gmail
 */
export async function createEmailDraft({ to, subject, body }) {
  const res = await runGmailCli(["mutate", "create-draft", "--to", to, "--subject", subject, "--body", body]);
  return { ok: res.ok, result: res.stdout || res.stderr, error: res.error };
}

/**
 * Envia e-mail diretamente pelo Gmail
 */
export async function sendEmail({ to, subject, body }) {
  const res = await runGmailCli(["mutate", "send", "--to", to, "--subject", subject, "--body", body]);
  return { ok: res.ok, result: res.stdout || res.stderr, error: res.error };
}

/**
 * Briefing de E-mails Importantes
 */
export async function getEmailBriefing() {
  const unreadRes = await searchEmails({ query: "is:unread -category:promotions -category:social", max: 10 });
  const messages = unreadRes.messages || [];
  return {
    totalUnreadPrimary: messages.length,
    messages: messages.map((m) => ({
      id: m.id || m.ID,
      from: m.from || m.From,
      subject: m.subject || m.Subject,
      date: m.date || m.Date,
      snippet: m.snippet || m.Snippet || "",
    })),
  };
}
