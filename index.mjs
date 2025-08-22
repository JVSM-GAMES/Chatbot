import * as baileys from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import Pino from "pino";
import fs from "fs";

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys;

const app = express();
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeData = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 3;
let reconnectTimeout = null;
const AUTH_FOLDER = "baileys_auth_info";

async function startSock(forceNewAuth = false) {
  if (sock?.ws?.readyState === 1) return; // Já conectado

  if (forceNewAuth && fs.existsSync(AUTH_FOLDER)) {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    console.log("🗑️ Credenciais antigas removidas.");
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);

  sock = makeWASocket({
    logger: Pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      reconnectAttempts = 0;
      console.log("📲 Novo QR gerado!");
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      qrCodeData = null;
      reconnectAttempts = 0;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT) {
          console.log(`🔄 Tentando reconectar... (${reconnectAttempts}/${MAX_RECONNECT})`);
          reconnectTimeout = setTimeout(() => startSock(), 5000);
        } else {
          console.log("⚠️ Muitas tentativas falhadas. Descarta auth e aguardando novo QR...");
          reconnectAttempts = 0;
          startSock(true); // força gerar nova sessão
        }
      } else {
        console.log("🚫 Sessão encerrada manualmente ou logout detectado.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Rotas
app.get("/", (req, res) => {
  if (sock?.ws?.readyState === 1) {
    res.send(`
      <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>✅ Conectado ao WhatsApp!</h2>
          <a href="/qr">Ver QR Code</a>
          <button onclick="disconnect()" style="margin-top:20px;padding:10px 20px;">Desconectar</button>
          <script>
            async function disconnect() {
              await fetch('/disconnect');
              alert('Desconectado! Atualize a página para gerar novo QR.');
            }
          </script>
        </body>
      </html>
    `);
  } else {
    res.redirect("/qr");
  }
});

app.get("/qr", (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head><title>QR Code WhatsApp</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>Escaneie o QR para conectar</h2>
          <img src="${qrCodeData}" />
          <a href="/">Voltar</a>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><title>QR Code WhatsApp</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>⌛ Aguardando conexão...</h2>
          <a href="/">Voltar</a>
        </body>
      </html>
    `);
  }
});

app.get("/disconnect", async (req, res) => {
  if (sock) {
    await sock.logout();
    qrCodeData = null;
    reconnectAttempts = 0;
    console.log("🚪 Logout realizado manualmente.");
    startSock(true); // força gerar novo QR após logout
  }
  res.send("Desconectado!");
});

// Inicia servidor
app.listen(PORT, () => {
  console.log("🌐 Servidor rodando na porta " + PORT);
});

// Inicia socket
startSock();
