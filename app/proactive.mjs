/**
 * Motor Proativo da Valkyrie — Ela lidera e orienta o dia do Bruno automaticamente
 * Dispara intervenções humanas (IA + Voz + Notificação + WhatsApp) em momentos estratégicos e 15 min antes de cada evento.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getHolidayInfo } from "./holidays.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIRED_FILE = path.join(__dirname, "proactive-fired.json");
const TZ = "America/Sao_Paulo";

function loadFiredKeys() {
  try {
    if (fs.existsSync(FIRED_FILE)) {
      const data = JSON.parse(fs.readFileSync(FIRED_FILE, "utf8"));
      return new Set(Array.isArray(data) ? data : []);
    }
  } catch {}
  return new Set();
}

function saveFiredKeys(set) {
  try {
    const arr = Array.from(set).slice(-100);
    fs.writeFileSync(FIRED_FILE, JSON.stringify(arr, null, 2), "utf8");
  } catch {}
}

function getNowParts() {
  const now = new Date();
  const hhmm = now.toLocaleTimeString("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  return { now, hhmm, dateStr };
}

export function createProactiveEngine({
  runSimplePromptAI,
  getPreferredProvider,
  fetchCalendarDate,
  parseKanban,
  getTodayHabits,
  getWeekdayInfo,
  getFinanceSummary,
  getUpcomingBirthdays,
  getPendingWhatsApp,
  onProactiveMessage,
}) {
  const firedKeys = loadFiredKeys();

  async function buildContextSnapshot(dateStr) {
    const [cal, fin, bdays, wa] = await Promise.all([
      fetchCalendarDate(dateStr),
      getFinanceSummary(),
      getUpcomingBirthdays(10),
      getPendingWhatsApp ? getPendingWhatsApp() : Promise.resolve({ count: 0, items: [] }),
    ]);
    const habits = getTodayHabits();
    const holiday = getHolidayInfo(dateStr);
    const info = getWeekdayInfo(0);
    const topTasks = parseKanban()
      .flatMap((s) => s.items.filter((i) => i.status !== "x").map((i) => `${s.title}: ${i.text}`))
      .slice(0, 4);

    return { cal, fin, bdays, wa, habits, holiday, info, topTasks };
  }

  async function triggerCheckIn(slotName, objectivePrompt) {
    const { hhmm, dateStr } = getNowParts();
    const ctx = await buildContextSnapshot(dateStr);

    const systemPrompt = `Você é a Kyrie, Chief of Staff humana, proativa e executiva de Bruno Menegali.
Você NÃO espera o Bruno pedir: você está tomando a iniciativa agora (${hhmm}, ${ctx.info.dayName}, ${dateStr}) para orientar o próximo passo dele.
Regras de estilo:
- Fale como uma pessoa real, executiva, carismática e focada em resultados (estilo WhatsApp: use quebras de linha limpas, negrito estratégico e emojis moderados).
- ZERO clichês e ZERO frases robóticas.
- Respeite rigorosamente feriados: ${ctx.holiday.isHoliday ? `HOJE É FERIADO (${ctx.holiday.name}) — B3 FECHADA, não cobre Day Trade.` : ctx.holiday.isWeekend ? "FIM DE SEMANA — B3 fechada." : "Dia útil normal com B3 aberta."}`;

    const userText = `MOMENTO DO DIA: ${slotName}
OBJETIVO DA SUA INTERVENÇÃO: ${objectivePrompt}

DADOS REAIS AGORA:
- Treino hoje (${ctx.info.workoutShort}): ${ctx.habits.workoutDone ? "JÁ FEITO" : "PENDENTE"}
- Leitura 30m: ${ctx.habits.readingDone ? "JÁ FEITA" : "PENDENTE"}
- Day Trade: ${ctx.habits.tradeText}
- Agenda hoje: ${(ctx.cal.events || []).map((e) => `${e.summary} (${e.start.slice(11, 16) || "dia todo"})`).join(", ") || "Livre"}
- Top tarefas abertas: ${ctx.topTasks.join(" | ") || "Nenhuma"}
- Cobranças atrasadas a receber: ${ctx.fin.overdueReceivables.length}
- Mensagens urgentes/pendentes no WhatsApp que precisam do Bruno: ${ctx.wa.count}${ctx.wa.items?.length ? " (" + ctx.wa.items.slice(0, 3).map((m) => `${m.senderName}: ${m.text.slice(0, 60)}`).join("; ") + ")" : ""}
- Aniversários próximos (10d): ${ctx.bdays.map((b) => `${b.name} em ${b.daysUntil}d`).join(", ") || "Nenhum"}`;

    try {
      const ai = await runSimplePromptAI({
        preferredProvider: getPreferredProvider(),
        systemPrompt,
        userText,
      });
      await onProactiveMessage({
        title: `Valkyrie — ${slotName}`,
        text: ai.reply,
        providerUsed: `${ai.providerUsed} • Proativo`,
        tag: `proactive-${slotName.toLowerCase().replace(/\s+/g, "-")}`,
      });
      return ai.reply;
    } catch (err) {
      console.error("[Proactive triggerCheckIn Erro]", err.message);
      return null;
    }
  }

  async function tick() {
    const { now, hhmm, dateStr } = getNowParts();
    const holiday = getHolidayInfo(dateStr);

    const slots = [
      {
        time: "06:30",
        name: "Briefing Matinal",
        always: true,
        prompt: "Dê bom dia com o Briefing Matinal executivo de WhatsApp (com emojis e tópicos limpos): 1) Treino de hoje (Jiu-Jitsu ou Musculação); 2) Janela de Day Trade (meta R$ 500 das 9h às 11h, se B3 aberta); 3) Foco Corporativo (top 3 prioridades do Kanban entre GluN, ProntoMed e CliniMind); 4) Compromissos e Aulas de hoje do Google Calendar, avisando se houver conflito de horário.",
      },
      {
        time: "08:45",
        name: "Pré-Mercado Day Trade",
        onlyMarket: true,
        prompt: "Faltam 15 minutos para a abertura da B3 (09:00). Lembre o foco na meta de R$ 500, disciplina de stop e janela inviolável até as 11:00.",
      },
      {
        time: "11:15",
        name: "Fechamento Day Trade & Alinhamento",
        onlyMarket: true,
        prompt: "Janela das 9h às 11h encerrada. Pergunte o resultado de hoje para registrar no habit tracker e aponte a prioridade da tarde antes do almoço sagrado com a família (12:00 às 13:30).",
      },
      {
        time: "14:00",
        name: "Pulso da Tarde & Execução",
        always: true,
        prompt: "Início do bloco da tarde. Cobre a entrega prioritária corporativa e alerte sobre cobranças pendentes ou aniversários se houver.",
      },
      {
        time: "16:30",
        name: "Transição Pré-Aulas & Idiomas",
        always: true,
        prompt: "Lembre compromissos/aulas do fim de tarde e sugira fazer os 10 min de Inglês ou Espanhol no trajeto.",
      },
      {
        time: "21:00",
        name: "Fechamento Noturno & Leitura",
        always: true,
        prompt: "Faça um check-in acolhedor de fim de noite: lembre dos 30 min de leitura se ainda pendentes e confirme o avanço do dia.",
      },
    ];

    for (const slot of slots) {
      if (hhmm !== slot.time) continue;
      if (slot.onlyMarket && holiday.b3Closed) continue;
      const key = `${dateStr}-${slot.time}`;
      if (firedKeys.has(key)) continue;
      firedKeys.add(key);
      saveFiredKeys(firedKeys);
      await triggerCheckIn(slot.name, slot.prompt);
    }

    // Alerta automático 15 minutos antes de QUALQUER compromisso do Google Calendar
    try {
      const cal = await fetchCalendarDate(dateStr);
      for (const ev of cal.events || []) {
        if (!ev.start || !ev.start.includes("T")) continue;
        const diffMin = Math.round((Date.parse(ev.start) - now.getTime()) / 60000);
        if (diffMin >= 13 && diffMin <= 16) {
          const evKey = `ev-${ev.id}-${dateStr}`;
          if (firedKeys.has(evKey)) continue;
          firedKeys.add(evKey);
          saveFiredKeys(firedKeys);
          await triggerCheckIn(
            `Compromisso em 15 min`,
            `Avise o Bruno de forma natural que "${ev.summary}" começa em 15 minutos (às ${ev.start.slice(11, 16)}) e pergunte se precisa de algum apoio antes de entrar.`
          );
        }
      }
    } catch {}
  }

  function start() {
    // Roda primeira checagem 3 segundos após inicialização
    setTimeout(() => {
      tick().catch(() => {});
    }, 3000);

    // E depois a cada 25 segundos
    setInterval(() => {
      tick().catch(() => {});
    }, 25000);
  }

  return {
    start,
    triggerNow: (slotName = "Orientação Agora", prompt = "") => triggerCheckIn(
      slotName,
      prompt || "Olhe o horário atual, os hábitos pendentes, a agenda restante do dia, cobranças/aniversários e as prioridades do Kanban, e diga claramente ao Bruno qual é a MELHOR coisa para ele focar agora."
    ),
  };
}
