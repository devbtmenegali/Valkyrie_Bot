/**
 * Dossiê do Fundador — A História, O Norte e as Regras Inegociáveis de Bruno Menegali
 * Sincronizado localmente e no Supabase KV para persistência total em todas as plataformas.
 */
import fs from "node:fs";
import path from "node:path";
import { sbGetKV, sbSetKV } from "./db.mjs";

const DEFAULT_DOSSIER = {
  story: "Bruno Menegali é um empreendedor incansável, cirúrgico e focado em resultados de alto impacto. Atua na interseção entre tecnologia em saúde, mercado financeiro, operações imobiliárias em leilão e varejo. Constrói empresas com base sólida e visão de longo prazo.",
  northStar: "Construção de um patrimônio líquido de R$ 1 BILHÃO. Multiplicação do valuation dos SaaS de Saúde (CliniMind e ProntoMed) para múltiplos de 10x-15x ARR, expansão da holding GluN Capital S.A. através de arbitragem de ativos reais com deságio e criação de um legado perpétuo para sua família.",
  projects: [
    {
      id: "proj-glun",
      name: "GluN Capital S.A.",
      pillar: "Holding & Imobiliário",
      thesis: "Sociedade Anônima Fechada constituída sob a Lei nº 6.404/76. Holding inspirada no modelo Berkshire Hathaway para aquisição de imóveis em leilões judiciais/Caixa com 40-50% de deságio, originação de M&A e blindagem patrimonial."
    },
    {
      id: "proj-prontomed",
      name: "ProntoMed",
      pillar: "HealthTech SaaS",
      thesis: "SaaS de Saúde de última geração com auto-preenchimento SOAP por IA, prontuário inteligente e Secretária IA via WhatsApp para clínicas médicas e Telemedicina."
    },
    {
      id: "proj-clinimind",
      name: "CliniMind",
      pillar: "Saúde Mental & IA Clínica",
      thesis: "Plataforma de gestão de saúde mental, IA para estudos e apoio clínico aos estudantes de medicina e médicos."
    },
    {
      id: "proj-nossacasa",
      name: "Nossa Casa",
      pillar: "Varejo & Cash Cow",
      thesis: "Loja física de varejo. Atua como Cash Cow (geradora de fluxo de caixa limpo e previsível) para alimentar aportes sem endividamento bancário."
    }
  ],
  companies: {
    glun: "Sociedade Anônima Fechada constituída sob a Lei nº 6.404/76. Holding inspirada no modelo Berkshire Hathaway para aquisição de imóveis em leilões judiciais/Caixa com 40-50% de deságio, originação de M&A e blindagem patrimonial.",
    prontomed: "SaaS de Saúde de última geração com auto-preenchimento SOAP por IA, prontuário inteligente e Secretária IA via WhatsApp para clínicas médicas e Telemedicina.",
    clinimind: "Plataforma de IA para Estudos e Apoio Clínico aos Estudantes de Medicina e Médicos.",
    nossaCasa: "Loja física de varejo. Atua como Cash Cow (geradora de fluxo de caixa limpo e previsível) para alimentar aportes sem endividamento bancário."
  },
  family: {
    spouse: "Val",
    children: [
      { id: "child-1", name: "Lucca", details: "Filho" },
      { id: "child-2", name: "", details: "Filho(a)" }
    ],
    notes: "A família é o alicerce sagrado e inegociável. Cada decisão de segurança patrimonial visa garantir a tranquilidade e o futuro de Val e dos 2 filhos."
  },
  rules: "1. Disciplina e consistência superam a motivação passageira.\n2. Nunca tomar dívida cara ou rolar cartão de crédito — juros compostos trabalham a nosso favor, não contra.\n3. Equity é a única fonte de bilhão — manter controle e não vender ações barato.\n4. Na B3: disciplina cega de stop e meta diária de R$ 500,00 na janela 09:00–11:00 em dias de pregão.",
  personalitySettings: {
    tone: "direto_estrategico", // direto_estrategico, acolhedor, conciso
    voiceSpeed: "1.0",
    preferredProvider: "auto",
    morningBriefingTime: "06:30",
    preMarketAlertTime: "08:45"
  },
  updatedAt: new Date().toISOString()
};

function localPath(appDir) {
  return path.join(appDir, "founder-dossier.json");
}

export function loadFounderDossier(appDir) {
  const p = localPath(appDir);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify(DEFAULT_DOSSIER, null, 2), "utf8");
    return DEFAULT_DOSSIER;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    const data = { ...DEFAULT_DOSSIER, ...raw };

    // Normaliza children para array
    if (!Array.isArray(data.family?.children)) {
      const singleName = typeof data.family?.children === "string" ? data.family.children : "Lucca";
      data.family = {
        ...(data.family || {}),
        children: [
          { id: "child-1", name: singleName || "Lucca", details: "Filho" },
          { id: "child-2", name: "", details: "Filho(a)" }
        ]
      };
    } else if (data.family.children.length === 1) {
      data.family.children.push({ id: "child-2", name: "", details: "Filho(a)" });
    }

    // Normaliza projects para array dinâmico
    if (!Array.isArray(data.projects) || !data.projects.length) {
      data.projects = [
        {
          id: "proj-glun",
          name: "GluN Capital S.A.",
          pillar: "Holding & Imobiliário",
          thesis: data.companies?.glun || DEFAULT_DOSSIER.projects[0].thesis
        },
        {
          id: "proj-prontomed",
          name: "ProntoMed",
          pillar: "HealthTech SaaS",
          thesis: data.companies?.prontomed || DEFAULT_DOSSIER.projects[1].thesis
        },
        {
          id: "proj-clinimind",
          name: "CliniMind",
          pillar: "Saúde Mental & IA Clínica",
          thesis: data.companies?.clinimind || DEFAULT_DOSSIER.projects[2].thesis
        },
        {
          id: "proj-nossacasa",
          name: "Nossa Casa",
          pillar: "Varejo & Cash Cow",
          thesis: data.companies?.nossaCasa || DEFAULT_DOSSIER.projects[3].thesis
        }
      ];
    }

    return data;
  } catch {
    return DEFAULT_DOSSIER;
  }
}

export async function saveFounderDossier(appDir, updates) {
  const current = loadFounderDossier(appDir);
  const updated = {
    ...current,
    ...updates,
    companies: { ...(current.companies || {}), ...(updates.companies || {}) },
    family: { ...(current.family || {}), ...(updates.family || {}) },
    projects: Array.isArray(updates.projects) ? updates.projects : current.projects,
    personalitySettings: { ...(current.personalitySettings || {}), ...(updates.personalitySettings || {}) },
    updatedAt: new Date().toISOString()
  };

  // Garante sincronização bidirecional entre projects e companies legadas
  if (Array.isArray(updated.projects)) {
    for (const p of updated.projects) {
      const lower = String(p.name || "").toLowerCase();
      if (lower.includes("glun")) updated.companies.glun = p.thesis;
      else if (lower.includes("prontomed")) updated.companies.prontomed = p.thesis;
      else if (lower.includes("clinimind")) updated.companies.clinimind = p.thesis;
      else if (lower.includes("nossa")) updated.companies.nossaCasa = p.thesis;
    }
  }

  fs.writeFileSync(localPath(appDir), JSON.stringify(updated, null, 2), "utf8");
  await sbSetKV("founder_dossier", updated).catch(() => {});
  return updated;
}

