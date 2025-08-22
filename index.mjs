import express from 'express'
import Pino from 'pino'
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

// --- HTTP server para healthcheck/keep-alive ---
const app = express()
app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))
const PORT = process.env.PORT || 3000

// Variável para armazenar o QR atual em base64
let latestQr = null

// Endpoint para exibir QR code
app.get('/qr', (_, res) => {
  if (latestQr) {
    // Exibe a imagem diretamente no HTML
    res.send(`
      <html>
        <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;">
          <h2>Escaneie o QR no WhatsApp > Dispositivos conectados</h2>
          <img src="${latestQr}" style="width:300px;height:300px;" />
        </body>
      </html>
    `)
  } else {
    res.send('QR ainda não gerado ou já autenticado.')
  }
})

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

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false, // desativa QR no terminal, vamos exibir via endpoint
    logger
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr && !process.env.WA_PHONE_NUMBER) {
      // Converte o QR em base64 para exibir via endpoint
      latestQr = await qrcode.toDataURL(qr)
      logger.info('QR atualizado. Acesse /qr para visualizar e escanear.')
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
      latestQr = null // Limpa o QR após conexão bem-sucedida
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  // Persistência das credenciais
  sock.ev.on('creds.update', saveCreds)

  // Pareamento via "código de pareamento" (opcional)
  try {
    if (!state.creds?.registered && process.env.WA_PHONE_NUMBER) {
      const code = await sock.requestPairingCode(process.env.WA_PHONE_NUMBER)
      logger.warn(`Código de pareamento: ${code} (WhatsApp > Dispositivos conectados > "Conectar com número")`)
    }
  } catch (e) {
    logger.error(e, 'Falha ao gerar código de pareamento; use o QR code via /qr.')
  }

  // Regra: se alguém mandar "Oi", responder "Bom dia"
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      if (!jid.endsWith('@s.whatsapp.net')) continue // responde só em PV
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

// Inicia
startWA().catch(err => logger.error(err, 'Erro fatal'))
