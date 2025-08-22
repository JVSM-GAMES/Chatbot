import express from "express";
import Pino from "pino";
import { makeWASocket, DisconnectReason } from "@whiskeysockets/baileys";
import { menus } from "./sessionHandler.mjs";

const app = express();
const logger = Pino({ level: "info" });

const sessions = {}; // Sessões por número do cliente

// Cria ou reseta a sessão
function getSession(clientId) {
    if (!sessions[clientId]) {
        sessions[clientId] = {
            currentMenu: menus.atendimentoMenu,
            timeout: null,
            warning: null
        };
    }
    return sessions[clientId];
}

// Reseta sessão após 10 minutos
function startInactivityTimers(clientId, sock) {
    const session = sessions[clientId];
    if (session.warning) clearTimeout(session.warning);
    if (session.timeout) clearTimeout(session.timeout);

    session.warning = setTimeout(() => {
        sock.sendMessage(clientId, { text: "Atenção: seu atendimento será encerrado em 5 minutos por inatividade." });
    }, 5 * 60 * 1000);

    session.timeout = setTimeout(() => {
        sessions[clientId] = undefined;
    }, 10 * 60 * 1000);
}

// Função de processamento de mensagens
async function processMessage(clientId, msg, sock) {
    const session = getSession(clientId);
    startInactivityTimers(clientId, sock);

    const response = await session.currentMenu.handleInput(msg, session);
    if (response?.msg) {
        await sock.sendMessage(clientId, { text: response.msg });
    }
}

// Inicialização do bot
async function startWA() {
    const sock = makeWASocket({ printQRInTerminal: true });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue;
            const clientId = m.key.remoteJid;
            const text = m.message.conversation || "";
            await processMessage(clientId, text, sock);
        }
    });

    sock.ev.on("connection.update", (update) => {
        if (update.connection === "close" && update.lastDisconnect?.error?.output?.statusCode !== 401) {
            startWA(); // Reconnect
        }
    });

    return sock;
}

startWA();

app.get("/qr", (req, res) => {
    res.send("<h1>QR Code será exibido no terminal</h1>");
});

app.listen(process.env.PORT || 10000, () => logger.info({ PORT: process.env.PORT || 10000, msg: "HTTP server online" }));
