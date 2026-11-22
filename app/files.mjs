/**
 * Motor de Processamento de Arquivos da Kyrie
 * Recebe PDFs, Imagens, Documentos, Contratos, Livros e Novas Skills
 * Organiza, resume, analisa, cadastra no financeiro ou incorpora como nova Skill/Conhecimento.
 */
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

function ensureUploadsDir(appDir) {
  const p = path.join(appDir, "uploads");
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

export async function extractDocumentText(filePath, appDir = path.dirname(filePath)) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".txt" || ext === ".md" || ext === ".json" || ext === ".csv") {
    try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
  }
  if (ext === ".pdf") {
    return new Promise((resolve) => {
      const pyScript = `import pypdf, sys
try:
    reader = pypdf.PdfReader(sys.argv[1])
    text = "\\n".join([page.extract_text() or "" for page in reader.pages])
    print(text)
except Exception:
    sys.exit(0)`;
      const venvPy = path.join(appDir, ".venv", "bin", "python3");
      const pyBin = fs.existsSync(venvPy) ? venvPy : "python3";
      execFile(pyBin, ["-c", pyScript, filePath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) resolve("");
        else resolve(stdout.trim());
      });
    });
  }
  if (ext === ".docx" || ext === ".doc" || ext === ".rtf") {
    return new Promise((resolve) => {
      execFile("textutil", ["-convert", "txt", "-stdout", filePath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) resolve("");
        else resolve(stdout.trim());
      });
    });
  }
  return "";
}

