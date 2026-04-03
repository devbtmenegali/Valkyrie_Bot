import asyncio
from dotenv import load_dotenv
load_dotenv()
from core.agent import ValkyrieAgent
agent = ValkyrieAgent()
print(agent.process_message("Valkyrie, o que você está programada para fazer hoje?"))
