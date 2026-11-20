/**
 * Motor de Mercado Financeiro & Agenda Econômica Pré-Mercado
 * Busca variáveis em tempo real (S&P500, Nasdaq, Dólar, Brent, IBOV) e eventos de alto impacto da agenda econômica.
 */
import { getHolidayInfo } from "./holidays.mjs";

const TZ = "America/Sao_Paulo";

function todayISO() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

/**
 * Busca cotações de moedas e commodities via AwesomeAPI e Yahoo Finance
 */
export async function fetchPreMarketData() {
  const today = todayISO();
  const holiday = getHolidayInfo(today);

  const market = {
    date: today,
    b3Open: !holiday.b3Closed,
    holidayReason: holiday.isHoliday ? holiday.name : holiday.isWeekend ? "Fim de Semana" : null,
    usdBrl: null,
    eurBrl: null,
    btcBrl: null,
    sp500Futures: null,
    nasdaqFutures: null,
    brentCrude: null,
    ibovLast: null,
    timestamp: new Date().toISOString(),
  };

  // 1. Câmbio via AwesomeAPI
  try {
    const res = await fetch("https://economia.awesomeapi.com.br/last/USD-BRL,EUR-BRL,BTC-BRL", {
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.USDBRL) {
        market.usdBrl = {
          bid: Number(data.USDBRL.bid || 0).toFixed(4),
          pctChange: Number(data.USDBRL.pctChange || 0).toFixed(2),
        };
      }
      if (data.EURBRL) {
        market.eurBrl = {
          bid: Number(data.EURBRL.bid || 0).toFixed(4),
          pctChange: Number(data.EURBRL.pctChange || 0).toFixed(2),
        };
      }
      if (data.BTCBRL) {
        market.btcBrl = {
          bid: Number(data.BTCBRL.bid || 0).toLocaleString("pt-BR", { maximumFractionDigits: 0 }),
          pctChange: Number(data.BTCBRL.pctChange || 0).toFixed(2),
        };
      }
    }
  } catch (err) {
    // Ignora timeout silenciosamente
  }

  // 2. Futuros globais e indicadores via Yahoo Finance
  const yahooSymbols = [
    { key: "sp500Futures", name: "S&P 500 Futuro", sym: "ES=F" },
    { key: "nasdaqFutures", name: "Nasdaq Futuro", sym: "NQ=F" },
    { key: "brentCrude", name: "Petróleo Brent", sym: "BZ=F" },
    { key: "treasury10Y", name: "US 10Y Yield", sym: "^TNX" },
    { key: "ibovLast", name: "Ibovespa", sym: "^BVSP" },
  ];

  await Promise.allSettled(
    yahooSymbols.map(async (item) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(item.sym)}?interval=1d&range=1d`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(6000),
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        });
        if (res.ok) {
          const json = await res.json();
          const meta = json?.chart?.result?.[0]?.meta;
          if (meta) {
            const price = Number(meta.regularMarketPrice || 0);
            const prev = Number(meta.chartPreviousClose || meta.previousClose || price);
            const diffPct = prev > 0 ? (((price - prev) / prev) * 100).toFixed(2) : "0.00";
            market[item.key] = {
              price: price.toFixed(2),
              pctChange: (diffPct.startsWith("-") ? "" : "+") + diffPct,
            };
          }
        }
      } catch {}
    })
  );

  return market;
}

/**
 * Busca eventos de médio/alto impacto da agenda econômica de hoje
 */
export async function fetchEconomicCalendar() {
  const today = todayISO();
  try {
    const res = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
      signal: AbortSignal.timeout(7000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return [];
    const list = await res.json();
    if (!Array.isArray(list)) return [];

    const relevant = list.filter((item) => {
      if (!item.date || !item.date.startsWith(today)) return false;
      // Relevância: USD, BRL ou Impacto Médio/Alto
      const isMacro = item.country === "USD" || item.country === "BRL" || item.impact === "High" || item.impact === "Medium";
      return isMacro;
    });

    return relevant.map((ev) => {
      let timeBrt = "";
      try {
        const d = new Date(ev.date);
        timeBrt = d.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      } catch {
        timeBrt = ev.date.slice(11, 16);
      }
      return {
        title: ev.title,
        country: ev.country,
        impact: ev.impact, // High, Medium, Low
        time: timeBrt,
        forecast: ev.forecast || "-",
        previous: ev.previous || "-",
      };
    });
  } catch {
    return [];
  }
}
