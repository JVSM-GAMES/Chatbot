import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds } = baileys

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

// --- HTTP server ---
const app = express()
app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))
const PORT = process.env.PORT || 3000

let latestQr = null
let sock = null
let reconnectTimeout = null
let isConnecting = false

// Auth em memória
let authState = { creds: initAuthCreds(), keys: {} }
const getAuthState = () => ({
  state: authState,
  saveCreds: async () => logger.info('Credenciais atualizadas em memória')
})

// Exibir QR
app.get('/qr', (_, res) => {
  if (latestQr) {
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h2>Escaneie o QR no WhatsApp > Dispositivos conectados</h2>
          <img src="${latestQr}" style="width:300px;height:300px;" />
          <br>
          <a href="/new-qr"><button style="padding:10px;margin-top:20px;">Gerar novo QR</button></a>
        </body>
      </html>
    `)
  } else {
    res.send('QR ainda não gerado ou já autenticado.')
  }
})

// Forçar novo QR
app.get('/new-qr', (_, res) => {
  startWA(true)
  res.send('Novo QR solicitado.')
})

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// Helper para pegar texto da mensagem
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

async function startWA(forceNewAuth = false) {
  if (isConnecting) return
  isConnecting = true

  if (forceNewAuth) {
    authState = { creds: initAuthCreds(), keys: {} }
    logger.warn('Sessão resetada, gerando novo QR.')
  }

  const { state, saveCreds } = getAuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      latestQr = await qrcode.toDataURL(qr)
      logger.info('QR atualizado. Acesse /qr para visualizar e escanear.')
    }

    if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
      if (reconnectTimeout) clearTimeout(reconnectTimeout)
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code }, 'Conexão fechada')
      if (shouldReconnect) {
        reconnectTimeout = setTimeout(() => startWA(), 3000)
      } else {
        logger.error('Sessão deslogada. Use /new-qr para gerar um novo QR.')
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      if (!jid.endsWith('@s.whatsapp.net')) continue

      const text = getText(msg).trim().toLowerCase()
      if (text === 'oi') {
        try {
          await sock.sendMessage(jid, { text: 'Bom dia' }, { quoted: msg })
          logger.info({ to: jid }, 'Respondi "Bom dia"')
        } catch (err) {
          logger.error(err, 'Erro ao responder')
        }
      }
    }
  })

  isConnecting = false
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
