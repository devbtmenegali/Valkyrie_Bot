import os
import re
import requests
import logging
from typing import Type, Optional
from pydantic import BaseModel, Field
from langchain.tools import BaseTool

logger = logging.getLogger(__name__)

# Porta do gateway Node.js de envio
GATEWAY_SEND_URL = "http://127.0.0.1:5001/send"
GATEWAY_CHATS_URL = "http://127.0.0.1:5001/chats"


def resolve_chat_id(recipient: str) -> tuple[str, str]:
    """
    Resolve o chatId do WhatsApp buscando todos os chats disponíveis no Node.js
    e no buffer de memória local (que pega os IDs instantaneamente).
    """
    if '@' in recipient:
        return recipient, f"chat ({recipient})"

    recipient_lower = recipient.lower()

    # 1. Busca rápida no mapa de memória do buffer recente
    try:
        from src.services.whatsapp_buffer import _chat_id_map
        for name, chat_id in _chat_id_map.items():
            if name and recipient_lower in name.lower():
                return chat_id, f"contato/grupo '{name}' (via buffer)"
    except Exception as e:
        logger.debug(f"Erro buscando no buffer: {e}")

    # 2. Busca nos contatos e grupos via API do gateway (Conversas Abertas)
    try:
        response = requests.get(GATEWAY_CHATS_URL, timeout=5)
        if response.ok:
            chats = response.json()
            for chat in chats:
                if chat.get('name') and recipient_lower in chat['name'].lower():
                    desc = f"grupo '{chat['name']}'" if chat.get('isGroup') else f"contato '{chat['name']}'"
                    return chat['id'], desc
    except Exception as e:
        logger.debug(f"Erro ao buscar lista de chats na porta 5001: {e}")

    # 3. Busca Direto na Agenda de Contatos (WhatsApp Contacts)
    GATEWAY_CONTACTS_URL = "http://127.0.0.1:5001/contacts"
    try:
        response = requests.get(GATEWAY_CONTACTS_URL, timeout=5)
        if response.ok:
            contacts = response.json()
            for contact in contacts:
                name = contact.get('name') or contact.get('pushname') or ""
                if recipient_lower in name.lower():
                    return contact['id'], f"contato salvo '{name}'"
    except Exception as e:
        logger.debug(f"Erro ao buscar lista de contatos na porta 5001: {e}")

    # 4. Se não achou na API ou ela falhou, tenta formatar como número
    phone = re.sub(r'[^0-9+]', '', recipient)
    if phone:
        phone_clean = phone.replace('+', '')
        return f"{phone_clean}@c.us", f"número {recipient}"

    # Retorna o que veio se falhar em tudo
    return recipient, f"destinatário desconhecido ({recipient})"


class WhatsAppInput(BaseModel):
    recipient: str = Field(
        description=(
            "O destinatário da mensagem. Pode ser: "
            "1) Nome do grupo (ex: 'Escola da IA - Grupo de Alunos'), "
            "2) Número com DDI (ex: +5548999999999), "
            "3) chatId direto do WhatsApp (ex: 5548999999999@c.us)"
        )
    )
    message: str = Field(description="A mensagem de texto a ser enviada.")


class SendWhatsAppTool(BaseTool):
    name: str = "send_whatsapp"
    description: str = (
        "Envia uma mensagem pelo WhatsApp para um contato ou grupo. "
        "Use o nome do grupo como aparece nas mensagens recebidas, "
        "ou o número de telefone com DDI do contato. "
        "Exemplos: 'Escola da IA - Grupo de Alunos', '+5548999999999'."
    )
    args_schema: Type[BaseModel] = WhatsAppInput

    def _run(self, recipient: str, message: str) -> str:
        try:
            chat_id, description = resolve_chat_id(recipient)
            
            # Validação forte antes de enviar para o Node
            if not ('@c.us' in chat_id or '@g.us' in chat_id or '@lid' in chat_id):
                return (
                    f"❌ Não consegui encontrar o contato/grupo '{recipient}'. "
                    "Tente pedir para esta pessoa me mandar uma mensagem no WhatsApp primeiro "
                    "para que eu a registre, ou me informe o número de telefone completo com código do país (ex: +55...)."
                )

            response = requests.post(
                GATEWAY_SEND_URL,
                json={"chatId": chat_id, "message": message},
                timeout=10
            )

            if response.ok:
                logger.info(f"WhatsApp enviado para {description}: {message[:50]}")
                return f"✅ Mensagem enviada para {description}!"
            else:
                error_detail = response.json().get('error', response.text)
                logger.error(f"Erro ao enviar WhatsApp: {error_detail}")
                return f"❌ Erro ao enviar mensagem: {error_detail}"

        except requests.exceptions.ConnectionError:
            return (
                "❌ O gateway WhatsApp (Node.js) não está respondendo na porta 5001. "
                "Verifique se o `node index.js` está rodando."
            )
        except Exception as e:
            logger.error(f"Erro inesperado no envio WhatsApp: {e}")
            return f"❌ Erro inesperado: {str(e)}"

    def _arun(self, **kwargs):
        raise NotImplementedError("Use _run")
