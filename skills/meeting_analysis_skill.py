import os
import logging
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger(__name__)

MEETING_ANALYSIS_PROMPT = """Você é a Valkyrie analisando uma gravação de reunião. 
IMPORTANTE: Responda SEMPRE em português do Brasil, sem exceção!

Analise a transcrição abaixo e produza um relatório executivo COMPLETO. 
Você DEVE preencher TODAS as seções abaixo, mesmo que precise inferir ou indicar "não identificado":

---

## 📋 ATA DA REUNIÃO

**Resumo Geral:**
[Escreva 2-4 linhas resumindo os temas centrais discutidos. Se o áudio for curto, resuma o que foi dito.]

---

## ✅ TAREFAS E RESPONSABILIDADES
[OBRIGATÓRIO: Liste tarefas mencionadas ou que se infere que precisam ser feitas. Se não explicitado, escreva as tarefas implícitas do contexto.]
• [Responsável, se mencionado, senão "A definir"] → [Tarefa específica] | Prazo: [data ou "A definir"]

---

## 📅 EVENTOS E COMPROMISSOS DETECTADOS
[OBRIGATÓRIO: Se houve menção de datas, reuniões futuras, prazos ou encontros:]
• [Nome do evento] | Data: [data/hora] | Local/formato: [presencial/online/A definir]
[Se não houver: escreva "Nenhum evento futuro identificado na gravação."]

---

## 📌 PLANO DE AÇÃO PRIORITÁRIO
[OBRIGATÓRIO: Ordene as ações mais importantes em sequência lógica:]
1. [Ação concreta e acionável] — [Responsável] — [Prazo]
2. [Próxima ação]
3. ...

---

## 💡 SUGESTÕES DE MELHORIA
[OBRIGATÓRIO: Com base no que foi discutido, proponha melhorias reais:]
• [Sugestão específica e justificada]

---

## ❓ PONTOS A CONFIRMAR
[Liste qualquer informação que ficou ambígua e precisa de confirmação do usuário:]
• [Ponto ou pergunta]
[Se tudo ficou claro: "Todos os pontos estão claros."]

---

Seja direto, profissional e acionável. Foque no que importa para o executivo."""


class MeetingAnalyzer:
    def __init__(self):
        self.llm = ChatGoogleGenerativeAI(
            model="gemini-2.5-flash",
            temperature=0.2,
            google_api_key=os.getenv("GOOGLE_API_KEY")
        )

    def analyze(self, transcription: str) -> dict:
        """
        Analisa a transcrição de uma reunião e retorna análise estruturada.
        
        Returns:
            dict com 'report' (texto), 'events' (lista de eventos detectados)
        """
        try:
            messages = [
                SystemMessage(content=MEETING_ANALYSIS_PROMPT),
                HumanMessage(content=f"TRANSCRIÇÃO DA REUNIÃO:\n\n{transcription}")
            ]
            
            response = self.llm.invoke(messages)
            report = response.content
            
            # Extrai eventos detectados para criar no calendário
            events = self._extract_events(transcription, report)
            
            return {
                "report": report,
                "events": events,
                "transcription_length": len(transcription.split())
            }
        
        except Exception as e:
            logger.error(f"Erro na análise de reunião: {e}")
            return {
                "report": f"Erro ao analisar reunião: {str(e)}",
                "events": []
            }

    def _extract_events(self, transcription: str, report: str) -> list:
        """
        Usa a IA para extrair eventos estruturados da análise.
        Retorna lista de dicts para criação no calendário.
        """
        try:
            extraction_prompt = """Da análise de reunião abaixo, extraia APENAS eventos/compromissos futuros mencionados.
Responda em formato JSON simples: [{"title": "...", "date": "DD/MM/YYYY ou descrição", "time": "HH:MM ou não mencionado", "description": "..."}]
Se não houver eventos, responda: []

ANÁLISE:
""" + report
            
            messages = [HumanMessage(content=extraction_prompt)]
            response = self.llm.invoke(messages)
            content = response.content.strip()
            
            # Remove markdown code blocks se houver
            if "```" in content:
                content = content.split("```")[1]
                if content.startswith("json"):
                    content = content[4:]
            
            import json
            events = json.loads(content)
            return events if isinstance(events, list) else []
        
        except Exception as e:
            logger.debug(f"Não foi possível extrair eventos estruturados: {e}")
            return []