export async function processCurriculumFile({
  appDir,
  fileName,
  fileBase64,
  textContent,
  runSimplePromptAI,
  saveMemoryFact,
  memoryPath,
  saveFounderDossier,
}) {
  const uploads = ensureUploadsDir(appDir);
  const safeName = (fileName || `curriculo_${Date.now()}.pdf`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const targetPath = path.join(uploads, `cv_${safeName}`);

  if (fileBase64) {
    fs.writeFileSync(targetPath, Buffer.from(fileBase64, "base64"));
  } else if (textContent) {
    fs.writeFileSync(targetPath, textContent, "utf8");
  }

  let extracted = textContent || await extractDocumentText(targetPath, appDir);

  const sysPrompt = `Você é a Kyrie, Assessora Executiva e Estratégica de Bruno Menegali.
Você acabou de receber o CURRÍCULO PROFISSIONAL E ACADÊMICO oficial do Bruno Menegali.
Analise com rigor cirúrgico e extraia uma síntese executiva impecável para integrar ao Dossiê do Fundador.

Formato da resposta:
### 🎓 Formação Acadêmica & Docência
(Títulos, universidades, pós-graduações, especializações, docência UNISUL/UNIBAVE)

### 🏢 Trajetória Corporativa & Empreendedora
(Empresas fundadas, cargos executivos, áreas de atuação e negócios)

### ⚡ Competências Estratégicas & Diferenciais
(Principais conquistas, habilidades de alta performance e autoridade)

### 📌 Resumo Executivo para a Kyrie
(Síntese de 2 a 3 parágrafos capturando o perfil e o DNA de realizador do Bruno)`;

  const ai = await runSimplePromptAI({
    preferredProvider: "openai",
    systemPrompt: sysPrompt,
    userText: `ARQUIVO: ${safeName}\n\nCONTEÚDO EXTRAÍDO DO CURRÍCULO:\n${(extracted || "Arquivo binário armazenado").slice(0, 7000)}`,
    maxTokens: 1400,
  });

  const summary = ai.reply || "Currículo processado e salvo.";

  if (saveFounderDossier) {
    await saveFounderDossier(appDir, {
      curriculum: {
        fileName: safeName,
        uploadedAt: new Date().toISOString(),
        summary,
        rawLength: (extracted || "").length,
      },
    });
  }

  if (saveMemoryFact) {
    saveMemoryFact(memoryPath, {
      pillar: "Fundador/Currículo",
      fact: `Currículo acadêmico e profissional de Bruno Menegali incorporado ao Dossiê: "${safeName}".`,
    });
  }

  return {
    ok: true,
    curriculum: {
      fileName: safeName,
      uploadedAt: new Date().toISOString(),
      summary,
    },
  };
}

export async function processIncomingFile({
  appDir,
  fileName,
  fileType,
  fileBase64,
  textContent,
  userPrompt = "",
  runSimplePromptAI,
  addFinanceEntry,
  addLibraryBook,
  saveMemoryFact,
  memoryPath,
}) {
  const uploads = ensureUploadsDir(appDir);
  const safeName = (fileName || `arquivo_${Date.now()}`).replace(/[^a-zA-Z0-9._-]/g, "_");
  const targetPath = path.join(uploads, safeName);

  // Salva no disco
  if (fileBase64) {
    const buffer = Buffer.from(fileBase64, "base64");
    fs.writeFileSync(targetPath, buffer);
  } else if (textContent) {
    fs.writeFileSync(targetPath, textContent, "utf8");
  }

  const ext = path.extname(safeName).toLowerCase();
  const lowerPrompt = (userPrompt || "").toLowerCase();

  // 1. Detecta se é uma Nova SKILL para a Kyrie
  const isSkill = lowerPrompt.includes("skill") || lowerPrompt.includes("habilidade") || ext === ".mjs" || (ext === ".md" && safeName.includes("skill"));
  if (isSkill) {
    const skillsDir = path.join(appDir, "skills");
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
    const skillPath = path.join(skillsDir, safeName);
    fs.copyFileSync(targetPath, skillPath);

    const memoryText = `Nova Skill incorporada: "${safeName}" adicionada ao repertório executivo da Kyrie.`;
    if (saveMemoryFact) saveMemoryFact(memoryPath, { pillar: "Skills/Capacidades", fact: memoryText });

    return {
      action: "skill_installed",
      fileName: safeName,
      message: `✨ **Nova Skill Incorporada com Sucesso!**\n\nInstalei o arquivo \`${safeName}\` diretamente no meu diretório de habilidades (\`app/skills/\`). Já absorvi a lógica e ela está disponível para uso imediato em todas as nossas conversas.`,
    };
  }

  // 2. Detecta se é um LIVRO / PLAYBOOK para a Biblioteca
  const isBook = lowerPrompt.includes("livro") || lowerPrompt.includes("book") || lowerPrompt.includes("playbook") || lowerPrompt.includes("biblioteca") || lowerPrompt.includes("estude");
  if (isBook) {
    let bookContent = textContent || "";
    if (!bookContent) {
      bookContent = await extractDocumentText(targetPath, appDir);
    }
    if (!bookContent && fileBase64) {
      try { bookContent = Buffer.from(fileBase64, "base64").toString("utf8"); } catch {}
    }
    const bookTitle = fileName.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ");
    addLibraryBook(appDir, {
      fileName: safeName,
      title: bookTitle,
      content: bookContent || `Arquivo anexado: ${safeName}. Análise em andamento.`,
    });

    const fact = `Novo livro/playbook estudado e adicionado à biblioteca: "${bookTitle}".`;
    if (saveMemoryFact) saveMemoryFact(memoryPath, { pillar: "Biblioteca/Conhecimento", fact });

    return {
      action: "book_added",
      fileName: safeName,
      message: `📚 **Livro Adicionado à Minha Biblioteca!**\n\nIncorporei o material **"${bookTitle}"** à minha base permanente de inteligência. A partir de agora, aplicarei as teses e ensinamentos dele em todas as análises de valuation, investimentos e decisões estratégicas da GluN, ProntoMed, CliniMind e Nossa Casa.`,
    };
  }

  // 3. Detecta se é um BOLETO / CONTA A PAGAR / COMPROVANTE
  const isBoletoOrBill = lowerPrompt.includes("boleto") || lowerPrompt.includes("conta") || lowerPrompt.includes("pagar") || lowerPrompt.includes("fatura") || lowerPrompt.includes("nota fiscal");
  if (isBoletoOrBill) {
    // Extrai dados via AI
    const sysPrompt = `Você é a Kyrie, assistente financeira de Bruno Menegali.
O usuário enviou um boleto/fatura ou documento de pagamento.
Extraia os dados essenciais e responda EXCLUSIVAMENTE um JSON:
{
  "kind": "pagar",
  "scope": "PF|Nossa Casa|GluN|ProntoMed|CliniMind",
  "counterparty": "Nome do favorecido/empresa/banco",
  "description": "Descrição curta da conta",
  "amount": 1250.00,
  "due_date": "YYYY-MM-DD",
  "recurrence": "mensal|unica"
}`;
    try {
      const ai = await runSimplePromptAI({
        preferredProvider: "openai",
        systemPrompt: sysPrompt,
        userText: `Arquivo: ${safeName}\nInstrução do Bruno: ${userPrompt}\nConteúdo/Texto:\n${(textContent || "").slice(0, 3000)}`,
        maxTokens: 300,
      });
      const parsed = JSON.parse(ai.reply.match(/\{[\s\S]*\}/)?.[0] || "{}");
      if (parsed.amount && parsed.counterparty) {
        const entry = await addFinanceEntry(appDir, parsed);
        return {
          action: "bill_registered",
          entry,
          message: `💸 **Conta Cadastrada no Financeiro!**\n\n• **Favorecido:** ${entry.counterparty} (${entry.scope})\n• **Valor:** R$ ${Number(entry.amount).toFixed(2)}\n• **Vencimento:** ${entry.due_date.split("-").reverse().join("/")} (${entry.recurrence || "mensal"})\n\nO lançamento já está agendado na sua aba **Finanças** com alerta de vencimento ativado.`,
        };
      }
    } catch {}
  }

  // 4. Análise e Resumo Geral de Documento / Contrato / PDF
  let docText = textContent || "";
  if (!docText && (ext === ".md" || ext === ".txt" || ext === ".json" || ext === ".csv")) {
    try { docText = fs.readFileSync(targetPath, "utf8"); } catch {}
  }

  const sysPrompt = `Você é a Kyrie, Chief of Staff e Assessora Estratégica de Bruno Menegali.
Bruno acabou de te enviar o arquivo "${safeName}".
Instrução do Bruno: "${userPrompt || "Analise este arquivo, resuma os pontos essenciais, aponte riscos ou oportunidades e me dê a melhor recomendação prática."}"

Perfil do Bruno: CEO da GluN Capital S.A., fundador de SaaS de Saúde (ProntoMed/CliniMind), dono da loja física Nossa Casa, investidor de longo prazo com foco em equity e chegar a R$ 1 Bilhão.

Sua resposta deve ter:
1. 📄 **Resumo Executivo do Documento** (O que é e o que está em jogo)
2. ⚠️ **Pontos Críticos / Cláusulas de Atenção / Riscos**
3. 🚀 **Oportunidades & Próximo Passo Recomendado pela Kyrie**

Seja direta, cirúrgica e assine como Kyrie.`;

  try {
    const ai = await runSimplePromptAI({
      preferredProvider: "xai",
      systemPrompt: sysPrompt,
      userText: `NOME DO ARQUIVO: ${safeName}\n\nCONTEÚDO/PRÉVIA DO DOCUMENTO:\n${(docText || "Arquivo binário armazenado em uploads.").slice(0, 4500)}`,
      maxTokens: 1500,
    });

    // Registra na memória que esse documento foi analisado
    if (saveMemoryFact) {
      saveMemoryFact(memoryPath, {
        pillar: "Documentos/Projetos",
        fact: `Documento analisado: "${safeName}". Síntese executiva processada com foco estratégico.`,
      });
    }

    return {
      action: "document_analyzed",
      fileName: safeName,
      message: ai.reply,
    };
  } catch (err) {
    return {
      action: "saved",
      fileName: safeName,
      message: `Arquivo \`${safeName}\` recebido e armazenado em \`uploads/\`. Não consegui processar a análise profunda no momento: ${err.message}`,
    };
  }
}

