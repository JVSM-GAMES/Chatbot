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
const AUTH_FOLDER = "baileys_auth_info";

// Lista de conexões SSE
let clients = [];

async function startSock(forceNewAuth = false) {
  if (sock?.ws?.readyState === 1) return;

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
      notifyClients(qrCodeData); // envia QR para todos conectados via SSE
      console.log("📲 Novo QR gerado!");
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      qrCodeData = null;
      notifyClients(null); // remove QR do front
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut &&
        fs.existsSync(AUTH_FOLDER); // só tenta reconectar se tiver auth salva

      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        setTimeout(() => startSock(), 5000);
      } else {
        console.log("🚫 Sessão encerrada ou sem credenciais.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

// Envia QR via SSE para todos conectados
function notifyClients(qr) {
  clients.forEach((res) => {
    res.write(`data: ${JSON.stringify({ qr })}\n\n`);
  });
}

// Rotas
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head><title>WhatsApp Bot</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h2>Status do Bot</h2>
        <img id="qr" style="width:300px;" />
        <p id="status">Aguardando QR...</p>
        <script>
          const qrImg = document.getElementById('qr');
          const statusText = document.getElementById('status');
          const evtSource = new EventSource('/events');

          evtSource.onmessage = function(event) {
            const data = JSON.parse(event.data);
            if (data.qr) {
              qrImg.src = data.qr;
              statusText.textContent = "Escaneie o QR para conectar";
            } else {
              qrImg.style.display = "none";
              statusText.textContent = "✅ Conectado ao WhatsApp!";
            }
          };
        </script>
      </body>
    </html>
  `);
});

// Endpoint SSE para atualização em tempo real
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.push(res);
  console.log("📡 Novo cliente SSE conectado.");

  req.on("close", () => {
    clients = clients.filter((client) => client !== res);
    console.log("❌ Cliente SSE desconectado.");
  });
});

app.get("/disconnect", async (req, res) => {
  if (sock) {
    await sock.logout();
    qrCodeData = null;
    console.log("🚪 Logout realizado manualmente.");
    startSock(true);
  }
  res.send("Desconectado!");
});

// Inicia servidor
app.listen(PORT, () => {
  console.log("🌐 Servidor rodando na porta " + PORT);
});

// Inicia socket
startSock();
