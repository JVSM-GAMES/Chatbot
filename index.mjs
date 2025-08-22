import express from 'express'
import Pino from 'pino'
import fs from 'fs'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
const PORT = process.env.PORT || 3000

// Carregar menus do JSON
const menus = JSON.parse(fs.readFileSync('./menus_Chatbot.json', 'utf-8'))

let latestQr = null
const sessions = {} // { jid: { menu: 'Inicio', lastActive: timestamp, warned: false, timeout: setTimeout } }

app.get('/', (_, res) => res.send('ok'))
app.get('/qr', (_, res) => {
  if (latestQr) {
    res.send(`<html><body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
      <h2>Escaneie o QR abaixo:</h2>
      <img src="${latestQr}" style="width:300px;height:300px;" />
    </body></html>`)
  } else {
    res.send('Nenhum QR disponível ou já conectado.')
  }
})

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

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
    if (qr) latestQr = await qrcode.toDataURL(qr)

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code }, 'Conexão fechada')
      if (shouldReconnect) setTimeout(startWA, 2000)
    } else if (connection === 'open') {
      latestQr = null
      logger.info('✅ Conectado ao WhatsApp')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid
      const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').trim()

      if (!sessions[jid]) {
        sessions[jid] = { menu: 'Inicio', lastActive: Date.now(), warned: false }
        await sock.sendMessage(jid, { text: menus.Inicio.texto })
        setInactivityTimeout(jid, sock)
        continue
      }

      sessions[jid].lastActive = Date.now()
      sessions[jid].warned = false
      clearTimeout(sessions[jid].timeout)
      setInactivityTimeout(jid, sock)

      if (text === '0' || text.toLowerCase() === 'inicio') {
        sessions[jid].menu = 'Inicio'
        await sock.sendMessage(jid, { text: menus.Inicio.texto })
        continue
      }

      const currentMenu = menus[sessions[jid].menu]
      const option = currentMenu.opcoes[text]

      if (!option) {
        await sock.sendMessage(jid, { text: 'Opção inválida. Digite um número válido ou 0 para voltar ao menu inicial.' })
        continue
      }

      if (option.tipo === 'menu') {
        sessions[jid].menu = option.destino
        await sock.sendMessage(jid, { text: menus[option.destino].texto })
      } else if (option.tipo === 'resposta') {
        await sock.sendMessage(jid, { text: option.texto })
        if (option['non-response']) delete sessions[jid] // encerra atendimento automático
      }
    }
  })
}

function setInactivityTimeout(jid, sock) {
  sessions[jid].timeout = setTimeout(async () => {
    const timeSinceLast = Date.now() - sessions[jid].lastActive
    if (timeSinceLast >= 5 * 60 * 1000 && !sessions[jid].warned) {
      sessions[jid].warned = true
      await sock.sendMessage(jid, { text: '⚠️ Você está inativo há um tempo. A sessão será reiniciada em 5 minutos se não houver resposta.' })
      setInactivityTimeout(jid, sock)
    } else if (sessions[jid].warned && timeSinceLast >= 10 * 60 * 1000) {
      delete sessions[jid]
      await sock.sendMessage(jid, { text: '⏳ Sessão reiniciada por inatividade. Digite qualquer coisa para voltar ao menu inicial.' })
    }
  }, 5 * 60 * 1000)
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
