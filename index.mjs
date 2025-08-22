import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, initAuthCreds, BufferJSON } = baileys

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
const PORT = process.env.PORT || 3000

// Variável para armazenar QR code
let latestQr = null

// Sessões por usuário (para menus)
const sessions = new Map()
const MENU_TIMEOUT = 5 * 60 * 1000 // 5 minutos

// HTTP server
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

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// Função helper para pegar texto
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

// ----------- MENU DEFINIÇÃO -----------
class Menu {
  constructor(title) {
    this.title = title
    this.options = {}
  }

  addOption(number, text, action) {
    this.options[number] = { text, action }
    return this
  }

  getText() {
    let txt = `*${this.title}*\n\nDigite o número da opção:\n`
    for (const [num, opt] of Object.entries(this.options)) {
      txt += `\n${num} - ${opt.text}`
    }
    return txt
  }

  async handleInput(input, jid, sock) {
    const option = this.options[input]
    if (!option) {
      await sock.sendMessage(jid, { text: '❌ Opção inválida. Tente novamente.' })
      return this
    }
    if (option.action instanceof Menu) {
      return option.action
    } else if (typeof option.action === 'function') {
      return await option.action(jid, sock)
    }
    return this
  }
}

// Menu inicial
const mainMenu = new Menu('Olá, seja Bem-vindo ao atendimento *CG AGRO* 🌿\n\nQual tipo de produto você está procurando hoje?')
mainMenu
  .addOption('1', 'RAÇÕES', makeSubMenu('RAÇÕES'))
  .addOption('2', 'SEMENTES', makeSubMenu('SEMENTES'))
  .addOption('3', 'MEDICAMENTOS VETERINÁRIOS', makeSubMenu('MEDICAMENTOS VETERINÁRIOS'))
  .addOption('4', 'COCHO , TAMBOR E CAIXA D´ÁGUA', makeSubMenu('COCHO, TAMBOR E CAIXA D´ÁGUA'))
  .addOption('5', 'EQUIPAMENTOS EM GERAL', makeSubMenu('EQUIPAMENTOS EM GERAL'))
  .addOption('6', 'OUTROS', makeSubMenu('OUTROS'))

function makeSubMenu(title) {
  const submenu = new Menu(`Você está em *${title}*\nEscolha uma opção:`)
  submenu
    .addOption('1', 'Produto A', async (jid, sock) => {
      await sock.sendMessage(jid, { text: 'Detalhes do Produto A...' })
      return submenu
    })
    .addOption('2', 'Produto B', async (jid, sock) => {
      await sock.sendMessage(jid, { text: 'Detalhes do Produto B...' })
      return submenu
    })
    .addOption('0', 'Voltar ao Menu Inicial', mainMenu)
  return submenu
}

// ---------- SESSION HANDLER ----------
function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      currentMenu: mainMenu,
      timeout: null
    })
  }
  return sessions.get(jid)
}

function resetTimeout(jid) {
  const session = getSession(jid)
  if (session.timeout) clearTimeout(session.timeout)
  session.timeout = setTimeout(() => {
    session.currentMenu = mainMenu
    logger.info(`Sessão de ${jid} reiniciada por inatividade.`)
  }, MENU_TIMEOUT)
}

// ---------- WHATSAPP CONNECTION ----------
async function startWA() {
 import { useMultiFileAuthState } from '@whiskeysockets/baileys'

async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info') // cria pasta local
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('creds.update', saveCreds) // salva credenciais automaticamente


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
        logger.error('Sessão encerrada. Reinicie para reconectar.')
      }
    } else if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue
      const jid = msg.key.remoteJid || ''
      if (!jid.endsWith('@s.whatsapp.net')) continue

      const text = getText(msg).trim().toLowerCase()
      const session = getSession(jid)

      if (!text) continue

      resetTimeout(jid)

      // Interpreta a opção do menu
      const newMenu = await session.currentMenu.handleInput(text, jid, sock)
      if (newMenu !== session.currentMenu) {
        session.currentMenu = newMenu
      }

      // Sempre enviar o menu atual após processar input
      await sock.sendMessage(jid, { text: session.currentMenu.getText() })
    }
  })
}

startWA().catch(err => logger.error(err, 'Erro fatal'))
