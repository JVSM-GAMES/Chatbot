import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'
import { handleMessage } from './sessionHandler.mjs'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

const app = express()
const PORT = process.env.PORT || 3000

let sock = null
let latestQr = null

// --- Endpoints ---
app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))

app.get('/qr', (_, res) => {
  if (latestQr) {
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h2>Escaneie o QR no WhatsApp > Dispositivos conectados</h2>
          <img src="${latestQr}" style="width:300px;height:300px;" />
          <form method="POST" action="/disconnect">
            <button type="submit">Desconectar sessão atual</button>
          </form>
        </body>
      </html>
    `)
  } else {
    res.send('QR ainda não gerado ou já autenticado.')
  }
})

app.post('/disconnect', (_, res) => {
  if (sock) {
    sock.logout()
    latestQr = null
    res.send('Sessão desconectada. Gere um novo QR na página /qr')
  } else {
    res.send('Nenhuma sessão ativa.')
  }
})

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// --- WhatsApp ---
const getText = (msg) => {
  const m = msg.message
  if (!m) return ''
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage) return m.extendedTextMessage.text || ''
  if (m.imageMessage) return m.imageMessage.caption || ''
  if (m.videoMessage) return m.videoMessage.caption || ''
  if (m.ephemeralMessage) return getText({ message: m.ephemeralMessage.message })
  if (m.viewOnceMessage) return getText({ message: m.viewOnceMessage.message })
  return ''
}

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth')
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr && !process.env.WA_PHONE_NUMBER) {
      latestQr = await qrcode.toDataURL(qr)
      logger.info('QR atualizado. Acesse /qr para escanear.')
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code }, 'Conexão fechada')
      if (shouldReconnect) {
        setTimeout(startWA, 2000)
      } else {
        logger.error('Sessão deslogada. Apague a pasta ./auth e pareie novamente.')
      }
    } else if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      const text = getText(msg).trim()
      await handleMessage(sock, jid, text, msg)
    }
  })
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
