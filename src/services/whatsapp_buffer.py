"""
Buffer inteligente de mensagens WhatsApp.
Acumula mensagens dos grupos sem acionar a IA para cada uma —
a IA só é chamada quando o usuário pede o digest.
"""
from collections import defaultdict
from datetime import datetime
import threading

_lock = threading.Lock()

# Estrutura: { "Nome do Grupo": { "chatId": "xxx@g.us", "messages": [...] } }
_message_buffer: dict = {}

# Mapa rápido: nome → chatId para envios
_chat_id_map: dict[str, str] = {}

MAX_MESSAGES_PER_GROUP = 200


def add_message(group_name: str, author: str, body: str, chat_id: str = None):
    """Adiciona uma mensagem ao buffer do grupo."""
    with _lock:
        if group_name not in _message_buffer:
            _message_buffer[group_name] = {"chatId": chat_id, "messages": []}
        
        # Atualiza chatId se fornecido
        if chat_id and not _message_buffer[group_name].get("chatId"):
            _message_buffer[group_name]["chatId"] = chat_id
            _chat_id_map[group_name] = chat_id

        msgs = _message_buffer[group_name]["messages"]
        msgs.append({
            "author": author,
            "body": body,
            "timestamp": datetime.now().strftime("%H:%M")
        })
        if len(msgs) > MAX_MESSAGES_PER_GROUP:
            _message_buffer[group_name]["messages"] = msgs[-MAX_MESSAGES_PER_GROUP:]


def get_all_messages() -> dict[str, list]:
    """Retorna todas as mensagens acumuladas, organizada por grupo."""
    with _lock:
        return {
            group: data["messages"]
            for group, data in _message_buffer.items()
        }


def get_group_messages(group_name: str) -> list:
    """Retorna mensagens de um grupo específico."""
    with _lock:
        entry = _message_buffer.get(group_name, {})
        return list(entry.get("messages", []))


def get_chat_id(group_name: str) -> str | None:
    """Retorna o chatId de um grupo pelo nome (para envio)."""
    with _lock:
        entry = _message_buffer.get(group_name, {})
        return entry.get("chatId") or _chat_id_map.get(group_name)


def get_summary_stats() -> str:
    """Retorna estatísticas rápidas do buffer para o usuário."""
    with _lock:
        if not _message_buffer:
            return "Nenhuma mensagem acumulada no momento."
        lines = []
        total = 0
        for group, data in _message_buffer.items():
            count = len(data.get("messages", []))
            total += count
            lines.append(f"• {group}: {count} mensagens")
        return f"📊 {total} mensagens em {len(_message_buffer)} grupos:\n" + "\n".join(lines)


def clear_buffer(group_name: str = None):
    """Limpa o buffer — de um grupo específico ou de todos."""
    with _lock:
        if group_name:
            _message_buffer.pop(group_name, None)
        else:
            _message_buffer.clear()
