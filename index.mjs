import * as baileys from "@whiskeysockets/baileys"
import express from "express"
import qrcode from "qrcode"
import Pino from "pino"

const { makeWASocket, useMultiFileAuthState, DisconnectReason } = baileys

const app = express();
const PORT = process.env.PORT || 3000;

let sock;
let qrCodeData = null;
let reconnectAttempts = 0;
const MAX_RECONNECT = 7;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState("baileys_auth_info");

  sock = makeWASocket({
    logger: Pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      reconnectAttempts = 0; // reset ao gerar novo qr
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      qrCodeData = null;
      reconnectAttempts = 0;
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;

      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        reconnectAttempts++;
        if (reconnectAttempts <= MAX_RECONNECT) {
          console.log(`🔄 Tentando reconectar... (${reconnectAttempts}/${MAX_RECONNECT})`);
          startSock();
        } else {
          console.log("⚠️ Muitas tentativas falhadas. Gerando novo QR...");
          qrCodeData = null;
          reconnectAttempts = 0;
          startSock();
        }
      } else {
        console.log("🚫 Sessão encerrada manualmente ou logout detectado.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
}

app.get("/", (req, res) => {
  if (qrCodeData) {
    res.send(`
      <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>Escaneie o QR para conectar</h2>
          <img src="${qrCodeData}" />
          <button onclick="disconnect()" style="margin-top:20px;padding:10px 20px;">Desconectar</button>
          <script>
            async function disconnect() {
              await fetch('/disconnect');
              document.querySelector('button').remove(); // remove botão
              location.reload(); // força recarregar e exibir novo QR
            }
          </script>
        </body>
      </html>
    `);
  } else {
    res.send(`
      <html>
        <head><title>WhatsApp Bot</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
          <h2>✅ Conectado ao WhatsApp!</h2>
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
    startSock();
  }
  res.send("Desconectado!");
});

app.listen(PORT, () => {
  console.log("🌐 Servidor rodando na porta " + PORT);
});

startSock();
