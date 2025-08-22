// index.mjs
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys"
import { Boom } from "@hapi/boom"

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info") 

    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
    })

    // Evento de conexão
    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error instanceof Boom &&
                lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut

            console.log("Conexão fechada. Reconectando:", shouldReconnect)

            if (shouldReconnect) {
                connectToWhatsApp()
            }
        } else if (connection === "open") {
            console.log("✅ Conectado ao WhatsApp!")
        }
    })

    // Evento de mensagens
    sock.ev.on("messages.upsert", async (m) => {
        console.log(JSON.stringify(m, undefined, 2))

        const msg = m.messages[0]
        if (!msg.message || msg.key.fromMe) return

        const from = msg.key.remoteJid
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text

        if (text) {
            if (text.toLowerCase() === "ping") {
                await sock.sendMessage(from, { text: "pong 🏓" })
            } else {
                await sock.sendMessage(from, { text: `Você disse: ${text}` })
            }
        }
    })

    sock.ev.on("creds.update", saveCreds)
}

connectToWhatsApp()
