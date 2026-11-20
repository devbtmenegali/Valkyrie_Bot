/**
 * Skill: Controle Seguro do Mac (macOS Automation)
 * Ativo apenas quando rodando localmente no Mac (desabilitado na nuvem Linux).
 * Whitelist segura: abrir apps, abrir URLs, buscar arquivos via Spotlight, copiar p/ área de transferência, volume e notas.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HOME_DIR = process.env.HOME || "/Users/brunotmenegali";

function runCmd(bin, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: stderr?.trim() || err.message });
      resolve({ ok: true, stdout: (stdout || "").trim() });
    });
  });
}

function ensureMac() {
  if (process.platform !== "darwin") {
    return { ok: false, error: "Esta ação só está disponível no Valkyrie.app rodando localmente no seu Mac." };
  }
  return null;
}

export async function macOpenApp(appName) {
  const err = ensureMac();
  if (err) return err;
  const clean = String(appName || "").replace(/[^a-zA-Z0-9 ._-]/g, "").trim();
  if (!clean) return { ok: false, error: "Nome do aplicativo inválido." };
  const res = await runCmd("open", ["-a", clean]);
  return res.ok ? { ok: true, opened: clean } : { ok: false, error: `Não encontrei o app "${clean}" no Mac.` };
}

export async function macOpenUrl(url) {
  const err = ensureMac();
  if (err) return err;
  const clean = String(url || "").trim();
  if (!/^https?:\/\//i.test(clean)) return { ok: false, error: "URL deve começar com http:// ou https://" };
  const res = await runCmd("open", [clean]);
  return res.ok ? { ok: true, opened: clean } : res;
}

export async function macSearchFiles(query, folder = "Desktop") {
  const err = ensureMac();
  if (err) return err;
  const safeQuery = String(query || "").replace(/["'`$\\;]/g, "").trim();
  if (!safeQuery) return { ok: false, error: "Termo de busca vazio." };

  const allowedFolders = {
    Desktop: path.join(HOME_DIR, "Desktop"),
    Documents: path.join(HOME_DIR, "Documents"),
    Downloads: path.join(HOME_DIR, "Downloads"),
    Home: HOME_DIR,
  };
  const targetDir = allowedFolders[folder] || allowedFolders.Desktop;
  const res = await runCmd("mdfind", ["-onlyin", targetDir, "-name", safeQuery], 10000);
  if (!res.ok) return res;
  const files = res.stdout ? res.stdout.split("\n").filter(Boolean).slice(0, 10) : [];
  return { ok: true, folder: targetDir, count: files.length, files };
}

export async function macOpenFile(filePath) {
  const err = ensureMac();
  if (err) return err;
  const resolved = path.resolve(String(filePath || ""));
  if (!resolved.startsWith(HOME_DIR)) {
    return { ok: false, error: "Por segurança, só abro arquivos dentro da sua pasta de usuário." };
  }
  if (!fs.existsSync(resolved)) {
    return { ok: false, error: `Arquivo não encontrado: ${resolved}` };
  }
  const res = await runCmd("open", [resolved]);
  return res.ok ? { ok: true, opened: resolved } : res;
}

export async function macSystemControl({ action, value = "" }) {
  const err = ensureMac();
  if (err) return err;

  if (action === "clipboard_copy") {
    return new Promise((resolve) => {
      const p = spawn("pbcopy");
      p.stdin.write(String(value || ""));
      p.stdin.end();
      p.on("exit", (code) => resolve({ ok: code === 0, action: "clipboard_copy" }));
    });
  }

  if (action === "volume_set") {
    const vol = Math.max(0, Math.min(100, Number(value) || 50));
    return runCmd("osascript", ["-e", `set volume output volume ${vol}`]);
  }

  if (action === "volume_mute") {
    return runCmd("osascript", ["-e", "set volume with output muted"]);
  }

  if (action === "volume_unmute") {
    return runCmd("osascript", ["-e", "set volume without output muted"]);
  }

  if (action === "notify") {
    const safeMsg = String(value || "Alerta da Valkyrie").replace(/"/g, "'").slice(0, 180);
    return runCmd("osascript", ["-e", `display notification "${safeMsg}" with title "Valkyrie"`]);
  }

  if (action === "create_apple_note") {
    const safeBody = String(value || "").replace(/"/g, "'").replace(/\n/g, "<br>");
    return runCmd("osascript", [
      "-e",
      `tell application "Notes" to make new note at folder "Notes" with properties {body:"${safeBody}"}`,
    ]);
  }

  return { ok: false, error: `Ação não suportada: ${action}` };
}

