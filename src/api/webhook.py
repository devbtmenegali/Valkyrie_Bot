import json
from http.server import BaseHTTPRequestHandler, HTTPServer
import threading
import logging

logger = logging.getLogger(__name__)

# Palavras que exigem resposta IMEDIATA (mesmo sem pedido de digest)
URGENT_KEYWORDS = ['valkyrie', 'urgente', 'me liga', 'emergência', 'socorro']


class WebhookHandler(BaseHTTPRequestHandler):
    agent = None

    def _set_response(self):
        self.send_response(200)
        self.send_header('Content-type', 'application/json')
        self.end_headers()

    def do_POST(self):
        if self.path == '/webhook/whatsapp':
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)

            try:
                payload = json.loads(post_data.decode('utf-8'))
                author = payload.get("author", "Desconhecido")
                body = payload.get("body", "")
                group_name = payload.get("groupName", "Chat Privado")
                is_group = payload.get("isGroup", False)

                if not body.strip():
                    self._set_response()
                    self.wfile.write(json.dumps({"status": "skipped"}).encode('utf-8'))
                    return

                # ── 1. SEMPRE ADICIONA AO BUFFER (com chatId para envio futuro) ──
                from src.services.whatsapp_buffer import add_message
                chat_id = payload.get("chatId") or payload.get("from", "")
                add_message(group_name, author, body, chat_id=chat_id)
                logger.debug(f"[BUFFER] {group_name} | {author}: {body[:40]}")

                # ── 2. RESPOSTA IMEDIATA só em casos urgentes ─────────────────
                if WebhookHandler.agent:
                    body_lower = body.lower()
                    is_urgent = any(kw in body_lower for kw in URGENT_KEYWORDS)

                    if not is_group:
                        # Chat privado → sempre processa
                        context_msg = f"MENSAGEM PRIVADA DO WHATSAPP (De: {author}):\n{body}"
                        threading.Thread(
                            target=self._process_background,
                            args=(context_msg,),
                            daemon=True
                        ).start()
                        logger.info(f"[WHATSAPP PRIVADO] Processando: {author}")

                    elif is_urgent:
                        # Grupo com palavra-chave urgente → processa imediatamente
                        context_msg = f"🚨 MENSAGEM URGENTE DO WHATSAPP\nGrupo: {group_name} | De: {author}\n{body}"
                        threading.Thread(
                            target=self._process_background,
                            args=(context_msg,),
                            daemon=True
                        ).start()
                        logger.info(f"[WHATSAPP URGENTE] {group_name} | {author}: {body[:50]}")

                    else:
                        # Grupo normal → só buffer, sem acionar IA
                        logger.debug(f"[WHATSAPP BUFFER] {group_name}: mensagem acumulada ({body[:30]}...)")

                self._set_response()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))

            except Exception as e:
                logger.error(f"Erro processando payload: {e}")
                self.send_response(500)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

    def _process_background(self, msg):
        try:
            WebhookHandler.agent.process_message(msg)
        except Exception as e:
            logger.error(f"Erro da IA processando msg WhatsApp: {e}")

    def log_message(self, format, *args):
        pass  # Silencia logs HTTP brutos


def run_server(agent_instance, port=5000):
    WebhookHandler.agent = agent_instance
    server_address = ('', port)
    httpd = HTTPServer(server_address, WebhookHandler)
    logger.info(f"Gateway WhatsApp [Node ↔ Python] operando na porta {port}")
    httpd.serve_forever()


def start_webhook_listener(agent_instance):
    """Inicia o servidor num background thread."""
    thread = threading.Thread(target=run_server, args=(agent_instance,), daemon=True)
    thread.start()
    return thread
