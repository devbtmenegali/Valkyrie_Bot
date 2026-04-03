import os
import sys
from dotenv import load_dotenv
from core.agent import ValkyrieAgent
from src.bot.telegram_bot import ValkyrieTelegramBot

def main():
    # Carrega variáveis de ambiente do arquivo .env
    load_dotenv()
    
    # Verifica se a chave da API do Google está presente
    if not os.getenv("GOOGLE_API_KEY"):
        print("Erro: GOOGLE_API_KEY não encontrada no ambiente.")
        print("Por favor, configure o arquivo .env ou exporte a variável de ambiente.")
        sys.exit(1)

    # Verifica o método de inicialização: Telegram ou Terminal
    if os.getenv("TELEGRAM_BOT_TOKEN"):
        print("Token do Telegram encontrado. Iniciando servidor do Bot...")
        bot = ValkyrieTelegramBot()
        bot.run()
    else:
        print("Token do Telegram não encontrado. Iniciando no modo Terminal.")
        print("Inicializando Valkyrie...")
        agent = ValkyrieAgent()
        
        print("\n" + "="*50)
        print("Valkyrie Online (Terminal). Digite 'sair' para encerrar.")
        print("="*50 + "\n")
        
        while True:
            try:
                user_input = input("Você: ")
                if user_input.lower() in ['sair', 'exit', 'quit']:
                    print("Valkyrie: Desligando. Até logo!")
                    break
                    
                if not user_input.strip():
                    continue
                    
                response = agent.process_message(user_input)
                print(f"\nValkyrie: {response}\n")
                
            except KeyboardInterrupt:
                print("\nValkyrie: Desligando. Até logo!")
                break
            except Exception as e:
                print(f"\nValkyrie encontrou um erro: {e}\n")

if __name__ == "__main__":
    main()
