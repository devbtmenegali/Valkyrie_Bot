/**
 * Motor Proativo da Valkyrie — Ela lidera e orienta o dia do Bruno automaticamente
 * Dispara intervenções humanas (IA + Voz + Notificação + Chat) em momentos estratégicos e 15 min antes de cada evento.
 */
import { getHolidayInfo } from "./holidays.mjs";

const TZ = "America/Sao_Paulo";

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
  const firedKeys = new Set();

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

    const systemPrompt = `Você é a Valkyrie, Chief of Staff humana, proativa e afiada de Bruno Menegali.
Você NÃO espera o Bruno pedir: você está tomando a iniciativa agora (${hhmm}, ${ctx.info.dayName}, ${dateStr}) para orientar o próximo passo dele.
Regras:
- Fale como uma pessoa real, próxima e executiva (máximo 3 a 4 frases naturais, ótimas para ouvir em áudio).
- ZERO frases robóticas. Seja direta, humana, carismática e firme nas prioridades.
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
        title: `⚡ Valkyrie — ${slotName}`,
        text: ai.reply,
        providerUsed: `${ai.providerUsed} • Proativo`,
        tag: `proactive-${slotName.toLowerCase().replace(/\s+/g, "-")}`,
      });
      return ai.reply;
    } catch {
      return null;
    }
  }

  async function tick() {
    const { now, hhmm, dateStr } = getNowParts();
    const holiday = getHolidayInfo(dateStr);

    const slots = [
      { time: "06:30", name: "Abertura do Dia", always: true, prompt: "Dê bom dia de forma humana, diga qual é o treino de hoje, o panorama da agenda e defina a prioridade número 1 do dia." },
      { time: "08:45", name: "Pré-Mercado Day Trade", onlyMarket: true, prompt: "Faltam 15 minutos para abrir a janela inviolável das 9h às 11h. Alinhe foco, meta de R$ 500 e disciplina de stop." },
      { time: "11:15", name: "Virada de Chave Pós-Mercado", onlyMarket: true, prompt: "Pergunte como fechou o Day Trade para registrar e já direcione o Bruno para a principal tarefa corporativa (GluN / ProntoMed / CliniMind) antes do almoço." },
      { time: "14:00", name: "Pulso da Tarde", always: true, prompt: "Oriente o bloco da tarde: cobre pendência financeira/cobrança ou aniversário próximo se houver, e foque na tarefa mais importante em aberto." },
      { time: "16:30", name: "Transição Pré-Aulas & Idiomas", always: true, prompt: "Lembre compromissos/aulas do fim de tarde e sugira fazer os 10 min de Inglês ou Espanhol no carro se for dirigir." },
      { time: "21:00", name: "Fechamento & Leitura", always: true, prompt: "Faça um check-in acolhedor de fim de noite: lembre os 30 min de leitura se estiverem pendentes e reconheça o avanço do dia." },
    ];

    for (const slot of slots) {
      if (hhmm !== slot.time) continue;
      if (slot.onlyMarket && holiday.b3Closed) continue;
      const key = `${dateStr}-${slot.time}`;
      if (firedKeys.has(key)) continue;
      firedKeys.add(key);
      await triggerCheckIn(slot.name, slot.prompt);
    }

    // Alerta automático 15 minutos antes de QUALQUER compromisso do Google Calendar
    try {
      const cal = await fetchCalendarDate(dateStr);
      for (const ev of cal.events || []) {
        if (!ev.start || !ev.start.includes("T")) continue;
        const diffMin = Math.round((Date.parse(ev.start) - now.getTime()) / 60000);
        if (diffMin >= 14 && diffMin <= 16) {
          const evKey = `ev-${ev.id}-${dateStr}`;
          if (firedKeys.has(evKey)) continue;
          firedKeys.add(evKey);
          await triggerCheckIn(
            `Compromisso em 15 min`,
            `Avise o Bruno de forma natural que "${ev.summary}" começa em 15 minutos (às ${ev.start.slice(11, 16)}) e pergunte se precisa de algum apoio antes de entrar.`
          );
        }
      }
    } catch {}
  }

  function start() {
    setInterval(() => { tick().catch(() => {}); }, 30000);
  }

  return {
    start,
    triggerNow: () => triggerCheckIn(
      "Orientação Agora",
      "Olhe o horário atual, os hábitos pendentes, a agenda restante do dia, cobranças/aniversários e as prioridades do Kanban, e diga claramente ao Bruno qual é a MELHOR coisa para ele focar agora."
    ),
  };
}

