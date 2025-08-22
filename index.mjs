import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'
import fs from 'fs'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()

// ------------------ HTTP SERVER ------------------
let latestQr = null

app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))
app.get('/qr', (_, res) => {
  if (latestQr) {
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

const PORT = process.env.PORT || 3000
app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// ------------------ CARREGAR MENUS ------------------
const menus = JSON.parse(fs.readFileSync('./menus_Chatbot.json', 'utf8'))
const MAIN_MENU = 'Inicio' // menu raiz

// ------------------ CONTROLE DE SESSÕES ------------------
const sessions = {} // { jid: { menu: string, warnTimeout, resetTimeout, locked: boolean } }
const WARN_TIME = 5 * 60 * 1000 // 5 min
const RESET_TIME = 10 * 60 * 1000 // 10 min

function resetSession(jid) {
  sessions[jid] = { menu: MAIN_MENU, warnTimeout: null, resetTimeout: null, locked: false }
}

async function setInactivityTimers(jid, sock) {
  const session = sessions[jid]
  if (session.warnTimeout) clearTimeout(session.warnTimeout)
  if (session.resetTimeout) clearTimeout(session.resetTimeout)

  session.warnTimeout = setTimeout(async () => {
    await sock.sendMessage(jid, { text: '*Aviso:* sua sessão será reiniciada em 5 minutos se não houver interação.' })
    logger.info({ jid }, 'Aviso de inatividade enviado')
  }, WARN_TIME)

  session.resetTimeout = setTimeout(async () => {
    resetSession(jid)
    await sock.sendMessage(jid, { text: '*Sessão expirada por inatividade. Voltando ao menu inicial.*\n\n' + menus[MAIN_MENU].texto })
    logger.info({ jid }, 'Sessão reiniciada por inatividade')
  }, RESET_TIME)
}

// ------------------ HELPERS ------------------
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

async function handleMenuInput(jid, text, sock) {
  const session = sessions[jid]
  const currentMenu = menus[session.menu]

  // Reinício manual
  if (text === '0' || text.toLowerCase() === 'inicio') {
    resetSession(jid)
    await sock.sendMessage(jid, { text: menus[MAIN_MENU].texto })
    return
  }

  // Se locked, não responder (esperando humano)
  if (session.locked) {
    await sock.sendMessage(jid, { text: '⚠ Atendimento humano em andamento. Envie "0" para voltar ao menu inicial.' })
    return
  }

  const option = currentMenu.opcoes[text]
  if (!option) {
    await sock.sendMessage(jid, { text: '❌ Opção inválida. Tente novamente.\n\n' + currentMenu.texto })
    return
  }

  // Se ação é mudar de menu
  if (option.tipo === 'menu') {
    session.menu = option.destino
    await sock.sendMessage(jid, { text: menus[option.destino].texto })
    return
  }

  // Se ação é resposta
  if (option.tipo === 'resposta') {
    await sock.sendMessage(jid, { text: option.texto })
    return
  }

  // Se non-response → trava bot
  if (option.tipo === 'non-response') {
    session.locked = true
    await sock.sendMessage(jid, { text: option.texto + '\n\n⚠ Agora você está em atendimento humano. Envie "0" para voltar ao menu inicial.' })
    return
  }
}

// ------------------ BOT ------------------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      latestQr = await qrcode.toDataURL(qr)
      logger.info('QR atualizado. Acesse /qr para escanear.')
    }
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      if (code !== DisconnectReason.loggedOut) {
        setTimeout(startWA, 2000)
      } else {
        logger.error('Sessão deslogada. Apague ./auth_info e pareie novamente.')
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
      if (!jid.endsWith('@s.whatsapp.net')) continue

      const text = getText(msg).trim()
      if (!sessions[jid]) resetSession(jid)

      setInactivityTimers(jid, sock)

      await handleMenuInput(jid, text, sock)
    }
  })
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
