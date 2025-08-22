import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()

// ------------------ HTTP SERVER ------------------
app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))

// Variável para armazenar o QR atual
let latestQr = null

// Endpoint para exibir QR
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

// ------------------ MENU CONFIG ------------------
const MAIN_MENU = `*Olá, seja bem-vindo ao atendimento CG AGRO 🌿*

Qual tipo de produto você está procurando hoje?

*Digite o número da opção desejada:*
1 - RAÇÕES
2 - SEMENTES
3 - MEDICAMENTOS VETERINÁRIOS
4 - COCHO, TAMBOR E CAIXA D'ÁGUA
5 - EQUIPAMENTOS EM GERAL
6 - OUTROS
0 - Voltar ao menu inicial`

const SUBMENUS = {
  1: `*RAÇÕES*
1. Ração para Bovinos
2. Ração para Suínos
0. Voltar ao menu inicial`,
  2: `*SEMENTES*
1. Milho
2. Soja
0. Voltar ao menu inicial`,
  3: `*MEDICAMENTOS VETERINÁRIOS*
1. Antibióticos
2. Vermífugos
0. Voltar ao menu inicial`,
  4: `*COCHO, TAMBOR E CAIXA D'ÁGUA*
1. Cochos de plástico
2. Caixas d'água 500L
0. Voltar ao menu inicial`,
  5: `*EQUIPAMENTOS EM GERAL*
1. Pulverizadores
2. Máquinas agrícolas
0. Voltar ao menu inicial`,
  6: `*OUTROS PRODUTOS*
1. Consultar disponibilidade
0. Voltar ao menu inicial`
}

// ------------------ SESSÕES ------------------
const sessions = {} // { userJid: { menu: 'main' | 'submenu', timeout: null } }
const INACTIVITY_TIMEOUT = 5 * 60 * 1000 // 5 minutos

function resetSession(jid) {
  sessions[jid] = { menu: 'main', timeout: null }
}

function setInactivityTimer(jid, sock) {
  if (sessions[jid].timeout) clearTimeout(sessions[jid].timeout)
  sessions[jid].timeout = setTimeout(async () => {
    resetSession(jid)
    await sock.sendMessage(jid, { text: '*Sessão expirada por inatividade. Voltando ao menu inicial.*\n\n' + MAIN_MENU })
    logger.info({ jid }, 'Sessão reiniciada por inatividade')
  }, INACTIVITY_TIMEOUT)
}

// ------------------ HELPER ------------------
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

// ------------------ WHATSAPP BOT ------------------
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger
  })

  // Eventos de conexão
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
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
        logger.error('Sessão deslogada. Apague a pasta ./auth_info e pareie novamente.')
      }
    } else if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // Mensagens recebidas
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      if (!jid.endsWith('@s.whatsapp.net')) continue

      const text = getText(msg).trim()

      if (!sessions[jid]) resetSession(jid)
      setInactivityTimer(jid, sock)

      if (sessions[jid].menu === 'main') {
        if (/^[1-6]$/.test(text)) {
          sessions[jid].menu = 'submenu'
          await sock.sendMessage(jid, { text: SUBMENUS[text] || 'Opção inválida' })
        } else {
          await sock.sendMessage(jid, { text: MAIN_MENU })
        }
      } else if (sessions[jid].menu === 'submenu') {
        if (text === '0') {
          resetSession(jid)
          await sock.sendMessage(jid, { text: MAIN_MENU })
        } else {
          await sock.sendMessage(jid, { text: `Você escolheu a opção *${text}*.\n(Exemplo fictício)\n\nDigite 0 para voltar ao menu inicial.` })
        }
      }
    }
  })
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
