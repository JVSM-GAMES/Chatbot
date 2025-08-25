import express from 'express'
import Pino from 'pino'
import fs from 'fs'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const { makeWASocket, DisconnectReason, fetchLatestBaileysVersion, useMultiFileAuthState } = baileys
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })
const app = express()
app.use(express.json())

const PORT = process.env.PORT || 10000

// Configurações
const settingsFile = './settings.json'
let settings = { allowGroups: false, blockedNumbers: [] }
if (fs.existsSync(settingsFile)) {
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
  } catch (e) {
    logger.warn('Falha ao carregar settings.json, usando padrão.')
  }
}

// Estado
let latestQr = null
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

// Configurações via web
app.get('/settings', (_, res) => {
  res.send(`
    <html>
      <head>
        <title>Configurações do Bot</title>
        <style>
          body { font-family: Arial; margin: 20px; }
          .container { max-width: 500px; margin: auto; }
          textarea { width: 100%; height: 80px; }
          button { margin-top: 10px; padding: 10px 15px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h2>Configurações do Bot</h2>
          <label>
            <input type="checkbox" id="allowGroups" ${settings.allowGroups ? 'checked' : ''}>
            Responder em grupos
          </label>
          <br><br>
          <label>
            Números bloqueados (separados por vírgula):
          </label>
          <textarea id="blockedNumbers">${settings.blockedNumbers.join(', ')}</textarea>
          <br>
          <button onclick="saveSettings()">Salvar</button>
          <p id="status" style="color: green;"></p>
        </div>
        <script>
          async function saveSettings() {
            const allowGroups = document.getElementById('allowGroups').checked
            const blockedNumbers = document.getElementById('blockedNumbers').value.split(',').map(n => n.trim()).filter(n => n)
            const res = await fetch('/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ allowGroups, blockedNumbers })
            })
            const data = await res.json()
            document.getElementById('status').innerText = 'Configurações salvas com sucesso!'
          }
        </script>
      </body>
    </html>
  `)
})

app.post('/settings', (req, res) => {
  const { allowGroups, blockedNumbers } = req.body
  if (typeof allowGroups === 'boolean') settings.allowGroups = allowGroups
  if (Array.isArray(blockedNumbers)) settings.blockedNumbers = blockedNumbers
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))
  res.json({ success: true, settings })
})

app.listen(PORT, () => logger.info({ PORT }, 'HTTP server online'))

// Funções auxiliares
const now = () => Date.now()
function sanitizeText(msg) {
  const m = msg.message
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    ''
  ).trim()
}

function ensureSession(jid) {
  if (!sessions[jid]) {
    sessions[jid] = {
      firstMessage: true,
      lastActive: now(),
      silent: false,
      timers: { warn: null, reset: null }
    }
  }
  return sessions[jid]
}

function clearTimers(jid) {
  const t = sessions[jid]?.timers
  if (t?.warn) clearTimeout(t.warn)
  if (t?.reset) clearTimeout(t.reset)
  sessions[jid].timers = { warn: null, reset: null }
}

function scheduleInactivity(jid, sock) {
  const s = sessions[jid]
  if (!s) return
  clearTimers(jid)
  const base = s.lastActive
  const warnDelay = Math.max(0, base + 5 * 60 * 1000 - now())
  const resetDelay = Math.max(0, base + 10 * 60 * 1000 - now())

  s.timers.warn = setTimeout(async () => {
    if (!sessions[jid] || now() - sessions[jid].lastActive < 5 * 60 * 1000) return
    await sock.sendMessage(jid, {
      text: '⚠️ Você está inativo há um tempo. A sessão será reiniciada em 5 minutos se não houver resposta.'
    })
  }, warnDelay)

  s.timers.reset = setTimeout(async () => {
    if (!sessions[jid]) return
    if (now() - sessions[jid].lastActive < 10 * 60 * 1000) return
    await sock.sendMessage(jid, {
      text: '⏳ Sessão reiniciada por inatividade. Digite qualquer coisa para receber novamente o atendimento.'
    })
    sessions[jid].silent = false
    sessions[jid].firstMessage = true
    sessions[jid].lastActive = now()
    clearTimers(jid)
  }, resetDelay)
}

// WhatsApp
async function startWA() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger })

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) latestQr = await qrcode.toDataURL(qr)
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      if (shouldReconnect) setTimeout(startWA, 2000)
    } else if (connection === 'open') {
      latestQr = null
      logger.info('Conectado ao WhatsApp ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) return

      const jid = msg.key.remoteJid
      const text = sanitizeText(msg)
      if (!text) return

      const isGroup = jid.endsWith('@g.us')
      const num = jid.replace(/@.*$/, '')

      if ((isGroup && !settings.allowGroups) || settings.blockedNumbers.includes(num)) {
        logger.info(`Ignorando mensagem de ${jid} devido às configurações.`)
        return
      }

      const s = ensureSession(jid)
      s.lastActive = now()
      scheduleInactivity(jid, sock)

      if (s.silent) continue

      if (s.firstMessage) {
        // ✅ Mensagem inicial simples
        await sock.sendMessage(jid, {
          text: `Olá seja Bem vindo ao *CG AGRO* 🌿\nQual de nossos produtos poderia te servir?\n- RAÇÕES\n- SEMENTES\n- MEDICAMENTOS VETERINÁRIOS\n- COCHO, TAMBOR E CAIXA D´AGUA\n- EQUIPAMENTOS EM GERAL`
        })
        await sock.sendMessage(jid, {
          text: `Logo um de nossos atendentes irá atender voçê. 😉`
        })

        s.firstMessage = false
        s.silent = true
      }
    }
  })
}

startWA().catch((err) => logger.error({ err }, 'Erro fatal'))
