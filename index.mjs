import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import express from "express"
import qrcode from "qrcode"
import pino from "pino"

const app = express()
const PORT = process.env.PORT || 3000

app.get("/", (req, res) => {
  res.send("✅ Bot rodando no Render com Baileys!")
})

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys")

  const sock = makeWASocket({
    logger: pino({ level: "silent" }),
    printQRInTerminal: true,
    auth: state
  })

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.log("🔗 Escaneie o QR Code no console ou acesse /qr para visualizar")
      app.get("/qr", async (req, res) => {
        res.type("html")
        res.send(`<img src="${await qrcode.toDataURL(qr)}"/>`)
      })
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      console.log("❌ Conexão fechada. Reconectar:", shouldReconnect)
      if (shouldReconnect) startBot()
    } else if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!")
    }
  })

  sock.ev.on("creds.update", saveCreds)
}

app.listen(PORT, () => {
  console.log("🚀 Servidor Express rodando na porta " + PORT)
  startBot()
})
