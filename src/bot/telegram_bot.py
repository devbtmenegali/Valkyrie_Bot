import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes
from core.agent import ValkyrieAgent
from src.services.voice_service import ValkyrieVoiceService
from skills.meeting_analysis_skill import MeetingAnalyzer
from skills.calendar_skill import CreateCalendarEventTool

# Logging para debug
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# Duração mínima em segundos para considerar um áudio como "gravação de reunião"
MEETING_AUDIO_THRESHOLD_SECONDS = 45


class ValkyrieTelegramBot:
    def __init__(self):
        # Validação do Token
        self.token = os.getenv("TELEGRAM_BOT_TOKEN")
        if not self.token:
            raise ValueError("A variável de ambiente TELEGRAM_BOT_TOKEN não está definida no arquivo .env")
        
        # ID do chat do dono (salvo após primeira mensagem para alertas proativos)
        self.owner_chat_id = os.getenv("OWNER_CHAT_ID")
        
        # Inicia os serviços principais
        logger.info("Inicializando o Cérebro da Valkyrie (Agent Core)...")
        self.agent = ValkyrieAgent()
        self.voice_service = ValkyrieVoiceService()
        self.meeting_analyzer = MeetingAnalyzer()
        self.calendar_tool = CreateCalendarEventTool()

    async def start(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Handler para o comando /start"""
        # Salva o chat_id para alertas proativos
        chat_id = str(update.effective_chat.id)
        if not self.owner_chat_id:
            self.owner_chat_id = chat_id
            logger.info(f"Owner chat_id registrado: {chat_id}")
        
        welcome_message = (
            "Olá! Eu sou a **Valkyrie**, sua Secretária Executiva de IA.\n\n"
            "Posso:\n"
            "🗓 Criar e consultar sua agenda no Google Calendar\n"
            "🎤 Analisar gravações de reunião (ata, tarefas, plano de ação)\n"
            "📱 Monitorar grupos do WhatsApp\n"
            "🧠 Memorizar fatos e rotinas permanentemente\n"
            "🔔 Te alertar por voz antes das suas reuniões\n"
            "📧 Enviar e-mails e WhatsApp\n\n"
            "Como posso te ajudar hoje?"
        )
        await update.message.reply_text(welcome_message, parse_mode='Markdown')

    async def handle_message(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Processa as mensagens de texto e auto-salva o chat_id"""
        # Garante que temos o chat_id salvo
        if not self.owner_chat_id:
            self.owner_chat_id = str(update.effective_chat.id)

        user_text = update.message.text
        logger.info(f"Mensagem recebida: {user_text}")
        
        await context.bot.send_chat_action(chat_id=update.effective_chat.id, action='typing')
        
        try:
            ia_response = self.agent.process_message(user_text)
            await update.message.reply_text(ia_response, parse_mode='Markdown')
        except Exception as e:
            logger.error(f"Erro no processamento da mensagem: {e}")
            await update.message.reply_text("Desculpe, ocorreu um erro interno nas minhas sinapses. Tente novamente em alguns segundos.")

    async def handle_voice(self, update: Update, context: ContextTypes.DEFAULT_TYPE):
        """Processa mensagens de voz — diferencia comandos curtos de gravações de reunião"""
        if not self.owner_chat_id:
            self.owner_chat_id = str(update.effective_chat.id)

        duration = update.message.voice.duration  # duração em segundos
        logger.info(f"Áudio recebido: {duration}s")
        
        await context.bot.send_chat_action(chat_id=update.effective_chat.id, action='record_voice')
        
        try:
            # Download do áudio
            voice_file = await context.bot.get_file(update.message.voice.file_id)
            audio_bytes = await voice_file.download_as_bytearray()
            
            # Transcrição via Whisper
            texto_transcrito = await self.voice_service.transcribe_audio(bytes(audio_bytes))
            logger.info(f"Transcrição Whisper ({duration}s): {texto_transcrito[:100]}...")
            
            # ─── REUNIÃO: áudio longo → análise completa ───────────────────
            if duration >= MEETING_AUDIO_THRESHOLD_SECONDS:
                await update.message.reply_text(
                    f"🎙️ *Gravação de reunião detectada* ({duration}s)\n"
                    f"Analisando... aguarde um momento.",
                    parse_mode='Markdown'
                )
                
                await context.bot.send_chat_action(chat_id=update.effective_chat.id, action='typing')
                
                # Análise completa da reunião
                result = self.meeting_analyzer.analyze(texto_transcrito)
                report = result["report"]
                events = result.get("events", [])
                
                # Envia o relatório em texto (pode ser longo)
                await update.message.reply_text(report, parse_mode='Markdown')
                
                # Cria automaticamente os eventos detectados no calendário
                if events:
                    created = []
                    for ev in events:
                        if ev.get("title") and ev.get("date"):
                            time_str = ev.get("time", "09:00")
                            if time_str == "não mencionado" or not time_str:
                                time_str = "09:00"
                            resultado = self.calendar_tool._run(
                                title=ev["title"],
                                date=ev["date"],
                                time=time_str,
                                description=ev.get("description", "Detectado em reunião")
                            )
                            created.append(resultado)
                    
                    if created:
                        await update.message.reply_text(
                            "📅 *Eventos criados automaticamente:*\n" + "\n".join(created),
                            parse_mode='Markdown'
                        )
                
                # Resumo em voz — claro e amigável, nunca erros técnicos
                n_events = len([e for e in events if isinstance(e, dict) and e.get("title")])
                n_tasks = report.count("→")  # Conta tarefas pelo formato "• X → Tarefa"
                
                if "Erro" in report[:50]:
                    resumo_curto = "Recebi sua gravação, mas tive uma dificuldade ao analisar. Por favor, tente novamente."
                elif n_events > 0:
                    resumo_curto = f"Reunião analisada! Criei {n_events} evento{'s' if n_events > 1 else ''} na sua agenda e organizei as tarefas. Confira o relatório na tela."
                else:
                    resumo_curto = "Reunião analisada! Organizei as tarefas e o plano de ação para você. Confira o relatório completo na tela."
                audio_resposta = await self.voice_service.generate_speech(resumo_curto)
                if audio_resposta:
                    await update.message.reply_voice(voice=audio_resposta)

            # ─── COMANDO: áudio curto → fluxo normal ───────────────────────
            else:
                await update.message.reply_text(
                    f"🎤 _Escutei:_ {texto_transcrito}",
                    parse_mode='Markdown'
                )
                
                await context.bot.send_chat_action(chat_id=update.effective_chat.id, action='typing')
                ia_response = self.agent.process_message(texto_transcrito)
                
                await context.bot.send_chat_action(chat_id=update.effective_chat.id, action='record_voice')
                audio_resposta = await self.voice_service.generate_speech(ia_response)
                
                if audio_resposta:
                    await update.message.reply_voice(voice=audio_resposta)
                else:
                    await update.message.reply_text(ia_response)
                    
        except Exception as e:
            logger.error(f"Erro no processamento do áudio: {e}")
            await update.message.reply_text("Desculpe, tive um erro ao processar seu áudio. Tente novamente!")

    def run(self):
        """Inicia o Bot (Polling + Serviços em Background)"""
        logger.info("Valkyrie Telegram Bot - Conectando à API...")
        app = ApplicationBuilder().token(self.token).build()

        # Registro dos Handlers
        app.add_handler(CommandHandler("start", self.start))
        app.add_handler(MessageHandler(filters.TEXT & (~filters.COMMAND), self.handle_message))
        app.add_handler(MessageHandler(filters.VOICE, self.handle_voice))
        
        # Inicia WhatsApp Gateway listener
        from src.api.webhook import start_webhook_listener
        logger.info("Ligando a escuta do WhatsApp Gateway (Porta 5000)...")
        start_webhook_listener(self.agent)
        
        # Inicia serviço de lembretes proativos
        token_path = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), 'token.json')
        if os.path.exists(token_path) and self.owner_chat_id:
            from src.services.reminder_service import ReminderService
            reminder = ReminderService(app, self.voice_service, self.owner_chat_id)
            reminder.start()
            logger.info("ReminderService ativo — alertas de voz 60 e 20 minutos antes dos eventos.")
        
        logger.info("Bot Online! Todos os sistemas operacionais.")
        app.run_polling()
