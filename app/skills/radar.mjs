/**
 * Skill: Radar Estratégico — Google Trends, Notícias ao Vivo, Grok AI & Oportunidades de SaaS/Negócios
 */
import fs from "node:fs";
import path from "node:path";

const FEEDS = {
  mercado: "https://news.google.com/rss/search?q=(Ibovespa+OR+Selic+OR+FIIs+OR+Dolar+OR+investimentos+Brasil)+when:2d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  imoveis_ma: "https://news.google.com/rss/search?q=(leilao+imoveis+OR+holding+patrimonial+OR+mercado+imobiliario+Brasil)+when:3d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  healthtech: "https://news.google.com/rss/search?q=(healthtech+OR+inteligencia+artificial+saude+OR+telemedicina+Brasil)+when:4d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  varejo: "https://news.google.com/rss/search?q=(varejo+Brasil+OR+gestao+loja+OR+e-commerce+tendencias)+when:4d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  saas_tech: "https://news.google.com/rss/search?q=(SaaS+OR+micro-saas+OR+AI+agents+OR+automação+negócios)+when:3d&hl=pt-BR&gl=BR&ceid=BR:pt-419",
  trends_br: "https://trends.google.com/trending/rss?geo=BR",
  trends_us: "https://trends.google.com/trending/rss?geo=US",
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

function parseRssItems(xml, max = 4, isTrends = false) {
  const items = [];
  const matches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of matches.slice(0, max)) {
    const title = decodeXml((block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "");
    const link = decodeXml((block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "");
    const pubDate = decodeXml((block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "");
    const source = decodeXml((block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || "");
    const traffic = decodeXml((block.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1] || "");
    const newsTitle = decodeXml((block.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/) || [])[1] || "");
    if (title) {
      items.push({
        title,
        link,
        pubDate,
        source: traffic ? `Google Trends (${traffic} buscas) • ${newsTitle || source}` : (source || "Notícia"),
      });
    }
  }
  return items;
}

export async function fetchLiveNews() {
  const entries = await Promise.all(
    Object.entries(FEEDS).map(async ([topic, url]) => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(8000),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Kyrie-Radar/2.0" },
        });
        if (!res.ok) return [topic, []];
        const xml = await res.text();
        const isTrends = topic.startsWith("trends_");
        return [topic, parseRssItems(xml, isTrends ? 5 : 3, isTrends)];
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
      const label = topic.toUpperCase().replace("_", " ");
      const lines = (list || []).map((n) => `- ${n.title} (${n.source || "Fonte"})`).join("\n");
      return `### ${label}\n${lines || "- Sem dados recentes"}`;
    })
    .join("\n\n");

  const prefBlock = (memories || [])
    .slice(0, 15)
    .map((m) => `- [${m.pillar}] ${m.fact}`)
    .join("\n");

  return {
    system: `Você é o Grok integrado à Kyrie, Chief of Staff e Conselheira Estratégica de Inovação de Bruno Menegali.
Perfil do Bruno:
- Fundador de SaaS de Saúde (ProntoMed e CliniMind)
- CEO da GluN Capital S.A. (Holding, leilões de imóveis com deságio, M&A)
- Dono da loja física de varejo Nossa Casa
- Professor universitário (UNISUL/UNIBAVE)
- Trader B3 de curto prazo e investidor de longo prazo.

Com base nos dados em tempo real (notícias e GOOGLE TRENDS / tendências de busca no Brasil e EUA) e no perfil de empreendedor/investidor do Bruno, gere um **Radar Estratégico Executivo** de altíssimo valor.

Estrutura OBRIGATÓRIA (desenvolva completamente CADA seção, NUNCA corte no meio):

1. 📰 **Termômetro & Notícias-Chave (Top 3):**
   - Os 3 fatos macroeconômicos, de mercado ou saúde com maior impacto no bolso e nas empresas hoje.

2. 📈 **Radar de Investimentos & Oportunidades:**
   - 2 oportunidades concretas (ações, FIIs, leilões de imóveis da Caixa/judiciais, taxa de juros) com visão prudente de risco e retorno.

3. 🚀 **Tendências de Busca (Google Trends) & Oportunidades de SaaS / Novos Negócios:**
   - Analise o que as pessoas estão buscando intensamente no Google Trends (BR e US) e cruze com a capacidade de execução do Bruno.
   - Proponha **1 ideia concreta de Micro-SaaS, produto de IA ou automação de alto valor** voltada para Clínicas Médicas (CliniMind/ProntoMed), Leilões de Imóveis (GluN) ou Varejo (Nossa Casa).
   - Diga qual é a dor do mercado, como o SaaS resolve e como monetizar rápido (ex: assinatura mensal R$ 197 a R$ 497).

4. 🎯 **Orientação da Kyrie:**
   - 1 conselho direto e cirúrgico de governança ou foco para o dia de hoje.

Mantenha cada ponto conciso, direto e executivo (total de ~500 a 600 palavras), garantindo que todas as 4 seções sejam desenvolvidas integralmente e concluídas com a assinatura:
\n\n— **Kyrie (com inteligência Grok & Google Trends)**`,
    user: `DADOS EM TEMPO REAL (NOTÍCIAS + GOOGLE TRENDS BR/US + SAAS/IA):\n${newsText}\n\nPREFERÊNCIAS E MEMÓRIA DE BRUNO:\n${prefBlock || "- Criador de soluções escaláveis e investidor focado em fluxo de caixa e equity."}`,
  };
}
