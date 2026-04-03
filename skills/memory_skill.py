from langchain.tools import BaseTool
from pydantic import BaseModel, Field
from typing import Optional
import logging

logger = logging.getLogger(__name__)


class MemorizeInput(BaseModel):
    fact: str = Field(description="O fato, rotina, dado ou informação importante a ser memorizado permanentemente.")
    category: Optional[str] = Field(default="geral", description="Categoria do fato: rotina, contato, preferencia, compromisso, financeiro, etc.")


class MemorizeFactTool(BaseTool):
    name: str = "memorize_fact"
    description: str = (
        "Use esta ferramenta para SALVAR permanentemente um fato, rotina, preferência, contato ou informação "
        "que o usuário pediu para você lembrar. Exemplos: 'minha reunião é toda segunda', "
        "'a senha do cofre é X', 'prefiro respostas curtas pela manhã'."
    )
    args_schema: type = MemorizeInput
    vector_db: object = None

    class Config:
        arbitrary_types_allowed = True

    def _run(self, fact: str, category: str = "geral") -> str:
        try:
            if not self.vector_db:
                return "❌ Banco de memória não conectado."
            memory_id = self.vector_db.add_memory(
                text=fact,
                metadata={"category": category}
            )
            logger.info(f"Memória salva: [{category}] {fact[:50]}...")
            return f"✅ Memorizado com sucesso! Guardarei sempre: \"{fact}\""
        except Exception as e:
            logger.error(f"Erro ao memorizar: {e}")
            return f"❌ Falha ao memorizar: {str(e)}"


class RecallInput(BaseModel):
    query: str = Field(description="O que você quer buscar na memória. Descreva o tema ou pergunta.")


class RecallMemoriesTool(BaseTool):
    name: str = "recall_memories"
    description: str = (
        "Use esta ferramenta para BUSCAR na sua memória permanente informações que o usuário pode ter "
        "te ensinado antes. Use sempre que a pergunta envolver algo que foi dito 'lembra que...', "
        "'qual era mesmo...', ou quando você não tiver certeza se já sabe a resposta."
    )
    args_schema: type = RecallInput
    vector_db: object = None

    class Config:
        arbitrary_types_allowed = True

    def _run(self, query: str) -> str:
        try:
            if not self.vector_db:
                return "Banco de memória não conectado."
            results = self.vector_db.search_memory(query, n_results=3)
            if not results:
                return "Não encontrei nada relevante na memória sobre este assunto."
            
            formatted = "\n".join([
                f"- [{r.get('metadata', {}).get('category', 'geral')}] {r['content']} (similaridade: {r.get('similarity', 0):.0%})"
                for r in results
            ])
            return f"📚 Encontrei nas memórias:\n{formatted}"
        except Exception as e:
            logger.error(f"Erro ao buscar memórias: {e}")
            return f"Erro ao acessar memória: {str(e)}"
