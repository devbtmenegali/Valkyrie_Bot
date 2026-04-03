const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');

const app = express();
app.use(express.json());

const VALKYRIE_WEBHOOK_URL = 'http://127.0.0.1:5000/webhook/whatsapp';
const GATEWAY_PORT = 5001; // Porta para receber comandos de envio da Valkyrie

console.log("Inicializando Valkyrie WhatsApp Gateway...");

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-extensions']
    }
});

// ─── QR CODE ──────────────────────────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('\n======================================================');
    console.log('📱 VINCULAÇÃO WHATSAPP VALKYRIE SOLICITADA 📱');
    console.log('Escaneie o QR Code abaixo com o WhatsApp do aparelho:');
    qrcode.generate(qr, { small: true });
    console.log('======================================================\n');
});

client.on('ready', () => {
    console.log('✅ Valkyrie WhatsApp Worker ONLINE e Pareado!');
    console.log('Escutando ativamente chats e grupos...');
    console.log(`📡 Endpoint de envio disponível em: http://localhost:${GATEWAY_PORT}/send`);
});

// ─── RECEBER MENSAGENS → PYTHON ────────────────────────────────────────────
client.on('message', async msg => {
    if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;

    const chat = await msg.getChat();

    const payload = {
        id: msg.id._serialized,
        body: msg.body,
        from: msg.from,
        author: msg.author || msg.from,
        chatId: msg.from,          // ID real do chat (grupo ou contato)
        timestamp: msg.timestamp,
        isGroup: chat.isGroup,
        groupName: chat.name || msg.from
    };

    console.log(`[WHATSAPP ✉️] ${chat.isGroup ? '👥' : '👤'} ${payload.groupName} | ${payload.author}: ${msg.body.substring(0, 60)}`);

    try {
        await axios.post(VALKYRIE_WEBHOOK_URL, payload);
    } catch (error) {
        console.log(`[!] Python não está escutando ainda — rode python3 main.py primeiro.`);
    }
});

// ─── ENDPOINT DE ENVIO (Python → Node → WhatsApp) ─────────────────────────
app.post('/send', async (req, res) => {
    const { chatId, message } = req.body;
    
    console.log(`[RECEBIDO PEDIDO DE ENVIO] chatId: "${chatId}" | message length: ${message?.length}`);

    if (!chatId || !message) {
        return res.status(400).json({ error: 'chatId e message são obrigatórios' });
    }

    try {
        await client.sendMessage(chatId, message);
        console.log(`[VALKYRIE ENVIOU ✅] Para: ${chatId} | Mensagem: ${message.substring(0, 60)}`);
        res.json({ status: 'sent', chatId, message });
    } catch (error) {
        // Pega tanto o error.message quanto o stack de erro caso não seja um objeto padrão
        const errorDetail = error.message ? error.message : JSON.stringify(error);
        console.error(`[ERRO ENVIO ❌] Tentativa para: "${chatId}" | Detalhe: ${errorDetail}`);
        res.status(500).json({ error: errorDetail });
    }
});

// ─── ENDPOINT DE LISTAR GRUPOS E CHATS ABERTOS ──────────────────────────────
app.get('/chats', async (req, res) => {
    try {
        const chats = await client.getChats();
        const result = chats.map(c => ({
            name: c.name,
            id: c.id._serialized,
            isGroup: c.isGroup
        }));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── ENDPOINT DE LISTAR CONTATOS DA AGENDA ──────────────────────────────────
app.get('/contacts', async (req, res) => {
    try {
        const contacts = await client.getContacts();
        const result = contacts
            .filter(c => c.isMyContact) // Apenas contatos salvos
            .map(c => ({
                name: c.name,
                pushname: c.pushname,
                id: c.id._serialized
            }));
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Inicia o servidor Express
app.listen(GATEWAY_PORT, () => {
    console.log(`🚀 Gateway de envio rodando na porta ${GATEWAY_PORT}`);
});

// Inicializando motor WhatsApp
client.initialize();
