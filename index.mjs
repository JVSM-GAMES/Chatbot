import express from 'express'
import Pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
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

async function startWA () {
  const { state, saveCreds } = await useMultiFileAuthState('./auth') // guardado no FS local do container
  const { version } = await fetchLatestBaileysVersion()

  let sock = makeWASocket({
    version,
    auth: state,
    // Se você NÃO definir WA_PHONE_NUMBER, mostramos QR no log
    printQRInTerminal: !process.env.WA_PHONE_NUMBER,
    logger
  })

  // Exibe QR bonito no terminal (melhora legibilidade em logs)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr && !process.env.WA_PHONE_NUMBER) {
      qrcode.generate(qr, { small: true })
      logger.info('Escaneie o QR em WhatsApp > Dispositivos conectados')
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
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  // Persistência das credenciais
  sock.ev.on('creds.update', saveCreds)

  // Pareamento via "código de pareamento" (opcional)
  // Defina WA_PHONE_NUMBER=seunumero (ex: 5511999999999) nos envs do Render.
  // Aí o console mostra um código de 8 dígitos para digitar em WhatsApp > Dispositivos conectados.
  try {
    if (!state.creds?.registered && process.env.WA_PHONE_NUMBER) {
      const code = await sock.requestPairingCode(process.env.WA_PHONE_NUMBER)
      logger.warn(`Código de pareamento: ${code} (WhatsApp > Dispositivos conectados > "Conectar com número")`)
    }
  } catch (e) {
    logger.error(e, 'Falha ao gerar código de pareamento; use o QR code no log.')
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
