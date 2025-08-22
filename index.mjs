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
let clients = [];
let reconnectTimeout = null;
let isStarting = false;

async function startSock(forceNewAuth = false) {
  if (isStarting) return;
  isStarting = true;

  if (sock?.ws?.readyState === 1) {
    isStarting = false;
    return; // já conectado
  }

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
      notifyClients(qrCodeData);
      console.log("📲 Novo QR gerado!");
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      qrCodeData = null;
      notifyClients(null);
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut &&
        fs.existsSync(AUTH_FOLDER);

      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => startSock(), 5000);
      } else {
        console.log("⚠️ Sessão encerrada ou inválida. Aguardando novo QR...");
        qrCodeData = null;
        notifyClients(null);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  isStarting = false;
}

function notifyClients(qr) {
  clients.forEach((res) => {
    res.write(`data: ${JSON.stringify({ qr })}\n\n`);
  });
}

// Página principal
app.get("/", (req, res) => {
  res.redirect("/qr");
});

// Página com QR dinâmico
app.get("/qr", (req, res) => {
  res.send(`
    <html>
      <head><title>QR Code WhatsApp</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h2 id="status">Aguardando QR...</h2>
        <img id="qr" style="width:300px; margin-top:20px;" />
        <a href="/" style="margin-top:20px;">Voltar</a>
        <script>
          const qrImg = document.getElementById('qr');
          const statusText = document.getElementById('status');
          const evtSource = new EventSource('/events');

          evtSource.onmessage = function(event) {
            const data = JSON.parse(event.data);
            if (data.qr) {
              qrImg.src = data.qr;
              qrImg.style.display = "block";
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

// SSE para atualização do QR
app.get("/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  clients.push(res);
  console.log("📡 Novo cliente SSE conectado.");

  // Se já temos QR, envia imediatamente
  if (qrCodeData) {
    res.write(`data: ${JSON.stringify({ qr: qrCodeData })}\n\n`);
  }

  req.on("close", () => {
    clients = clients.filter((client) => client !== res);
    console.log("❌ Cliente SSE desconectado.");
  });
});

app.get("/disconnect", async (req, res) => {
  if (sock) {
    await sock.logout();
    qrCodeData = null;
    console.log("🚪 Logout manual.");
    startSock(true); // força gerar novo QR
  }
  res.send("Desconectado!");
});

// Inicia servidor
app.listen(PORT, () => {
  console.log("🌐 Servidor rodando na porta " + PORT);
});

// Inicia socket
startSock();
