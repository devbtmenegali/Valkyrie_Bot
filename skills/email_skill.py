import os
import smtplib
from email.message import EmailMessage
from typing import Optional, Type
from pydantic import BaseModel, Field
from langchain.tools import BaseTool

class EmailInput(BaseModel):
    to_email: str = Field(description="Endereço de e-mail do destinatário. (Obrigatório)")
    subject: str = Field(description="Assunto do e-mail.")
    body: str = Field(description="Corpo/conteúdo da mensagem (texto plano).")

class SendEmailTool(BaseTool):
    name: str = "send_email_tool"
    description: str = (
        "Use esta ferramenta para enviar um e-mail para alguém. "
        "Você precisará fornecer o e-mail do destinatário, o assunto e o corpo da mensagem."
    )
    args_schema: Type[BaseModel] = EmailInput
    
    # Credenciais do SMTP que virão do arquivo .env
    smtp_server: str = "smtp.gmail.com"
    smtp_port: int = 587
    
    def _run(self, to_email: str, subject: str, body: str) -> str:
        """Executa a rotina de envio de e-mail estruturada para a Valkyrie."""
        
        email_user = os.getenv("EMAIL_USER")
        email_password = os.getenv("EMAIL_PASSWORD") # Preferencialmente App Password (Senha de App) no Google
        
        if not email_user or not email_password:
            return "Erro: Credenciais de E-mail (EMAIL_USER / EMAIL_PASSWORD) não estão configuradas nas variáveis de ambiente."

        msg = EmailMessage()
        msg['Subject'] = subject
        msg['From'] = email_user
        msg['To'] = to_email
        msg.set_content(body)

        try:
            with smtplib.SMTP(self.smtp_server, self.smtp_port) as server:
                server.starttls()
                server.login(email_user, email_password)
                server.send_message(msg)
            return f"E-mail enviado com sucesso para {to_email}."
        except Exception as e:
            return f"Falha ao enviar e-mail: {str(e)}"

    def _arun(self, **kwargs):
        raise NotImplementedError("Método assíncrono não implementado")
