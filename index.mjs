import * as baileys from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import Pino from "pino";

const { makeWASocket, DisconnectReason, initAuthCreds, BufferJSON } = baileys;

const app = express();
const PORT = process.env.PORT || 3000;

let sock = null;
let qrCodeData = null;
let authState = { creds: initAuthCreds(), keys: {} }; // auth em memória
let clients = [];
let reconnectTimeout = null;
let isStarting = false;

function getAuthState() {
  return {
    state: authState,
    saveCreds: async () => {
      // Aqui não salva em arquivo, apenas mantém em memória
      console.log("💾 Credenciais atualizadas em memória.");
    },
  };
}

async function startSock(forceNewAuth = false) {
  if (isStarting) return;
  isStarting = true;

  if (sock?.ws?.readyState === 1) {
    isStarting = false;
    return; // já conectado
  }

  if (forceNewAuth) {
    authState = { creds: initAuthCreds(), keys: {} }; // limpa credenciais
    console.log("🗑️ Credenciais antigas removidas (memória).");
  }

  const { state, saveCreds } = getAuthState();

  sock = makeWASocket({
    logger: Pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrCodeData = await qrcode.toDataURL(qr);
      notifyClients(qrCodeData, "Escaneie o QR para conectar");
      console.log("📲 Novo QR gerado!");
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      qrCodeData = null;
      notifyClients(null, "✅ Conectado ao WhatsApp!");
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut &&
        authState?.creds?.me; // só reconecta se já tinha sessão válida

      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect);

      if (shouldReconnect) {
        if (reconnectTimeout) clearTimeout(reconnectTimeout);
        reconnectTimeout = setTimeout(() => startSock(), 5000);
      } else {
        console.log("⚠️ Sessão inválida ou logout. Aguardando novo QR...");
        qrCodeData = null;
        notifyClients(null, "Sessão caiu (Render pode ter hibernado). Escaneie o novo QR.");
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  isStarting = false;
}

// Envia QR + status via SSE
function notifyClients(qr, statusMsg) {
  clients.forEach((res) => {
    res.write(`data: ${JSON.stringify({ qr, status: statusMsg })}\n\n`);
  });
}

// Página QR dinâmica
app.get("/qr", (req, res) => {
  res.send(`
    <html>
      <head><title>QR Code WhatsApp</title></head>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;">
        <h2 id="status">Carregando...</h2>
        <img id="qr" style="width:300px; margin-top:20px;" />
        <button onclick="fetch('/new-qr').then(()=>alert('Novo QR solicitado'))" 
                style="margin-top:20px;padding:10px 20px;">Gerar novo QR</button>
        <script>
          const qrImg = document.getElementById('qr');
          const statusText = document.getElementById('status');
          const evtSource = new EventSource('/events');

          evtSource.onmessage = function(event) {
            const data = JSON.parse(event.data);
            if (data.qr) {
              qrImg.src = data.qr;
              qrImg.style.display = "block";
            } else {
              qrImg.style.display = "none";
            }
            statusText.textContent = data.status || "";
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

  req.on("close", () => {
    clients = clients.filter((client) => client !== res);
    console.log("❌ Cliente SSE desconectado.");
  });
});

// Rota para desconectar
app.get("/disconnect", async (req, res) => {
  if (sock) {
    await sock.logout();
    qrCodeData = null;
    console.log("🚪 Logout manual.");
    startSock(true); // força gerar novo QR
  }
  res.send("Desconectado!");
});

// Rota para gerar novo QR manualmente
app.get("/new-qr", (req, res) => {
  startSock(true);
  res.send("Novo QR solicitado.");
});

// Inicia servidor
app.listen(PORT, () => {
  console.log("🌐 Servidor rodando na porta " + PORT);
});

// Inicia socket
startSock();
