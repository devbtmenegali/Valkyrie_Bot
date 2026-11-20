FROM node:22-slim

# Instala Python + edge-tts para voz neural pt-BR-ThalitaMultilingualNeural na nuvem
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
  && pip3 install --no-cache-dir --break-system-packages edge-tts \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json AGENTS.md kanban-backlog.md habit-tracker.md ./
COPY app/ ./app/
COPY whatsapp/ ./whatsapp/
COPY supabase/ ./supabase/

# Remove quaisquer arquivos locais sensíveis caso existam no contexto de build
RUN rm -rf app/.env app/.venv app/chat-history.json app/whatsapp-inbox.json app/memory.json whatsapp/.env

ENV NODE_ENV=production
ENV PORT=3780
EXPOSE 3780

CMD ["node", "app/server.mjs"]

