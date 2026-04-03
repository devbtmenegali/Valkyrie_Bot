import os
import logging
from io import BytesIO
import re
from openai import AsyncOpenAI

logger = logging.getLogger(__name__)

class ValkyrieVoiceService:
    def __init__(self):
        self.api_key = os.getenv("OPENAI_API_KEY")
        if not self.api_key:
            logger.warning("OPENAI_API_KEY não foi encontrada. Sintetização/Transcrição desabilitada.")
            self.client = None
        else:
            self.client = AsyncOpenAI(api_key=self.api_key)

    async def transcribe_audio(self, audio_bytes: bytes, file_name: str = "voice.ogg") -> str:
        """Transcreve um áudio do Telegram para texto usando o Whisper"""
        if not self.client:
            return "Erro: OPENAI_API_KEY ausente para processamento de voz."
            
        try:
            # Cria um buffer amigável para a OpenAI
            audio_io = BytesIO(audio_bytes)
            audio_io.name = file_name
            
            transcript = await self.client.audio.transcriptions.create(
                model="whisper-1", 
                file=audio_io
            )
            return transcript.text
        except Exception as e:
            logger.error(f"Erro na transcrição Whisper: {e}")
            return f"Erro ao transcrever áudio: {str(e)}"

    async def generate_speech(self, text: str) -> BytesIO:
        """Gera um áudio de resposta com a voz corporativa feminina"""
        if not self.client:
            return None
            
        try:
            # Limpeza cirúrgica de marcação Markdown típica de IAs
            clean_text = text.replace('*', '').replace('_', '').replace('#', '')
            clean_text = re.sub(r'[\U00010000-\U0010ffff]', '', clean_text)
            
            truncated_text = clean_text[:4000]
            if not truncated_text.strip():
                return None
                
            response = await self.client.audio.speech.create(
                model="tts-1",
                voice="nova", # Voz Executiva Feminina
                input=truncated_text,
                response_format="opus"
            )
            
            audio_io = BytesIO(response.content)
            audio_io.name = "valkyrie_voice.ogg"
            return audio_io
            
        except Exception as e:
            logger.error(f"Erro ao sintetizar voz TTS: {e}")
            return None
