# Valkyrie — Integração WhatsApp (Evolution API)

Integração leve em Node.js **sem dependências externas** para enviar briefings/alertas da Valkyrie e receber ideias direto no `kanban-backlog.md`.

## 1. Configurar credenciais
Copie `.env.example` para `.env` e preencha os dados da sua instância da Evolution API:

```bash
cp whatsapp/.env.example whatsapp/.env
```

Preencha:
- `EVOLUTION_API_URL`: URL da sua Evolution API (ex.: `https://evo.seudominio.com`)
- `EVOLUTION_API_KEY`: API Key da instância/servidor
- `EVOLUTION_INSTANCE`: nome da instância conectada via QR Code
- `BRUNO_WHATSAPP_NUMBER`: seu número com DDI+DDD (ex.: `5548999999999`)

## 2. Testar envio (Briefing -> WhatsApp)
```bash
node whatsapp/send.mjs "Valkyrie online no WhatsApp!"
```

## 3. Ativar recepção de ideias (WhatsApp -> Kanban)
```bash
node whatsapp/webhook.mjs
```
Na Evolution API, configure o webhook de `MESSAGES_UPSERT` apontando para `/webhook/evolution` (usando um túnel como Cloudflare Tunnel / ngrok se rodar local, ou no mesmo servidor da Evolution API).

