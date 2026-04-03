import logging
from langchain.tools import BaseTool
from pydantic import BaseModel, Field
from typing import Optional
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
import os

logger = logging.getLogger(__name__)

DIGEST_PROMPT = """Você é a Valkyrie fazendo uma varredura nos grupos de WhatsApp do Bruno.
RESPONDA SEMPRE EM PORTUGUÊS DO BRASIL.

Analise as mensagens abaixo e produza um relatório executivo PRIORIZANDO o que realmente importa.

CRITÉRIOS DE PRIORIDADE:
🔴 URGENTE — Requer resposta de Bruno hoje: perguntas diretas a ele, decisões aguardando, prazos
🟡 IMPORTANTE — Informações relevantes para o negócio/projetos/relacionamentos
🟢 INFORMATIVO — Novidades, conteúdos e discussões gerais sem urgência
⚪ IGNORAR — Spam, figurinhas, correntes, posts sem relevância

FORMATO DE RESPOSTA:

## 📱 DIGEST DOS GRUPOS WHATSAPP
*Período analisado: {period}*

---

### 🔴 REQUER SUA ATENÇÃO
[Lista de mensagens/situações que precisam de resposta de Bruno]
• **[Grupo]** | [Autor]: "[Mensagem resumida]" → *Ação sugerida*
[Se não houver: "Nada urgente no momento."]

---

### 🟡 DESTAQUES IMPORTANTES
[Informações relevantes mas que não exigem ação imediata]
• **[Grupo]**: [Resumo do que foi discutido]
[Se não houver: "Nenhum destaque importante."]

---

### 📊 RESUMO POR GRUPO
[Para cada grupo com atividade relevante:]
**[Nome do Grupo]** ({n} msgs): [Uma linha resumindo o que foi discutido]

---

### 💡 SUGESTÃO DA VALKYRIE
[Uma recomendação baseada na análise — ex: responder algum contato, silenciar algum grupo muito ativo sem conteúdo, etc.]

---
Seja objetiva. Bruno tem pouco tempo. Filtre o ruído."""


class WhatsAppDigestInput(BaseModel):
    group_filter: Optional[str] = Field(
        default=None,
        description="Nome do grupo específico para analisar. Se vazio, analisa todos os grupos."
    )


class WhatsAppDigestTool(BaseTool):
    name: str = "whatsapp_digest"
    description: str = (
        "Faz uma varredura inteligente em todos os grupos do WhatsApp do usuário e retorna um digest "
        "priorizado com o que requer atenção, destaques importantes e resumo por grupo. "
        "Use quando o usuário pedir: 'o que está rolando nos grupos', 'tem algo importante no zap', "
        "'resume meus grupos', 'varredura do whatsapp', 'digest', etc."
    )
    args_schema: type = WhatsAppDigestInput

    def _run(self, group_filter: str = None) -> str:
        try:
            from src.services.whatsapp_buffer import get_all_messages, get_group_messages, get_summary_stats

            if group_filter:
                messages_by_group = {group_filter: get_group_messages(group_filter)}
            else:
                messages_by_group = get_all_messages()

            if not messages_by_group or all(len(v) == 0 for v in messages_by_group.values()):
                stats = get_summary_stats()
                return f"Não há mensagens acumuladas nos grupos ainda.\n{stats}"

            # Formata as mensagens para análise
            formatted_groups = []
            total_msgs = 0
            for group_name, messages in messages_by_group.items():
                if not messages:
                    continue
                formatted_groups.append(f"\n=== GRUPO: {group_name} ({len(messages)} msgs) ===")
                for msg in messages[-50:]:  # Últimas 50 de cada grupo
                    formatted_groups.append(f"[{msg['timestamp']}] {msg['author']}: {msg['body']}")
                total_msgs += len(messages)

            if not formatted_groups:
                return "Nenhuma mensagem nova nos grupos desde a última varredura."

            all_messages_text = "\n".join(formatted_groups)

            # Usa GPT-4o mini para análise (sem consumir quota do Gemini)
            llm = ChatOpenAI(
                model="gpt-4o-mini",
                temperature=0.1,
                api_key=os.getenv("OPENAI_API_KEY")
            )

            from datetime import datetime
            period = datetime.now().strftime("%d/%m/%Y %H:%M")
            prompt = DIGEST_PROMPT.replace("{period}", period).replace("{n}", str(total_msgs))

            messages_llm = [
                SystemMessage(content=prompt),
                HumanMessage(content=f"MENSAGENS DOS GRUPOS:\n{all_messages_text}")
            ]

            response = llm.invoke(messages_llm)
            return response.content

        except Exception as e:
            logger.error(f"Erro no WhatsAppDigestTool: {e}")
            return f"Erro ao processar digest dos grupos: {str(e)}"


class WhatsAppStatsInput(BaseModel):
    pass


class WhatsAppStatsTool(BaseTool):
    name: str = "whatsapp_stats"
    description: str = (
        "Mostra quantas mensagens estão acumuladas em cada grupo do WhatsApp, sem fazer análise completa. "
        "Use para verificar o volume antes de pedir o digest completo."
    )
    args_schema: type = WhatsAppStatsInput

    def _run(self) -> str:
        from src.services.whatsapp_buffer import get_summary_stats
        return get_summary_stats()
