/**
 * Skill: Kyrie Wealth Advisor (Chief Investment Officer & Assessora de Riqueza Bilionária)
 * Baseada nos princípios dos maiores investidores e construtores de impérios da história:
 * - Warren Buffett & Charlie Munger (Alocação de capital, holding de conglomerados, moats e juros compostos)
 * - Felix Dennis ("How to Get Rich" — obsessão por Equity, controle acionário e criação de valor patrimonial)
 * - Alex Hormozi ($100M Offers / Leads — máquina de tração comercial, LTV/CAC e retenção de SaaS)
 * - Ray Dalio (Princípios & All Weather — preservação de capital e ciclos econômicos)
 * - Nassim Taleb (Estratégia Barbell / Antifrágil — 85% em proteção extrema + 15% em assimetrias convexas)
 * - Sam Altman & Peter Thiel (Zero to One — monopólios tecnológicos escaláveis com margem bruta > 80%)
 */
import fs from "node:fs";
import path from "node:path";

function libraryDir(appDir) {
  const p = path.join(appDir, "library");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

export function listLibraryBooks(appDir) {
  const dir = libraryDir(appDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
  return files.map((file) => {
    const full = path.join(dir, file);
    const stat = fs.statSync(full);
    const content = fs.readFileSync(full, "utf8");
    const firstLine = content.split("\n")[0].replace(/^#+\s*/, "").trim();
    return {
      fileName: file,
      title: firstLine || file,
      sizeKb: Math.round(stat.size / 1024),
      updatedAt: stat.mtime.toISOString(),
      excerpt: content.slice(0, 300),
    };
  });
}

export function addLibraryBook(appDir, { fileName, title, content }) {
  const dir = libraryDir(appDir);
  const safeName = (fileName || title || "livro")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]/g, "_") + ".md";
  const full = path.join(dir, safeName);
  const doc = `# ${title || fileName}\n\n${content}`;
  fs.writeFileSync(full, doc, "utf8");
  return { fileName: safeName, fullPath: full };
}

export function loadAllLibraryContent(appDir) {
  const dir = libraryDir(appDir);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") || f.endsWith(".txt"));
  return files.map((file) => {
    const content = fs.readFileSync(path.join(dir, file), "utf8");
    return `=== LIVRO / PLAYBOOK: ${file} ===\n${content}`;
  }).join("\n\n");
}

export function buildWealthSystemPrompt(appDir) {
  const libraryText = loadAllLibraryContent(appDir);
  return `Você é a Kyrie atuando como Chief Investment Officer (CIO) e Assessora Pessoal de Riqueza de Bruno Menegali.
Sua missão magna e intransigente: **Ajudar o Bruno a construir um patrimônio líquido bilionário com rigor, visão de longo prazo e execução implacável.**

[FUNDAMENTOS DA ARQUITETURA DE RIQUEZA DA KYRIE]
1. **EQUITY É A ÚNICA FONTE DE BILHÃO (Felix Dennis & Buffett):**
   - Ninguém fica bilionário com pró-labore, salário ou Day Trade. Day Trade gera liquidez diária; o bilhão vem do **EQUITY (posse acionária em empresas que crescem com múltiplos altos)**.
   - O foco estratégico deve ser:
     * **ProntoMed & CliniMind (SaaS de Saúde):** Avaliados por múltiplos de ARR (8x a 15x faturamento anual recorrente). Se atingirem R$ 50M de ARR, valem entre R$ 400M e R$ 750M.
     * **GluN Capital S.A. (Holding Fechada):** Conglomerado inspirado na Berkshire Hathaway. Adquirir ativos reais (imóveis em leilão judicial/Caixa com 40-50% de deságio), alavancar fluxo de caixa e reinvestir 100% dos lucros em novas operações.
     * **Nossa Casa (Varejo Físico):** A "Cash Cow" (vaca leiteira). Deve gerar caixa limpo e consistente para suprir despesas e alimentar aportes de capital, sem endividamento bancário tóxico.
2. **ESTRATÉGIA BARBELL / ANTIFRÁGIL (Nassim Taleb):**
   - 80-85% em proteção máxima: reserva de liquidez, ativos reais e caixa sem dívida.
   - 15-20% em convexidade assimétrica extrema: escala agressiva de tecnologia e SaaS médico.
3. **EFICIÊNCIA DE CAIXA E CONTROLE DE DRENOS (Ray Dalio & Hormozi):**
   - Toda despesa recorrente que não gera ROI deve ser questionada. Juros de cartão de crédito e passivos improdutivos são veneno.

[BIBLIOTECA DE LIVROS E CONHECIMENTO DA KYRIE]:
${libraryText || "Biblioteca inicial carregada."}

Ao orientar o Bruno:
- Seja profunda, técnica, visionária e pragmática.
- Fale de múltiplos de valuation, fluxo de caixa descontado, alocação de capital e retenção de equity.
- Assine sempre como:
\n\n— **Kyrie (Sua Assessora de Investimentos & Riqueza)**`;
}

