import express from 'express'
import Pino from 'pino'
import fs from 'fs'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
const PORT = process.env.PORT || 10000

// Carrega menus
const menus = JSON.parse(fs.readFileSync('./menus_Chatbot.json', 'utf-8'))

// Estado
let latestQr = null
// sessions[jid] = { menu, lastActive, warnedAt, silent, timers: { warn, reset } }
const sessions = {}

// Endpoints
app.get('/', (_, res) => res.send('ok'))
app.get('/qr', (_, res) => {
  if (!latestQr) return res.send('Nenhum QR disponível (ou já conectado).')
  res.send(`
    <html><body style="display:flex;justify-content:center;align-items:center;height:100vh;flex-direction:column;">
      <h2>Escaneie o QR abaixo:</h2>
      <img src="${latestQr}" style="width:300px;height:300px" />
    </body></html>`)
})

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// Utilitários
const now = () => Date.now()

function ensureSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = {
      menu: 'Inicio',
      lastActive: now(),
      warnedAt: null,
      silent: false,
      timers: { warn: null, reset: null }
    }
  }
  return sessions[jid]
}

function clearTimers(jid) {
  const t = sessions[jid]?.timers
  if (!t) return
  if (t.warn) clearTimeout(t.warn)
  if (t.reset) clearTimeout(t.reset)
  sessions[jid].timers = { warn: null, reset: null }
}

function scheduleInactivity(jid, sock) {
  const s = sessions[jid]
  if (!s) return
  clearTimers(jid)

  const base = s.lastActive
  const warnDelay = Math.max(0, base + 5 * 60 * 1000 - now())
  const resetDelay = Math.max(0, base + 10 * 60 * 1000 - now())

  // Aviso aos 5 minutos
  s.timers.warn = setTimeout(async () => {
    // Se já houve atividade depois, ignore
    if (!sessions[jid] || now() - sessions[jid].lastActive < 5 * 60 * 1000) return
    sessions[jid].warnedAt = now()
    try {
      // Pode falar mesmo em modo silencioso
      await sock.sendMessage(jid, {
        text: '⚠️ Você está inativo há um tempo. A sessão será reiniciada em 5 minutos se não houver resposta.'
      })
    } catch (e) {
      logger.warn({ err: e }, 'Falha ao enviar aviso de inatividade')
    }
  }, warnDelay)

  // Reinício aos 10 minutos
  s.timers.reset = setTimeout(async () => {
    if (!sessions[jid]) return
    // Se houve atividade, ignore
    if (now() - sessions[jid].lastActive < 10 * 60 * 1000) return
    try {
      await sock.sendMessage(jid, {
        text: '⏳ Sessão reiniciada por inatividade. Digite qualquer coisa para voltar ao menu inicial.'
      })
    } catch (e) {
      logger.warn({ err: e }, 'Falha ao enviar mensagem de reinício')
    }
    // Reseta a sessão, mas mantém o objeto
    sessions[jid].menu = 'Inicio'
    sessions[jid].silent = false
    sessions[jid].warnedAt = null
    sessions[jid].lastActive = now()
    clearTimers(jid)
  }, resetDelay)
}

function sanitizeText(msg) {
  const m = msg.message
  const txt =
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  return (txt || '').toString().trim()
}

async function sendMenu(sock, jid, menuKey = 'Inicio') {
  const menu = menus[menuKey] || menus['Inicio']
  await sock.sendMessage(jid, { text: menu.texto })
}

// WhatsApp
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
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
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const jid = msg.key.remoteJid
      const text = sanitizeText(msg)
      if (!text) continue

      const s = ensureSession(jid)

      // Atualiza atividade e timers (independente do modo silencioso)
      s.lastActive = now()
      scheduleInactivity(jid, sock)

      // Sempre permitir voltar ao início
      if (text === '0' || text.toLowerCase() === 'inicio') {
        s.menu = 'Inicio'
        s.silent = false
        await sendMenu(sock, jid, 'Inicio')
        continue
      }

      // Se está em modo silencioso: não falar (exceto 0/inicio já coberto)
      if (s.silent) {
        // fica quietinho 😉
        continue
      }

      // Fluxo normal de menus
      const currentMenu = menus[s.menu] || menus['Inicio']
      const opcoes = currentMenu?.opcoes || {}
      const option = opcoes[text]

      if (!option) {
        await sock.sendMessage(jid, {
          text: 'Opção inválida. Digite um número válido ou 0 para voltar ao menu inicial.'
        })
        continue
      }

      if (option.tipo === 'menu') {
        const destino = option.destino
        if (!menus[destino]) {
          await sock.sendMessage(jid, { text: 'Ops! Menu indisponível. Voltando ao início.' })
          s.menu = 'Inicio'
          await sendMenu(sock, jid, 'Inicio')
          continue
        }
        s.menu = destino
        await sendMenu(sock, jid, destino)
      } else if (option.tipo === 'resposta') {
        // Se "non-response" for true => não responder NADA e entrar em modo silencioso
        if (option['non-response'] === true) {
          s.silent = true
          // Nada de mensagem aqui. Apenas silêncio.
        } else {
          // comportamento normal de resposta
          const resp = option.texto || 'Ok.'
          await sock.sendMessage(jid, { text: resp })
        }
      } else {
        // Tipo desconhecido
        await sock.sendMessage(jid, {
          text: 'Opção em manutenção. Digite 0 para voltar ao menu inicial.'
        })
      }
    }
  })
}

startWA().catch((err) => logger.error({ err }, 'Erro fatal'))
