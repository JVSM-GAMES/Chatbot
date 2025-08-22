import express from 'express'
import Pino from 'pino'
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'
import qrcode from 'qrcode-terminal'



const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

// --- HTTP server para healthcheck/keep-alive ---
const app = express()
app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))
const PORT = process.env.PORT || 3000
app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// Helper para extrair texto de várias formas de mensagem
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
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth')

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true
  })

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error?.output?.statusCode) !== DisconnectReason.loggedOut
      if (shouldReconnect) startWA()
    }
    if (connection === 'open') {
      console.log('✅ Conectado ao WhatsApp!')
    }
  })

  sock.ev.on('messages.upsert', async (m) => {
    const msg = m.messages[0]
    if (!msg.message) return
    const texto = msg.message.conversation?.toLowerCase() || ''

    if (texto === 'oi') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'Bom dia!' })
    }
  })

  sock.ev.on('creds.update', saveCreds)
}


  // Regra: se alguém mandar "Oi", responder "Bom dia"
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      // responde só em PV (evita grupos)
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
}

// Baileys depende de Boom para alguns códigos de erro
import { Boom } from '@hapi/boom'

// Inicia
startWA().catch(err => logger.error(err, 'Erro fatal'))
