import os
import logging
from datetime import datetime, timedelta
from typing import Optional
from langchain.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
]

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN_FILE = os.path.join(BASE_DIR, 'token.json')
CREDENTIALS_FILE = os.path.join(BASE_DIR, 'credentials.json')


def get_google_credentials():
    """Obtém credenciais Google válidas do token salvo."""
    from google.oauth2.credentials import Credentials
    from google.auth.transport.requests import Request
    
    creds = None
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            with open(TOKEN_FILE, 'w') as token:
                token.write(creds.to_json())
        except Exception as e:
            logger.error(f"Erro ao renovar token: {e}")
            return None
    
    return creds if (creds and creds.valid) else None


def get_calendar_service():
    from googleapiclient.discovery import build
    creds = get_google_credentials()
    if not creds:
        return None
    return build('calendar', 'v3', credentials=creds)


# ─── CREATE EVENT ───────────────────────────────────────────────────────────
class CreateEventInput(BaseModel):
    title: str = Field(description="Título do evento/reunião")
    date: str = Field(description="Data no formato DD/MM/YYYY ou 'amanhã', 'segunda-feira', etc.")
    time: str = Field(description="Horário de início no formato HH:MM (ex: 14:00)")
    duration_minutes: int = Field(default=60, description="Duração em minutos. Padrão: 60")
    description: str = Field(default="", description="Descrição ou pauta do evento")
    attendees: Optional[str] = Field(default="", description="E-mails dos participantes separados por vírgula")


class CreateCalendarEventTool(BaseTool):
    name: str = "create_calendar_event"
    description: str = (
        "Cria um evento no Google Calendar do usuário. Use quando o usuário pedir para criar uma reunião, "
        "compromisso ou quando detectar menção de reunião em WhatsApp ou e-mail. "
        "Exemplos: 'reunião com fornecedor sexta às 14h', 'call amanhã às 10h'."
    )
    args_schema: type = CreateEventInput

    def _run(self, title: str, date: str, time: str, duration_minutes: int = 60,
             description: str = "", attendees: str = "") -> str:
        try:
            service = get_calendar_service()
            if not service:
                return "❌ Google Calendar não autorizado. Execute: python3 scripts/setup_google_auth.py"
            
            # Resolve a data
            event_date = self._parse_date(date)
            start_dt = datetime.strptime(f"{event_date} {time}", "%Y-%m-%d %H:%M")
            end_dt = start_dt + timedelta(minutes=duration_minutes)
            
            event_body = {
                'summary': title,
                'description': description,
                'start': {
                    'dateTime': start_dt.isoformat(),
                    'timeZone': 'America/Sao_Paulo',
                },
                'end': {
                    'dateTime': end_dt.isoformat(),
                    'timeZone': 'America/Sao_Paulo',
                },
                'reminders': {
                    'useDefault': False,
                    'overrides': [
                        {'method': 'popup', 'minutes': 60},
                        {'method': 'popup', 'minutes': 20},
                    ],
                },
            }
            
            # Participantes
            if attendees:
                emails = [e.strip() for e in attendees.split(',') if e.strip()]
                event_body['attendees'] = [{'email': e} for e in emails]
            
            event = service.events().insert(calendarId='primary', body=event_body).execute()
            
            date_formatted = start_dt.strftime("%d/%m/%Y às %H:%M")
            logger.info(f"Evento criado: {title} em {date_formatted}")
            return f"✅ Evento criado: **{title}** — {date_formatted} ({duration_minutes}min)\n🔗 {event.get('htmlLink', '')}"
        
        except Exception as e:
            logger.error(f"Erro ao criar evento: {e}")
            return f"❌ Erro ao criar evento: {str(e)}"

    def _parse_date(self, date_str: str) -> str:
        """Converte datas em linguagem natural para YYYY-MM-DD."""
        today = datetime.now()
        date_lower = date_str.lower().strip()
        
        if date_lower in ['hoje', 'today']:
            return today.strftime("%Y-%m-%d")
        if date_lower in ['amanhã', 'amanha', 'tomorrow']:
            return (today + timedelta(days=1)).strftime("%Y-%m-%d")
        
        weekdays_pt = {
            'segunda': 0, 'segunda-feira': 0,
            'terça': 1, 'terca': 1, 'terça-feira': 1,
            'quarta': 2, 'quarta-feira': 2,
            'quinta': 3, 'quinta-feira': 3,
            'sexta': 4, 'sexta-feira': 4,
            'sábado': 5, 'sabado': 5,
            'domingo': 6
        }
        
        for day_name, day_num in weekdays_pt.items():
            if day_name in date_lower:
                days_ahead = (day_num - today.weekday()) % 7
                if days_ahead == 0:
                    days_ahead = 7
                return (today + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
        
        # Tenta DD/MM/YYYY
        for fmt in ["%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"]:
            try:
                return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        
        # Fallback: usa amanhã
        return (today + timedelta(days=1)).strftime("%Y-%m-%d")


# ─── LIST UPCOMING ───────────────────────────────────────────────────────────
class ListEventsInput(BaseModel):
    max_results: int = Field(default=5, description="Número máximo de eventos para listar")


class ListUpcomingEventsTool(BaseTool):
    name: str = "list_upcoming_events"
    description: str = (
        "Lista os próximos eventos/reuniões do Google Calendar do usuário. "
        "Use quando perguntado sobre 'o que tenho hoje', 'minha agenda', 'próximas reuniões'."
    )
    args_schema: type = ListEventsInput

    def _run(self, max_results: int = 5) -> str:
        try:
            service = get_calendar_service()
            if not service:
                return "❌ Google Calendar não autorizado. Execute: python3 scripts/setup_google_auth.py"
            
            now = datetime.utcnow().isoformat() + 'Z'
            events_result = service.events().list(
                calendarId='primary',
                timeMin=now,
                maxResults=max_results,
                singleEvents=True,
                orderBy='startTime'
            ).execute()
            
            events = events_result.get('items', [])
            if not events:
                return "📅 Nenhum evento próximo encontrado na agenda."
            
            lines = ["📅 **Próximos eventos:**"]
            for event in events:
                start = event['start'].get('dateTime', event['start'].get('date'))
                try:
                    dt = datetime.fromisoformat(start.replace('Z', '+00:00'))
                    formatted = dt.astimezone().strftime("%d/%m %H:%M")
                except:
                    formatted = start
                lines.append(f"• {event['summary']} — {formatted}")
            
            return "\n".join(lines)
        
        except Exception as e:
            logger.error(f"Erro ao listar eventos: {e}")
            return f"❌ Erro ao consultar agenda: {str(e)}"
