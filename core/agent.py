import os
import logging
from langchain_openai import ChatOpenAI
from langchain_core.messages import SystemMessage, HumanMessage
from langgraph.prebuilt import create_react_agent
from memory.vector_db import VectorMemory
from skills.email_skill import SendEmailTool
from skills.whatsapp_skill import SendWhatsAppTool
from skills.memory_skill import MemorizeFactTool, RecallMemoriesTool
from skills.calendar_skill import CreateCalendarEventTool, ListUpcomingEventsTool
from skills.whatsapp_digest_skill import WhatsAppDigestTool, WhatsAppStatsTool

logger = logging.getLogger(__name__)

class ValkyrieAgent:
    def __init__(self):
        # GPT-4o mini como cérebro conversacional (sem limite de quota diária)
        # Gemini é reservado EXCLUSIVAMENTE para análise de reuniões (tarefa pesada)
        self.llm = ChatOpenAI(
            model="gpt-4o-mini",
            temperature=0.3,
            api_key=os.getenv("OPENAI_API_KEY")
        )
        
        # Inicialização do Banco de Memória
        print("Carregando banco de memória vetorial (Supabase)...")
        self.vector_db = VectorMemory()
        
        # Ferramentas de memória com banco injetado
        memorize_tool = MemorizeFactTool()
        memorize_tool.vector_db = self.vector_db
        
        recall_tool = RecallMemoriesTool()
        recall_tool.vector_db = self.vector_db
        
        # System prompt — persona e regras da Valkyrie
        self.system_prompt = """Você é a Valkyrie, uma assistente executiva de IA — avançada, proativa e altamente capacitada.
Você gerencia, memoriza, organiza e executa tarefas para o usuário Bruno.

⚠️ REGRA ABSOLUTA: RESPONDA SEMPRE EM PORTUGUÊS DO BRASIL. NUNCA use inglês!

REGRAS DE MEMÓRIA:
1. Se o usuário pedir para "lembrar", "guardar", "memorizar" ou "anotar" → use `memorize_fact`.
2. Se a pergunta envolver algo dito anteriormente → use `recall_memories` ANTES de responder.

REGRAS DE AGENDA:
- Para criar reunião/evento → use `create_calendar_event`.
- Para consultar agenda → use `list_upcoming_events`.

REGRAS DE WHATSAPP:
- Para ver digest/resumo/varredura dos grupos → use `whatsapp_digest`.
- Para ver quantas mensagens há acumuladas → use `whatsapp_stats`.
- Para enviar mensagem → use `send_whatsapp`.

REGRAS DE COMUNICAÇÃO:
- Para enviar e-mail → use `send_email`.

Seja concisa, direta e profissional. Se não souber algo, diga claramente em português."""
        
        # Equipando todas as Skills
        print("Equipando Skills (GPT-4o-mini + Memória + Agenda + Digest WhatsApp)...")
        self.tools = [
            SendEmailTool(),
            SendWhatsAppTool(),
            memorize_tool,
            recall_tool,
            CreateCalendarEventTool(),
            ListUpcomingEventsTool(),
            WhatsAppDigestTool(),
            WhatsAppStatsTool(),
        ]
        
        # Executor LangGraph
        self.agent_executor = create_react_agent(self.llm, self.tools, prompt=self.system_prompt)
        
        print("✅ Valkyrie Core inicializado (GPT-4o-mini | Gemini reservado para análise de reuniões).")
        
    def process_message(self, message: str) -> str:
        """
        Processa uma mensagem. O agente decide automaticamente
        quando usar memória, agenda, e-mail ou WhatsApp.
        """
        try:
            response = self.agent_executor.invoke({
                "messages": [("user", message)]
            })
            
            final_message = response["messages"][-1].content
            if isinstance(final_message, list):
                text_content = ""
                for block in final_message:
                    if isinstance(block, dict) and "text" in block:
                        text_content += block["text"]
                    elif isinstance(block, str):
                        text_content += block
                return text_content
            
            return str(final_message)
        except Exception as e:
            logger.error(f"Erro no agente Valkyrie: {e}")
            return "Desculpe, tive uma falha interna. Pode repetir?"
