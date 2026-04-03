"""
Script de autorização OAuth para Google Calendar e Gmail.
Rode apenas UMA VEZ: python3 scripts/setup_google_auth.py
"""
import os
import sys

# Adiciona o diretório raiz ao path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
import pickle

# Escopos necessários para Calendar + Gmail
SCOPES = [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.modify',
]

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CREDENTIALS_FILE = os.path.join(BASE_DIR, 'credentials.json')
TOKEN_FILE = os.path.join(BASE_DIR, 'token.json')

def authorize():
    creds = None
    
    if os.path.exists(TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)
    
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            if not os.path.exists(CREDENTIALS_FILE):
                print(f"❌ ERRO: Arquivo credentials.json não encontrado em {CREDENTIALS_FILE}")
                print("Baixe-o do Google Cloud Console e coloque na pasta do projeto.")
                sys.exit(1)
            
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_FILE, SCOPES)
            creds = flow.run_local_server(port=0)
        
        # Salva o token para uso futuro
        with open(TOKEN_FILE, 'w') as token:
            token.write(creds.to_json())
    
    print("✅ Autorização Google concluída com sucesso!")
    print(f"Token salvo em: {TOKEN_FILE}")
    return creds

if __name__ == '__main__':
    print("Iniciando autorização do Google (Calendar + Gmail)...")
    print("Uma janela do navegador será aberta. Faça login com brunotmenegali@gmail.com")
    authorize()
