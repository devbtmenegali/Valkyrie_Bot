/**
 * Skill: Radar Estratégico — Notícias ao Vivo (RSS), Oportunidades de Investimento & Negócios + Aprendizado Contínuo
 */
import fs from "node:fs";
import path from "node:path";

const FEEDS = {
  mercado: "https://news.google.com/rss/search?q=(Ibovespa+OR+Selic+OR+FIIs+OR+Dolar+OR+investimentos+Brasil)+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  imoveis_ma: "https://news.google.com/rss/search?q=(leilao+imoveis+OR+holding+patrimonial+OR+mercado+imobiliario+Brasil)+when:3d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  healthtech: "https://news.google.com/rss/search?q=(healthtech+OR+inteligencia+artificial+saude+OR+telemedicina+Brasil)+when:4d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  varejo: "https://news.google.com/rss/search?q=(varejo+Brasil+OR+gestao+loja+OR+e-commerce+tendencias)+when:4d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
};

function decodeXml(str) {
  return String(str || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function parseRssItems(xml, max = 4) {
  const items = [];
  const matches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of matches.slice(0, max)) {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pubDate = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const source = decodeXml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    if (title) items.push({ title, link, pubDate, source });
  }
  return items;
}

export async function fetchLiveNews() {
  const entries = await Promise.all(
    Object.entries(FEEDS).map(async ([topic, url]) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Valkyrie-Executive-Radar/1.0" },
        });
        if (!res.ok) return [topic, []];
        const xml = await res.text();
        return [topic, parseRssItems(xml, 3)];
      } catch {
        return [topic, []];
      }
    })
  );
  return Object.fromEntries(entries);
}

export function loadCachedRadar(appDir) {
  const p = path.join(appDir, "radar-cache.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

export function saveCachedRadar(appDir, data) {
  fs.writeFileSync(path.join(appDir, "radar-cache.json"), JSON.stringify(data, null, 2), "utf8");
}

export function buildRadarPrompt(news, memories) {
  const newsText = Object.entries(news)
    .map(([topic, list]) => {
      const lines = (list || []).map((n) => `- ${n.title} (${n.source || "Notícia"})`).join("\n");
      return `### ${topic.toUpperCase()}\n${lines || "- Sem manchetes recentes"}`;
    })
    .join("\n\n");

  const prefBlock = (memories || [])
    .slice(0, 15)
    .map((m) => `- [${m.pillar}] ${m.fact}`)
    .join("\n");

  return {
    system: `Você é a Valkyrie, Chief of Staff e Conselheira Estratégica de Bruno Menegali.
Perfil do Bruno: CEO da GluN Capital S.A. (Holding, leilões de imóveis, M&A), fundador de SaaS de saúde (ProntoMed e CliniMind), dono da loja de varejo Nossa Casa, professor universitário (UNISUL/UNIBAVE), trader de curto prazo (B3) e investidor de longo prazo.

Com base nas manchetes REAIS de hoje e nas preferências aprendidas do Bruno, produza um **Radar Estratégico Executivo** curto, direto e acionável em português com EXATAMENTE estas 4 seções:
1. 📰 **Termômetro & Notícias-Chave (Top 3):** o que realmente impacta mercado, negócios ou saúde hoje.
2. 📈 **Radar de Investimentos & Oportunidades:** 2 pontos de atenção para longo prazo (ações, FIIs, juros/renda fixa, imóveis/leilões) — sempre com visão prudente de risco.
3. 💡 **Ideia de Negócio / Melhor Prática do Dia:** 1 ideia concreta e aplicável hoje na GluN Capital, ProntoMed, CliniMind ou Nossa Casa.
4. 🎯 **Orientação da Valkyrie:** 1 conselho curto de alta performance/governança baseado no momento dele.

Seja objetiva, sem enrolação (máx. 260 palavras).`,
    user: `MANCHETES REAIS DE HOJE:\n${newsText}\n\nPREFERÊNCIAS E MEMÓRIA APRENDIDA DO BRUNO:\n${prefBlock || "- Ainda aprendendo preferências iniciais."}`,
  };
}

