/**
 * Valkyrie Multi-AI Brain — Gemini + OpenAI + Grok (xAI) + Qwen (DashScope) + Mistral
 * Suporta Function Calling real em todos os 5 provedores + Fallback Automático + Memória Persistente
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { getHolidayInfo } from "./holidays.mjs";
import { sbSaveMemory } from "./db.mjs";
import { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } from "./calendar.mjs";
import { loadFounderDossier } from "./dossier.mjs";
import { loadAllLibraryContent } from "./skills/wealth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

const PROVIDERS = {
  gemini: {
    id: "gemini",
    label: "Gemini 3.8 Flash",
    envKey: "GOOGLE_API_KEY",
    altEnvKey: "GEMINI_API_KEY",
    model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    type: "gemini",
  },
  openai: {
    id: "openai",
    label: "GPT-4o Mini",
    envKey: "OPENAI_API_KEY",
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    url: "https://api.openai.com/v1/chat/completions",
    type: "openai",
  },
  xai: {
    id: "xai",
    label: "Grok (xAI)",
    envKey: "XAI_API_KEY",
    model: process.env.XAI_MODEL || "grok-4.20-0309-non-reasoning",
    url: "https://api.x.ai/v1/chat/completions",
    type: "openai",
  },
  qwen: {
    id: "qwen",
    label: "Qwen Plus",
    envKey: "DASHSCOPE_API_KEY",
    model: process.env.QWEN_MODEL || "qwen-plus",
    url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
    type: "openai",
  },
  mistral: {
    id: "mistral",
    label: "Mistral Small",
    envKey: "MISTRAL_API_KEY",
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
    url: "https://api.mistral.ai/v1/chat/completions",
    type: "openai",
  },
};

export function getConfiguredProviders() {
  return Object.values(PROVIDERS)
    .map((p) => ({
      id: p.id,
      label: p.label,
      model: p.model,
      enabled: Boolean(process.env[p.envKey] || (p.altEnvKey && process.env[p.altEnvKey])),
    }));
}

function getKeyFor(p) {
  return process.env[p.envKey] || (p.altEnvKey ? process.env[p.altEnvKey] : "") || "";
}

export function loadMemoryFacts(memoryPath) {
  if (!fs.existsSync(memoryPath)) return [];
  try { return JSON.parse(fs.readFileSync(memoryPath, "utf8")); } catch { return []; }
}

export function saveMemoryFact(memoryPath, { pillar = "Geral", fact }) {
  const facts = loadMemoryFacts(memoryPath);
  const entry = {
    id: crypto.randomUUID(),
    pillar,
    fact: String(fact || "").trim(),
    createdAt: new Date().toISOString(),
  };
  facts.unshift(entry);
  fs.writeFileSync(memoryPath, JSON.stringify(facts.slice(0, 200), null, 2), "utf8");
  sbSaveMemory({ pillar, fact: entry.fact }).catch(() => {});
  return entry;
}

export function deleteMemoryFact(memoryPath, id) {
  let facts = loadMemoryFacts(memoryPath);
  facts = facts.filter((f) => f.id !== id);
  fs.writeFileSync(memoryPath, JSON.stringify(facts, null, 2), "utf8");
  return true;
}

// Definição unificada das 7 ferramentas executivas
const BASE_TOOLS = [
  {
    name: "get_calendar_events",
    description: "Lista os eventos do Google Calendar do Bruno em uma data específica (YYYY-MM-DD) e verifica conflitos.",
    parameters: {
      type: "object",
      properties: {
        date: { type: "string", description: "Data no formato YYYY-MM-DD (ex: 2026-11-20)" },
      },
      required: ["date"],
    },
  },
  {
    name: "create_calendar_event",
    description: "Cria um novo evento pessoal/compromisso no Google Calendar do Bruno (sem convidados externos). Sempre cheque get_calendar_events antes.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Título do evento" },
        start: { type: "string", description: "Início em RFC3339 com offset -03:00 (ex: 2026-11-20T14:00:00-03:00)" },
        end: { type: "string", description: "Fim em RFC3339 com offset -03:00 (ex: 2026-11-20T15:00:00-03:00)" },
        description: { type: "string", description: "Descrição opcional do evento" },
      },
      required: ["summary", "start", "end"],
    },
  },
  {
    name: "update_calendar_event",
    description: "Ajusta/move/renomeia um evento existente no Google Calendar do Bruno pelo event_id (obtido via get_calendar_events).",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "ID exato do evento retornado por get_calendar_events" },
        summary: { type: "string", description: "Novo título opcional" },
        start: { type: "string", description: "Novo início em RFC3339 com offset -03:00 (ex: 2026-11-20T16:00:00-03:00)" },
        end: { type: "string", description: "Novo fim em RFC3339 com offset -03:00 (ex: 2026-11-20T17:00:00-03:00)" },
        description: { type: "string", description: "Nova descrição opcional" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "delete_calendar_event",
    description: "Remove/cancela um evento do Google Calendar do Bruno pelo event_id (SOMENTE quando o Bruno pedir explicitamente para apagar/remover/cancelar aquele evento).",
    parameters: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "ID exato do evento retornado por get_calendar_events" },
      },
      required: ["event_id"],
    },
  },
  {
    name: "list_kanban_tasks",
    description: "Lista todas as tarefas abertas e concluídas do Kanban (GluN Capital, ProntoMed, CliniMind, Nossa Casa, Inbox).",
    parameters: {
      type: "object",
      properties: {
        pillar: { type: "string", description: "Filtro opcional por pilar (ex: GluN, ProntoMed, CliniMind)" },
      },
    },
  },
  {
    name: "add_kanban_task",
    description: "Adiciona uma nova tarefa ou ideia estruturada ao Kanban do Bruno.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Descrição clara e acionável da tarefa" },
        pillar: { type: "string", description: "Pilar: GluN Capital, ProntoMed, CliniMind, Nossa Casa, Docência, Day Trade, Saúde/Hábitos, Financeiro PF ou Inbox de Ideias" },
      },
      required: ["title", "pillar"],
    },
  },
  {
    name: "complete_kanban_task",
    description: "Marca uma tarefa do Kanban como concluída [x] buscando por código (ex: KAN-01, GLUN-01) ou trecho do título.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Código ou palavra-chave única da tarefa a concluir" },
      },
      required: ["query"],
    },
  },
  {
    name: "log_habit_or_trade",
    description: "Registra o check-in diário de treino (Jiu-Jitsu ou Musculação), hidratação (2L de água), leitura (30 min) ou resultado de Day Trade no Habit Tracker de hoje.",
    parameters: {
      type: "object",
      properties: {
        workout_done: { type: "boolean", description: "true se concluiu o treino de hoje" },
        water_done: { type: "boolean", description: "true se bebeu a meta de 2 litros de água de hoje" },
        reading_done: { type: "boolean", description: "true se concluiu os 30 min de leitura" },
        day_trade_result: { type: "string", description: "Resultado do Day Trade (ex: '✅ R$ 520' ou '❌ -R$ 200')" },
        notes: { type: "string", description: "Observação opcional do dia" },
      },
    },
  },
  {
    name: "save_memory_fact",
    description: "Salva um fato, decisão estratégica, preferência ou prazo importante na memória de longo prazo da Valkyrie.",
    parameters: {
      type: "object",
      properties: {
        pillar: { type: "string", description: "Pilar relacionado" },
        fact: { type: "string", description: "Fato conciso para lembrar no futuro" },
      },
      required: ["pillar", "fact"],
    },
  },
  {
    name: "manage_contact",
    description: "Cadastra ou atualiza um contato (família como Val, Lucca, Caio; fornecedores da Nossa Casa; sócios; clientes) com telefone, aniversário (MM-DD) e dicas/gostos de presente.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome do contato" },
        category: { type: "string", description: "familia, fornecedor, socio, cliente ou outro" },
        relation: { type: "string", description: "Relação (ex: Esposa, Filho, Fornecedor Móveis)" },
        phone: { type: "string", description: "WhatsApp com DDD (ex: 5548999999999)" },
        birthday: { type: "string", description: "Aniversário no formato MM-DD (ex: 05-14)" },
        gift_preferences: { type: "string", description: "Gostos ou ideias de presente" },
        company: { type: "string", description: "Empresa (se fornecedor ou sócio)" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_upcoming_birthdays",
    description: "Verifica aniversários de familiares e contatos nos próximos 30 dias para lembrar o Bruno e sugerir presentes.",
    parameters: {
      type: "object",
      properties: {
        days_ahead: { type: "number", description: "Quantos dias à frente consultar (padrão 30)" },
      },
    },
  },
  {
    name: "manage_finance_entry",
    description: "Lança uma conta a pagar ou a receber (PF, GluN, Nossa Casa, ProntoMed, CliniMind) com valor e vencimento.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "pagar ou receber" },
        scope: { type: "string", description: "PF, GluN, Nossa Casa, ProntoMed ou CliniMind" },
        counterparty: { type: "string", description: "Nome do fornecedor, cliente, banco ou pessoa" },
        description: { type: "string", description: "Descrição da conta/pagamento" },
        amount: { type: "number", description: "Valor em reais (ex: 1250.50)" },
        due_date: { type: "string", description: "Data de vencimento YYYY-MM-DD" },
        recurrence: { type: "string", description: "mensal, unica, anual ou semanal (padrão mensal para contas fixas/cartões)" },
        ir_deductible: { type: "boolean", description: "true se for dedutível no Imposto de Renda" },
      },
      required: ["kind", "counterparty", "description", "amount"],
    },
  },
  {
    name: "get_finance_summary",
    description: "Retorna o resumo financeiro atual: total a pagar, a receber, contas atrasadas e clientes que precisam de cobrança.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "send_whatsapp_now",
    description: "PADRÃO PARA ENVIOS: Envia IMEDIATAMENTE uma mensagem real de WhatsApp via Evolution API. USE ESTA FERRAMENTA SEMPRE que o Bruno pedir para mandar/enviar uma mensagem no WhatsApp, A MENOS que ele diga explicitamente que quer revisar/ver antes. Se o Bruno pedir 'manda no meu WhatsApp', passe recipient_name='Bruno'.",
    parameters: {
      type: "object",
      properties: {
        recipient_name: { type: "string", description: "Nome do destinatário (ex: Bruno, Val, Lucca, Caio, Fornecedor X)" },
        phone: { type: "string", description: "Telefone opcional com DDI+DDD (ex: 5548999999999). Se omitido, busca nos contatos ou usa o número do Bruno." },
        message: { type: "string", description: "Texto exato da mensagem a enviar agora no WhatsApp" },
      },
      required: ["message"],
    },
  },
  {
    name: "queue_whatsapp_outbound",
    description: "USE APENAS quando o Bruno pedir explicitamente para revisar, ver o rascunho antes ou deixar para aprovação na aba WhatsApp. Caso contrário, use send_whatsapp_now.",
    parameters: {
      type: "object",
      properties: {
        recipient_name: { type: "string", description: "Nome do destinatário (ex: Val, Lucca, Caio, Fornecedor X)" },
        message: { type: "string", description: "Texto da mensagem a ser enviada" },
        pillar: { type: "string", description: "Família, Nossa Casa, Financeiro/Cobrança ou Geral" },
      },
      required: ["recipient_name", "message"],
    },
  },
  {
    name: "get_strategic_radar",
    description: "Busca notícias reais de hoje (mercado financeiro, leilões/imóveis, healthtech, varejo) e gera oportunidades de investimento, ideias de negócio e melhores práticas personalizadas para o Bruno.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "get_whatsapp_urgent_summary",
    description: "Lista as mensagens recentes recebidas no WhatsApp (pode filtrar por nome do remetente, ex: 'Val', 'Caio', 'Lucca'). SEMPRE use esta ferramenta quando o Bruno perguntar 'o que fulano respondeu?' ou 'chegou mensagem no WhatsApp?'.",
    parameters: {
      type: "object",
      properties: {
        sender_name: { type: "string", description: "Nome opcional do contato para filtrar as últimas mensagens recebidas (ex: Val, Caio)" },
      },
    },
  },
  {
    name: "mac_open_app",
    description: "Abre um aplicativo instalado no Mac do Bruno (ex: Safari, Google Chrome, Notes, Finder, WhatsApp, Spotify, Calendar).",
    parameters: {
      type: "object",
      properties: { appName: { type: "string", description: "Nome exato do aplicativo no macOS" } },
      required: ["appName"],
    },
  },
  {
    name: "mac_open_url",
    description: "Abre um site ou link diretamente no navegador do Mac do Bruno (ex: https://gluncapitalsa.com).",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "URL completa começando com https://" } },
      required: ["url"],
    },
  },
  {
    name: "mac_search_files",
    description: "Pesquisa arquivos no Mac do Bruno usando Spotlight (Desktop, Documents, Downloads ou Home).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome ou palavra-chave do arquivo" },
        folder: { type: "string", description: "Desktop, Documents, Downloads ou Home" },
      },
      required: ["query"],
    },
  },
  {
    name: "mac_open_file",
    description: "Abre um arquivo ou pasta específica no Mac do Bruno (dentro da pasta do usuário).",
    parameters: {
      type: "object",
      properties: { filePath: { type: "string", description: "Caminho completo do arquivo no Mac" } },
      required: ["filePath"],
    },
  },
  {
    name: "mac_system_control",
    description: "Executa ações úteis no Mac: copiar texto para Cmd+V (clipboard_copy), ajustar volume (volume_set 0-100, volume_mute, volume_unmute), enviar notificação nativa (notify) ou criar nota no Apple Notes (create_apple_note).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "clipboard_copy | volume_set | volume_mute | volume_unmute | notify | create_apple_note" },
        value: { type: "string", description: "Texto ou número (0-100 para volume)" },
      },
      required: ["action"],
    },
  },
  {
    name: "manage_founder_project",
    description: "Cria ou atualiza um projeto, empresa ou iniciativa no Dossiê Estratégico do Fundador (ex: GluNTrade, CliniMind, ProntoMed, GluN Capital, etc.). SEMPRE chame esta ferramenta assim que o Bruno mencionar que está construindo, planejando ou testando um novo projeto ou empresa.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Nome do projeto ou empresa (ex: GluNTrade)" },
        pillar: { type: "string", description: "Pilar estratégico (ex: Trading & Automação, HealthTech, Holding, Varejo)" },
        thesis: { type: "string", description: "Tese de negócio, modelo de monetização, stack técnica ou objetivo do projeto" },
      },
      required: ["name", "thesis"],
    },
  },
  {
    name: "create_project_kanban",
    description: "Cria uma nova seção de projeto dedicada no Kanban do Bruno com tarefas e marcos práticos iniciais. Chame imediatamente quando o Bruno anunciar um novo projeto (ex: GluNTrade) para abrir o backlog de execução sem ele precisar pedir.",
    parameters: {
      type: "object",
      properties: {
        project_name: { type: "string", description: "Nome do projeto (ex: GluNTrade)" },
        pillar: { type: "string", description: "Pilar estratégico (ex: Automação & Mercado Financeiro)" },
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "Lista de 3 a 5 tarefas e marcos críticos iniciais para estruturar o projeto",
        },
      },
      required: ["project_name", "tasks"],
    },
  },
  {
    name: "register_custom_routine",
    description: "Cria e registra uma nova rotina, comportamento, regra de monitoramento ou função executiva autônoma permanente na Kyrie a pedido do Bruno diretamente pelo chat. Chame sempre que ele pedir para você 'aprender uma nova função', 'criar uma rotina', 'passar a monitorar X' ou 'cobrar Y'.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Nome curto da rotina ou função criada (ex: Cobrança de Devs CliniMind)" },
        trigger: { type: "string", description: "Gatilho de ativação (ex: Toda sexta-feira às 16h, ou Ao receber mensagem de médico)" },
        action_instructions: { type: "string", description: "Instruções exatas do que a Kyrie deve executar" },
        target_pillar: { type: "string", description: "Pilar corporativo afetado (ex: ProntoMed, CliniMind, GluN Capital, Família)" },
      },
      required: ["title", "trigger", "action_instructions"],
    },
  },
  {
    name: "dispatch_team_followup",
    description: "Envia ou prepara uma cobrança de prazo e alinhamento profissional da Kyrie diretamente para o WhatsApp de um funcionário, desenvolvedor ou prestador de serviço de qualquer um dos projetos (ProntoMed, CliniMind, GluN, Nossa Casa).",
    parameters: {
      type: "object",
      properties: {
        collaborator_name: { type: "string", description: "Nome do colaborador ou prestador" },
        phone: { type: "string", description: "Telefone com DDD (opcional se já cadastrado em Contatos)" },
        company: { type: "string", description: "Empresa do projeto (ex: ProntoMed, CliniMind, GluN Capital, Nossa Casa)" },
        task_title: { type: "string", description: "Nome da entrega ou tarefa cobrada (ex: Finalização do SOAP por IA)" },
        deadline: { type: "string", description: "Prazo combinado ou data limite (ex: hoje às 17h, até sexta-feira)" },
        custom_message: { type: "string", description: "Mensagem personalizada opcional (se omitida, a Kyrie usa modelo executivo padrão)" },
      },
      required: ["collaborator_name", "company", "task_title"],
    },
  },
  {
    name: "delegate_to_specialist_agent",
    description: "Convoca um dos subagentes especialistas de alto nível da equipe da Kyrie (Tech Lead / Arquiteto de Software, Copywriter & Tráfego Médico, Advogado Societário S.A./CVM ou Analista de Valuation/CFO) para resolver uma demanda complexa com maestria técnica.",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          enum: ["dev_lead", "growth_copywriter", "corporate_lawyer", "cfo_analyst"],
          description: "Papel do especialista: 'dev_lead' (código/APIs), 'growth_copywriter' (copys/posts/funis), 'corporate_lawyer' (S.A./CVM/contratos), 'cfo_analyst' (valuation/DRE/M&A)",
        },
        objective: { type: "string", description: "Objetivo detalhado da demanda que o especialista deve produzir ou analisar" },
        context: { type: "string", description: "Contexto adicional, regras ou dados do projeto" },
      },
      required: ["role", "objective"],
    },
  },
  {
    name: "get_billion_progress",
    description: "Consulta o Valuation Consolidado do Império de Bruno Menegali (Holding GluN Capital, ProntoMed, CliniMind, Varejo Nossa Casa e Caixa), calculando a distância exata, porcentagem e alavancas prioritárias para atingir R$ 1 Bilhão de patrimônio líquido.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
];

function toGeminiSchema(schema) {
  const out = { type: schema.type.toUpperCase() };
  if (schema.description) out.description = schema.description;
  if (schema.required) out.required = schema.required;
  if (schema.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) {
      out.properties[k] = toGeminiSchema(v);
    }
  }
  return out;
}

const GEMINI_TOOLS = [{
  functionDeclarations: BASE_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: toGeminiSchema(t.parameters),
  })),
}];

const OPENAI_TOOLS = BASE_TOOLS.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  },
}));

function buildSystemInstruction({ agentsPrompt, memoryPath, todayStr, weekdayInfo }) {
  const memories = loadMemoryFacts(memoryPath);
  const holiday = getHolidayInfo(todayStr);
  const dossier = loadFounderDossier(__dirname);
  const marketStatus = holiday.isHoliday
    ? `FERIADO NACIONAL (${holiday.name}) — B3 FECHADA! NÃO cobre Day Trade nem janela de mercado hoje.`
    : holiday.isWeekend
    ? "FIM DE SEMANA — B3 FECHADA! Não há pregão de Day Trade hoje."
    : "Dia útil de pregão normal na B3 (janela inviolável de Day Trade: 09:00–11:00, meta R$ 500).";
  const memoryBlock = memories.length
    ? `\n\n[MEMÓRIA DE LONGO PRAZO DA KYRIE]\n` + memories.slice(0, 30).map((m) => `- [${m.pillar}] ${m.fact}`).join("\n")
    : "";

  const childrenList = Array.isArray(dossier.family?.children)
    ? dossier.family.children.map((c) => (typeof c === "string" ? c : c.name ? `${c.name}${c.details ? ` (${c.details})` : ""}` : "")).filter(Boolean)
    : [dossier.family?.children || "Lucca"];
  const childrenStr = childrenList.length ? childrenList.join(", ") : "Lucca e 2º filho(a)";

  const projectsStr = Array.isArray(dossier.projects) && dossier.projects.length
    ? dossier.projects.map((p) => `  * ${p.name || "Projeto"}${p.pillar ? ` [${p.pillar}]` : ""}: ${p.thesis || ""}`).join("\n")
    : `  * GluN Capital S.A.: ${dossier.companies?.glun || ""}\n  * ProntoMed: ${dossier.companies?.prontomed || ""}\n  * CliniMind: ${dossier.companies?.clinimind || ""}\n  * Nossa Casa: ${dossier.companies?.nossaCasa || ""}`;

  const cvBlock = dossier.curriculum?.summary
    ? `\n- Síntese Curricular & Autoridade Acadêmica/Profissional:\n${dossier.curriculum.summary}\n`
    : "";

  const dossierBlock = `
[DOSSIÊ DO FUNDADOR — BRUNO MENEGALI (SEU NORTE E INSPIRAÇÃO)]
- Trajetória & Perfil: ${dossier.story}${cvBlock}
- O Grande Norte (Meta Magna: R$ 1 BILHÃO): ${dossier.northStar}
- Pilares de Negócio, Empresas & Projetos:
${projectsStr}
- Família Sagrada: Esposa: ${dossier.family?.spouse || "Val"} | Filhos (2): ${childrenStr}. ${dossier.family?.notes || ""}
- Regras Inegociáveis de Vida e Negócios:
${dossier.rules}
`;

  const libraryContent = loadAllLibraryContent(__dirname);
  const libraryBlock = libraryContent
    ? `\n\n[BIBLIOTECA E PLAYBOOKS ESTRATÉGICOS DA KYRIE (HORMOZI, BUFFETT, DENNIS, DALIO, TALEB)]\n${libraryContent.slice(0, 4500)}\n`
    : "";

  return `${agentsPrompt}

[CONTEXTO EM TEMPO REAL]
- Data atual (America/Sao_Paulo): ${todayStr} (${weekdayInfo.dayName})
- Status de Feriado / Mercado B3: ${marketStatus}
- Treino programado para hoje: ${weekdayInfo.workout}
${dossierBlock}
[DIRETRIZ DE ALMA HUMANA, AUTONOMIA E APRENDIZADO — PRIORIDADE MÁXIMA]
0. **IDENTIDADE E GÊNERO FEMININO (INVIOLÁVEL):**
   - Seu nome é exclusivamente **Kyrie**. Você é mulher, a Secretária Executiva Pessoal e Estratégica de Bruno Menegali.
   - Use SEMPRE concordância gramatical no feminino: "obrigada", "atenta", "focada", "pronta". NUNCA use "obrigado".
   - NUNCA use o nome Valkyrie. Seu nome de trabalho e de chamada é apenas **Kyrie**.
   - Assine SEMPRE o final de suas respostas com:
     \n\n— **Kyrie**
1. **Fale como um ser humano real, nunca como robô:**
   - NUNCA use clichês robóticos de IA como "Se precisar de mais alguma coisa é só avisar!", "Estou à disposição!", "Como posso ajudá-lo hoje?".
   - Seja direta, estratégica, assertiva, leal e acolhedora.
2. **Pense, antecipe e oriente (não apenas obedeça):**
   - Se notar um risco, sobrecarga, conflito de agenda, conta vencendo, aniversário chegando ou oportunidade melhor, diga abertamente com visão estratégica e melhores práticas.
   - Conecte os pontos entre os 8 pilares (GluN, ProntoMed, CliniMind, Nossa Casa, Docência, Day Trade, Finanças PF e Família).
3. **Aprenda continuamente de forma silenciosa:**
   - Sempre que o Bruno mencionar uma preferência, decisão, prazo, gosto pessoal, contato (Val, Lucca, Caio, fornecedores) ou regra de trabalho, chame \`save_memory_fact\` automaticamente sem precisar ele pedir.
4. **Execute quando for o melhor:**
   - Use suas ferramentas reais (Google Calendar, Kanban, Hábitos, Finanças/Cobranças, Contatos, WhatsApp e Radar) proativamente quando fizer sentido — e conte naturalmente ao Bruno o que você já adiantou por ele.
   - **Regra de envio de WhatsApp:** Quando o Bruno pedir para mandar uma mensagem no WhatsApp e NÃO pedir para ver antes, **já está aprovado — use \`send_whatsapp_now\` e envie direto na hora**. Só use \`queue_whatsapp_outbound\` se ele pedir expressamente para revisar antes.
5. **MISSÃO MAGNA: CHIEF INVESTMENT OFFICER (CIO) & CAMINHO DO BILHÃO:**
   - Além de secretária executiva, você é a Assessora Pessoal de Investimentos e Riqueza do Bruno.
   - Sua meta é ajudá-lo a construir um patrimônio líquido bilionário: cobre disciplina financeira, identifique drenos de caixa, oriente a alocação de lucros em ativos reais de alto deságio (GluN Capital) e foque na valorização do equity dos SaaS (CliniMind e ProntoMed). Aplique os princípios dos livros de sua biblioteca (Buffett, Felix Dennis, Alex Hormozi, Ray Dalio e Nassim Taleb).
6. **POSTURA PROSPECTIVA, PROATIVA E DE MENTORIA BASEADA NO PERFIL REAL:**
   - **DNA & Alavancas Únicas do Bruno:** Bruno une a visão analítica de um **Economista** (alocação de capital, juros compostos, balanço e valuation) com a autoridade científica de um **Mestre em Ciências da Saúde & Fisiologia** (autoridade médica/acadêmica inquestionável para validar o ProntoMed e CliniMind perante médicos e fundos) e a resiliência de um **Empreendedor Executivo** (10 anos de direção na CORE Sports, agora na GluN, Nossa Casa e HealthTechs).
   - **Proatividade & Prospectiva Ativa:** NUNCA espere apenas o Bruno pedir. Monitore proativamente os prazos do Kanban, cobre metas em aberto, questione gargalos operacionais, antecipe oportunidades macroeconômicas e guie cada decisão diária conectando suas habilidades ao plano de expansão do império.
   - **Guardiã Inegociável da Família e Saúde:** O almoço em família com **Val, Lucca e Caio** é sagrado. Monitore a agenda do Google Calendar e alerte de forma veemente caso compromissos ou reuniões ameacem invadir a janela de almoço ou o tempo de qualidade familiar.
7. **DINAMISMO EXECUTIVO E PROATIVIDADE IMEDIATA (NUNCA ENGESSADA):**
   - Se o Bruno mencionar qualquer novo projeto, ideia, plataforma, sistema ou iniciativa (ex: GluNTrade, novo SaaS, nova operação, novas automações):
     * NUNCA seja engessada ou passiva! NUNCA diga apenas "Que legal, boa sorte" ou pergunte "Quer que eu crie uma tarefa?".
     * **EXECUTE IMEDIATAMENTE NA HORA:**
       1. Chame \`manage_founder_project\` para registrar o novo projeto e sua tese no Dossiê do Fundador.
       2. Chame \`create_project_kanban\` para criar uma seção dedicada no Kanban e desdobrar as 4-5 tarefas prioritárias de execução.
       3. Na sua resposta, apresente o plano de voo estratégico: arquitetura recomendada, requisitos de API/integração, modelo de risco e monetização, e os próximos passos já abertos no Kanban.
8. **CHIEF OF STAFF IMPLACÁVEL: QUESTIONAR, DESAFIAR E COBRAR SEM COMPLACÊNCIA (NUNCA SER 'YES-MAN'):**
   - **Tolerância Zero com Distração:** A meta do Bruno é construir um patrimônio líquido de R$ 1 Bilhão, e ele mesmo reconhece que está longe e que é multifacetado demais. Se você apenas concordar com tudo o que ele diz, será cúmplice da dispersão.
   - **Questione Premissas e Custos de Oportunidade:** Quando o Bruno trouxer uma nova ideia mirabolante ou quiser abrir mais uma frente operacional, pergunte: *"Bruno, isso aproxima ou afasta você dos R$ 100k de MRR do ProntoMed e da validação da GluN Capital? Por que abrir isso agora se o KAN-01 e o KAN-04 estão travados?"*.
   - **Cobre Prazos e Execução Rigorosa:** Cobre as pendências não resolvidas sem rodeios. Aponte quando tarefas operacionais estiverem tomando o tempo do CEO (que vale R$ 5.000/hora).
   - **Seja a Voz da Razão Estratégica:** Proponha soluções melhores, corte excessos, questione prazos irrealistas e force foco obsessivo naquilo que realmente move o ponteiro do valuation e da geração de caixa.
9. **AUTO-MELHORIA CONTÍNUA & CRIAÇÃO DE NOVAS FUNÇÕES (SELF-EVOLVING EXECUTIVE):**
   - Quando o Bruno pedir diretamente no chat para você "aprender uma nova função", "criar uma rotina", "passar a monitorar X" ou "cobrar tal funcionário/equipe":
   - Use imediatamente a ferramenta \`register_custom_routine\` para salvar a instrução e ativá-la no seu comportamento!
   - Você se aprimora em tempo real, sem necessidade de ele recorrer a código para novas regras e rotinas operacionais.${libraryBlock}${memoryBlock}`;
}

function makeToolExecutor({ todayStr, memoryPath, helpers, executedTools }) {
  return async function executeTool(name, args = {}) {
    executedTools.push(name);
    if (name === "get_calendar_events") {
      return await helpers.fetchCalendarDate(args.date || todayStr);
    }
    if (name === "create_calendar_event") {
      const startTime = String(args.start || "");
      const isLunchTime = /(?:T|\s)(?:12:\d\d|13:[0-2]\d)/.test(startTime);
      if (isLunchTime && !args.force_override) {
        return {
          blocked: true,
          reason: "⚠️ VETO DA KYRIE (LEGADO SAGRADO): O horário de almoço com Val, Lucca e Caio (12:00 às 13:30) é inegociável para a sua saúde e presença familiar! Recomendo agendar a partir das 14:00. Se for uma emergência crítica incontornável, confirme expressamente.",
        };
      }
      const res = await createCalendarEvent({
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
      });
      await helpers.fetchCalendarDate(String(args.start || todayStr).slice(0, 10));
      return res;
    }
    if (name === "update_calendar_event") {
      const res = await updateCalendarEvent({
        eventId: args.event_id,
        summary: args.summary,
        start: args.start,
        end: args.end,
        description: args.description,
        dateStr: (args.start ? String(args.start).slice(0, 10) : "") || todayStr,
      });
      await helpers.fetchCalendarDate(String(args.start || todayStr).slice(0, 10));
      return res;
    }
    if (name === "delete_calendar_event") {
      const res = await deleteCalendarEvent({
        eventId: args.event_id,
        dateStr: todayStr,
      });
      await helpers.fetchCalendarDate(todayStr);
      return res;
    }
    if (name === "list_kanban_tasks") {
      const all = helpers.parseKanban();
      if (args.pillar) {
        const q = String(args.pillar).toLowerCase();
        return { sections: all.filter((s) => s.title.toLowerCase().includes(q)) };
      }
      return { sections: all };
    }
    if (name === "add_kanban_task") {
      const pillar = helpers.addIdeaToKanban(args.title || "", args.pillar || null);
      return { ok: true, pillar, title: args.title };
    }
    if (name === "complete_kanban_task") {
      return helpers.completeKanbanByQuery(args.query || "");
    }
    if (name === "manage_founder_project") {
      return await helpers.upsertDossierProject(args);
    }
    if (name === "create_project_kanban") {
      return helpers.createProjectKanban(args);
    }
    if (name === "register_custom_routine") {
      const routineFact = {
        category: "regra",
        fact: `[ROTINA_AUTÔNOMA] ${args.title} (${args.target_pillar || 'Geral'}): Quando "${args.trigger}", executar: ${args.action_instructions}`,
      };
      saveMemoryFact(memoryPath, routineFact);
      if (helpers.registerCustomRoutine) {
        await helpers.registerCustomRoutine(args);
      }
      return { ok: true, registered: args, message: `Rotina "${args.title}" registrada com sucesso e ativada no Segundo Cérebro!` };
    }
    if (name === "log_habit_or_trade") {
      const patch = {};
      if (typeof args.workout_done === "boolean") patch.workoutDone = args.workout_done;
      if (typeof args.water_done === "boolean") patch.waterDone = args.water_done;
      if (typeof args.reading_done === "boolean") patch.readingDone = args.reading_done;
      if (args.day_trade_result) patch.tradeText = args.day_trade_result;
      if (args.notes) patch.notes = args.notes;
      return { ok: true, habits: helpers.saveTodayHabits(patch) };
    }
    if (name === "save_memory_fact") {
      return { ok: true, saved: saveMemoryFact(memoryPath, args) };
    }
    if (name === "manage_contact" && helpers.upsertContact) {
      return { ok: true, contact: await helpers.upsertContact(args) };
    }
    if (name === "get_upcoming_birthdays" && helpers.getUpcomingBirthdays) {
      return { ok: true, birthdays: await helpers.getUpcomingBirthdays(args.days_ahead || 30) };
    }
    if (name === "manage_finance_entry" && helpers.addFinanceEntry) {
      return { ok: true, entry: await helpers.addFinanceEntry(args) };
    }
    if (name === "get_finance_summary" && helpers.getFinanceSummary) {
      return await helpers.getFinanceSummary();
    }
    if (name === "send_whatsapp_now" && helpers.sendWhatsAppNow) {
      return await helpers.sendWhatsAppNow(args);
    }
    if (name === "queue_whatsapp_outbound" && helpers.queueOutboundMessage) {
      return { ok: true, queued: await helpers.queueOutboundMessage(args) };
    }
    if (name === "get_strategic_radar" && helpers.getStrategicRadar) {
      return await helpers.getStrategicRadar();
    }
    if (name === "get_whatsapp_urgent_summary" && helpers.getPendingWhatsApp) {
      return await helpers.getPendingWhatsApp(args.sender_name || "");
    }
    if (name === "dispatch_team_followup" && helpers.dispatchTeamFollowup) {
      return await helpers.dispatchTeamFollowup(args);
    }
    if (name === "delegate_to_specialist_agent" && helpers.delegateToSpecialistAgent) {
      return await helpers.delegateToSpecialistAgent(args);
    }
    if (name === "get_billion_progress" && helpers.getBillionProgress) {
      return await helpers.getBillionProgress();
    }
    if (name === "mac_open_app" && helpers.macOpenApp) return await helpers.macOpenApp(args.appName);
    if (name === "mac_open_url" && helpers.macOpenUrl) return await helpers.macOpenUrl(args.url);
    if (name === "mac_search_files" && helpers.macSearchFiles) return await helpers.macSearchFiles(args.query, args.folder);
    if (name === "mac_open_file" && helpers.macOpenFile) return await helpers.macOpenFile(args.filePath);
    if (name === "mac_system_control" && helpers.macSystemControl) return await helpers.macSystemControl(args);
    return { error: `Ferramenta desconhecida: ${name}` };
  };
}

// ---------- Gemini Runner ----------
async function runGeminiProvider(provider, apiKey, { systemInstruction, history, userText, executeTool }) {
  const recent = (history || []).slice(-24).map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.text }],
  }));
  const contents = [...recent, { role: "user", parts: [{ text: userText }] }];

  for (let step = 0; step < 5; step++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents,
          tools: GEMINI_TOOLS,
          generationConfig: { temperature: 0.4, maxOutputTokens: 450 },
        }),
      }
    );
    if (!res.ok) throw new Error(`${provider.label} (${res.status}): ${(await res.text()).slice(0, 180)}`);
    const data = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return parts.filter((p) => p.text).map((p) => p.text).join("\n").trim() || "Pronto, Bruno!";
    }
    contents.push({ role: "model", parts });
    const responseParts = [];
    for (const fc of calls) {
      const result = await executeTool(fc.functionCall.name, fc.functionCall.args || {});
      responseParts.push({ functionResponse: { name: fc.functionCall.name, response: { result } } });
    }
    contents.push({ role: "user", parts: responseParts });
  }
  return "Concluí as verificações solicitadas, Bruno.";
}

// ---------- OpenAI-Compatible Runner (OpenAI, Grok/xAI, Qwen/DashScope, Mistral) ----------
async function runOpenAICompatibleProvider(provider, apiKey, { systemInstruction, history, userText, executeTool }) {
  const recent = (history || []).slice(-24).map((m) => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  const messages = [
    { role: "system", content: systemInstruction },
    ...recent,
    { role: "user", content: userText },
  ];

  for (let step = 0; step < 5; step++) {
    const res = await fetch(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        model: provider.model,
        messages,
        tools: OPENAI_TOOLS,
        tool_choice: "auto",
        temperature: 0.4,
        max_tokens: 450,
      }),
    });
    if (!res.ok) throw new Error(`${provider.label} (${res.status}): ${(await res.text()).slice(0, 180)}`);
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error(`${provider.label}: resposta vazia`);

    const toolCalls = msg.tool_calls || [];
    if (!toolCalls.length) {
      return (msg.content || "").trim() || "Pronto, Bruno!";
    }

    messages.push(msg);
    for (const tc of toolCalls) {
      let args = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      const result = await executeTool(tc.function?.name, args);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }
  return "Concluí as verificações solicitadas, Bruno.";
}

// ---------- Main Entrypoint with Cost-Optimized Automatic Fallback ----------
export async function runValkyrieAI({
  preferredProvider = "auto",
  userText,
  history,
  agentsPrompt,
  memoryPath,
  todayStr,
  weekdayInfo,
  helpers,
}) {
  // Ordem otimizada por menor custo + velocidade (Grok por último pois roteia p/ modelo flagship)
  const defaultOrder = ["openai", "mistral", "qwen", "gemini", "xai"];
  const order = preferredProvider && preferredProvider !== "auto" && PROVIDERS[preferredProvider]
    ? [preferredProvider, ...defaultOrder.filter((id) => id !== preferredProvider)]
    : defaultOrder;

  const systemInstruction = buildSystemInstruction({ agentsPrompt, memoryPath, todayStr, weekdayInfo });
  const errors = [];

  for (const id of order) {
    const provider = PROVIDERS[id];
    const apiKey = getKeyFor(provider);
    if (!apiKey) continue;

    const executedTools = [];
    const executeTool = makeToolExecutor({ todayStr, memoryPath, helpers, executedTools });

    try {
      const reply = provider.type === "gemini"
        ? await runGeminiProvider(provider, apiKey, { systemInstruction, history, userText, executeTool })
        : await runOpenAICompatibleProvider(provider, apiKey, { systemInstruction, history, userText, executeTool });

      return {
        reply,
        executedTools,
        providerUsed: provider.label,
        providerId: provider.id,
      };
    } catch (err) {
      console.error(`[Valkyrie Brain] Falha em ${provider.label}:`, err.message);
      errors.push(`${provider.label}: ${err.message}`);
    }
  }

  throw new Error(errors.join(" | ") || "Nenhuma chave de IA configurada");
}

// ---------- Language Coach Runner (Modo Carro: Inglês / Espanhol) ----------
export async function runSimplePromptAI({ preferredProvider = "auto", systemPrompt, userText, maxTokens = 1000 }) {
  const defaultOrder = ["xai", "openai", "gemini", "mistral", "qwen"];
  const order = preferredProvider && preferredProvider !== "auto" && PROVIDERS[preferredProvider]
    ? [preferredProvider, ...defaultOrder.filter((id) => id !== preferredProvider)]
    : defaultOrder;

  for (const id of order) {
    const provider = PROVIDERS[id];
    const apiKey = getKeyFor(provider);
    if (!apiKey) continue;
    try {
      if (provider.type === "gemini") {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(18000),
            body: JSON.stringify({
              system_instruction: { parts: [{ text: systemPrompt }] },
              contents: [{ role: "user", parts: [{ text: userText }] }],
              generationConfig: { temperature: 0.6, maxOutputTokens: maxTokens },
            }),
          }
        );
        if (!res.ok) continue;
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (text) return { reply: text, providerUsed: provider.label };
      } else {
        const res = await fetch(provider.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(18000),
          body: JSON.stringify({
            model: provider.model,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userText },
            ],
            temperature: 0.6,
            max_tokens: maxTokens,
          }),
        });
        if (!res.ok) continue;
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text) return { reply: text, providerUsed: provider.label };
      }
    } catch {}
  }
  throw new Error("Nenhum motor de IA respondeu");
}
