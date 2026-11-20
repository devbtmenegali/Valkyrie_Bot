/**
 * Calendário de Feriados Nacionais do Brasil & Fechamento da B3
 * Calcula automaticamente feriados fixos e móveis (Carnaval, Sexta-Feira Santa, Corpus Christi) para qualquer ano.
 */

function getEasterDate(year) {
  // Algoritmo de Meeus/Jones/Butcher
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function addDaysISO(baseDate, days) {
  const d = new Date(baseDate.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function getBrazilianHolidays(year) {
  const easter = getEasterDate(year);
  return {
    [`${year}-01-01`]: "Confraternização Universal (Ano Novo)",
    [addDaysISO(easter, -48)]: "Carnaval (Segunda-feira)",
    [addDaysISO(easter, -47)]: "Carnaval (Terça-feira)",
    [addDaysISO(easter, -2)]: "Sexta-Feira Santa (Paixão de Cristo)",
    [`${year}-04-21`]: "Tiradentes",
    [`${year}-05-01`]: "Dia do Trabalho",
    [addDaysISO(easter, 60)]: "Corpus Christi",
    [`${year}-09-07`]: "Independência do Brasil",
    [`${year}-10-12`]: "Nossa Senhora Aparecida",
    [`${year}-11-02`]: "Finados",
    [`${year}-11-15`]: "Proclamação da República",
    [`${year}-11-20`]: "Dia Nacional de Zumbi e da Consciência Negra",
    [`${year}-12-25`]: "Natal",
  };
}

export function getHolidayInfo(dateStr) {
  const [y, m, d] = String(dateStr || "").split("-").map(Number);
  if (!y || !m || !d) return { isHoliday: false, name: null, b3Closed: false };
  const holidays = getBrazilianHolidays(y);
  const name = holidays[dateStr] || null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0=Dom, 6=Sab
  const isWeekend = dow === 0 || dow === 6;
  return {
    isHoliday: Boolean(name),
    name,
    isWeekend,
    b3Closed: Boolean(name) || isWeekend,
  };
}

