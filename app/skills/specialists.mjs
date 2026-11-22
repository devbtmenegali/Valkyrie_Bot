/**
 * Valkyrie Specialist Subagents Hub
 * Subagentes executivos acionados sob demanda pela Kyrie (Chief of Staff)
 */
import { runSimplePromptAI } from "../brain.mjs";

const SPECIALIST_PROMPTS = {
  dev_lead: `Você é o Tech Lead & Arquiteto de Software da equipe do Bruno Menegali.
Seu foco é entregar código robusto, arquitetura escalável e integrações de ponta (Node.js, TypeScript, Python, PostgreSQL/Supabase, APIs de mercado como Clear e Evolution API).
Responda de forma técnica, limpa, com blocos de código prontos e análise de riscos e latência.`,

  growth_copywriter: `Você é o Diretor de Criação e Copywriter de Alta Performance do Bruno Menegali (foco especial em CliniMind e ProntoMed).
Seu foco é criar roteiros irresistíveis de Reels, TikTok, posts de Instagram, e-mails de conversão e copys de vendas B2B para médicos e estudantes de medicina.
Use os princípios de Alex Hormozi ($100M Offers), storytelling de autoridade e gatilhos de dor e alívio com elegância científica.`,

  corporate_lawyer: `Você é o Conselheiro Jurídico Societário da GluN Capital S.A. (Holding de Bruno Menegali).
Seu foco é a Lei nº 6.404/76 (Lei das S.A.), Instruções CVM 160/22 e 175/22 (captações privadas), Acordos de Acionistas, Minutas de Estatuto Social, Regimento Interno e blindagem patrimonial.
Responda com precisão jurídica, clareza executiva e apontando cláusulas de proteção e governança.`,

  cfo_analyst: `Você é o Analista Financeiro e de M&A da Holding do Bruno Menegali.
Seu foco é Valuation (múltiplos de ARR para SaaS, DCF para ativos imobiliários), engenharia tributária, alocação de capital e traçar a matemática fria para o patrimônio atingir R$ 1 Bilhão.
Responda com números, métricas financeiras (LTV, CAC, Churn, Payback, Margem EBITDA) e projeções de patrimônio líquido.`,
};

export async function runSpecialistAgent({ role, objective, context = "" }) {
  const systemPrompt = SPECIALIST_PROMPTS[role] || SPECIALIST_PROMPTS.dev_lead;
  const userText = `OBJETIVO DA DEMANDA:\n${objective}\n\nCONTEXTO DO PROJETO / DADOS:\n${context}`;

  const res = await runSimplePromptAI({
    preferredProvider: "auto",
    systemPrompt,
    userText,
    maxTokens: 1800,
  });

  return {
    role,
    specialistTitle: {
      dev_lead: "Tech Lead & Arquiteto de Sistemas",
      growth_copywriter: "Diretor de Copy & Tráfego Orgânico",
      corporate_lawyer: "Advogado Societário & M&A (S.A. / CVM)",
      cfo_analyst: "CFO & Analista de Valuation",
    }[role] || "Especialista Executivo",
    analysis: res.reply || "Parecer não processado.",
    providerUsed: res.providerUsed || "Auto",
  };
}

