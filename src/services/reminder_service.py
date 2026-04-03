import os
import logging
import asyncio
from datetime import datetime, timedelta, timezone
from apscheduler.schedulers.background import BackgroundScheduler
from skills.calendar_skill import get_calendar_service

logger = logging.getLogger(__name__)

# Rastreia alertas já enviados para não duplicar
_alerted_events = set()


class ReminderService:
    def __init__(self, telegram_bot_app, voice_service, chat_id: str):
        """
        telegram_bot_app: instância do Application do python-telegram-bot
        voice_service: instância do ValkyrieVoiceService (para TTS)
        chat_id: ID do chat do Telegram para enviar os lembretes
        """
        self.app = telegram_bot_app
        self.voice_service = voice_service
        self.chat_id = chat_id
        self.scheduler = BackgroundScheduler(timezone="America/Sao_Paulo")

    def start(self):
        """Inicia o scheduler de lembretes em background."""
        self.scheduler.add_job(
            self._check_upcoming_events,
            trigger='interval',
            minutes=10,
            id='reminder_check',
            replace_existing=True
        )
        self.scheduler.start()
        logger.info("ReminderService iniciado — verificando agenda a cada 10 minutos.")

    def stop(self):
        self.scheduler.shutdown(wait=False)

    def _check_upcoming_events(self):
        """Verifica eventos próximos e envia alertas de voz."""
        try:
            service = get_calendar_service()
            if not service:
                logger.warning("ReminderService: Google Calendar não autorizado.")
                return

            now_utc = datetime.now(timezone.utc)
            window_end = now_utc + timedelta(hours=2)

            events_result = service.events().list(
                calendarId='primary',
                timeMin=now_utc.isoformat(),
                timeMax=window_end.isoformat(),
                singleEvents=True,
                orderBy='startTime'
            ).execute()

            events = events_result.get('items', [])

            for event in events:
                event_id = event['id']
                title = event.get('summary', 'Evento sem título')
                start_str = event['start'].get('dateTime', event['start'].get('date'))

                try:
                    start_dt = datetime.fromisoformat(start_str.replace('Z', '+00:00'))
                except:
                    continue

                minutes_until = (start_dt - now_utc).total_seconds() / 60

                # Alerta de 60 minutos
                alert_key_60 = f"{event_id}_60"
                if 55 <= minutes_until <= 65 and alert_key_60 not in _alerted_events:
                    _alerted_events.add(alert_key_60)
                    time_str = start_dt.astimezone().strftime("%H:%M")
                    msg = f"Bruno, daqui a 1 hora você tem: {title}, às {time_str}. Posso te ajudar com alguma preparação?"
                    self._send_voice_alert(msg)
                    logger.info(f"Alerta 60min enviado: {title}")

                # Alerta de 20 minutos
                alert_key_20 = f"{event_id}_20"
                if 15 <= minutes_until <= 25 and alert_key_20 not in _alerted_events:
                    _alerted_events.add(alert_key_20)
                    time_str = start_dt.astimezone().strftime("%H:%M")
                    msg = f"Atenção, Bruno! Sua reunião '{title}' começa em 20 minutos, às {time_str}. Boa reunião!"
                    self._send_voice_alert(msg)
                    logger.info(f"Alerta 20min enviado: {title}")

        except Exception as e:
            logger.error(f"Erro no ReminderService: {e}")

    def _send_voice_alert(self, text: str):
        """Gera áudio TTS e envia via Telegram de forma assíncrona."""
        async def _send():
            try:
                audio_bytes = await self.voice_service.generate_speech(text)
                if audio_bytes:
                    await self.app.bot.send_voice(
                        chat_id=self.chat_id,
                        voice=audio_bytes,
                        caption=f"🔔 {text}"
                    )
                else:
                    await self.app.bot.send_message(
                        chat_id=self.chat_id,
                        text=f"🔔 {text}"
                    )
            except Exception as e:
                logger.error(f"Erro ao enviar alerta de voz: {e}")

        # Roda o coroutine assíncrono a partir da thread do scheduler
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                asyncio.run_coroutine_threadsafe(_send(), loop)
            else:
                asyncio.run(_send())
        except RuntimeError:
            import threading
            def run_in_new_loop():
                new_loop = asyncio.new_event_loop()
                asyncio.set_event_loop(new_loop)
                new_loop.run_until_complete(_send())
                new_loop.close()
            threading.Thread(target=run_in_new_loop, daemon=True).start()
