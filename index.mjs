// index.mjs
import express from 'express'
import Pino from 'pino'
import * as baileys from '@whiskeysockets/baileys'
import qrcode from 'qrcode'
import { Boom } from '@hapi/boom'

const {
  makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  BufferJSON
} = baileys

// ---------- Logger ----------
const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

// ---------- HTTP Server (Render) ----------
const app = express()
const PORT = process.env.PORT || 3000

app.get('/', (_, res) => res.send('ok'))
app.get('/ping', (_, res) => res.json({ ok: true, ts: Date.now() }))

// ---------- Estado global ----------
let sock = null
let isConnecting = false
let reconnectTimer = null

// QR atual em DataURL (para fallback) + controle de SSE
let latestQrDataUrl = null
const sseClients = new Set()

// ---------- Auth em MEMÓRIA ----------
function createMemoryAuth() {
  // Credenciais base
  const creds = initAuthCreds()

  // Armazena chaves por tipo em Map<string, any>
  /** @type {Record<string, Map<string, any>>} */
  const keys = {}

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const map = keys[type] || new Map()
          const result = {}
          for (const id of ids) result[id] = map.get(id)
          return result
        },
        set: async (data) => {
          for (const type of Object.keys(data)) {
            if (!keys[type]) keys[type] = new Map()
            const map = keys[type]
            for (const id of Object.keys(data[type])) {
              const value = data[type][id]
              if (value === null || value === undefined) {
                map.delete(id)
              } else {
                map.set(id, value)
              }
            }
          }
        }
      }
    },
    // Apenas loga — nada é persistido em disco
    saveCreds: async () => logger.info('Credenciais atualizadas em memória'),
    // Reset total (para /new-qr ou /disconnect)
    reset: () => {
      const fresh = initAuthCreds()
      // zera mapas
      for (const k of Object.keys((auth.state.keys))) {
        // recria Map vazio
        auth.state.keys[k] = new Map()
      }
      // substitui creds
      Object.assign(auth.state.creds, fresh)
    }
  }
}

// instancia global
const auth = createMemoryAuth()

// ---------- SSE: eventos de QR ----------
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')

  res.write(`event: ping\ndata: "ok"\n\n`) // handshake
  sseClients.add(res)
  logger.info('👂 Cliente SSE conectado.')

  // envia QR atual se existir
  if (latestQrDataUrl) {
    res.write(`event: qr-update\ndata: ${JSON.stringify({ dataUrl: latestQrDataUrl })}\n\n`)
  }

  // keep-alive (Render/Proxies costumam fechar se inativo)
  const keepAlive = setInterval(() => {
    res.write(`event: ping\ndata: "ok"\n\n`)
  }, 25000)

  req.on('close', () => {
    clearInterval(keepAlive)
    sseClients.delete(res)
    logger.warn('❌ Cliente SSE desconectado.')
  })
})

function broadcastQr(dataUrl) {
  for (const client of sseClients) {
    try {
      client.write(`event: qr-update\ndata: ${JSON.stringify({ dataUrl })}\n\n`)
    } catch {}
  }
}

// ---------- Página /qr (auto-atualiza) ----------
app.get('/qr', (_, res) => {
  res.send(`
  <!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <title>QR WhatsApp</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; display:flex; align-items:center; justify-content:center; height:100vh; margin:0; background:#0b1020; color:#eaeef9; }
        .card { background:#131a33; border-radius:20px; padding:28px; box-shadow: 0 10px 30px rgba(0,0,0,.35); width: min(420px, 92vw); text-align:center; }
        h2 { margin:0 0 16px 0; font-weight:600; letter-spacing:.2px; }
        #qr { width:320px; height:320px; background:#0b1020; border-radius:12px; display:inline-block; }
        .row { display:flex; gap:10px; justify-content:center; margin-top:16px; flex-wrap: wrap; }
        button, a.btn { border:0; background:#3056ff; color:#fff; padding:10px 16px; border-radius:12px; cursor:pointer; text-decoration:none; font-weight:600; }
        button.secondary, a.secondary { background:#2a355f; }
        .muted { opacity:.8; font-size:14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Escaneie o QR no WhatsApp → Dispositivos conectados</h2>
        <div><img id="qr" alt="Aguardando QR..." src="${latestQrDataUrl ?? ''}"/></div>
        <div class="row">
          <a class="btn" href="/new-qr">Gerar novo QR</a>
          <a class="btn secondary" href="/disconnect">Desconectar</a>
        </div>
        <p class="muted" id="status">${latestQrDataUrl ? 'QR pronto ✅' : 'Aguardando QR...'}</p>
      </div>

      <script>
        const img = document.getElementById('qr');
        const status = document.getElementById('status');
        const sse = new EventSource('/events');

        sse.addEventListener('qr-update', (ev) => {
          try {
            const { dataUrl } = JSON.parse(ev.data);
            if (dataUrl && img.src !== dataUrl) {
              img.src = dataUrl;
              status.textContent = 'QR pronto ✅';
            }
          } catch (e) {}
        });

        sse.addEventListener('ping', () => {});
        sse.onerror = () => { /* silencioso */ };
      </script>
    </body>
  </html>
  `)
})

// ---------- Comandos de controle ----------
app.get('/new-qr', async (_, res) => {
  try {
    await resetSessionAndStart(true)
    res.send('Novo QR solicitado. Abra /qr para escanear.')
  } catch (e) {
    res.status(500).send('Falha ao solicitar novo QR.')
  }
})

app.get('/disconnect', async (_, res) => {
  try {
    if (sock) {
      await sock.logout().catch(() => {})
      await sock.ws?.close?.()
      sock = null
    }
    // reseta as credenciais e limpa QR
    auth.reset()
    latestQrDataUrl = null
    broadcastQr('') // limpa na UI
    logger.warn('🚪 Logout realizado. Sessão resetada.')
    res.send('Desconectado e sessão resetada. Use /new-qr para gerar outro QR.')
  } catch (e) {
    res.status(500).send('Falha ao desconectar.')
  }
})

// ---------- Inicialização HTTP ----------
app.listen(PORT, () => logger.info({ PORT: String(PORT) }, 'HTTP server online'))

// ---------- Utilitário de texto de mensagem ----------
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

// ---------- Conexão WA ----------
async function startWA() {
  if (isConnecting) return
  isConnecting = true

  const { version } = await fetchLatestBaileysVersion()

  // fecha anterior se houver
  try { await sock?.ws?.close?.() } catch {}

  sock = makeWASocket({
    version,
    auth: auth.state,
    printQRInTerminal: false,
    logger
  })

  sock.ev.on('creds.update', auth.saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      // Gera DataURL para UI e envia via SSE
      latestQrDataUrl = await qrcode.toDataURL(qr)
      broadcastQr(latestQrDataUrl)
      logger.info('QR atualizado. Acesse /qr para visualizar e escanear.')
    }

    if (connection === 'open') {
      latestQrDataUrl = null
      broadcastQr('') // remove QR da UI
      logger.info('Conectado ao WhatsApp ✅')
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      logger.warn({ code }, 'Conexão fechada')
      if (shouldReconnect) {
        // Reabre para manter QR “vivo” até parear/conectar
        scheduleReconnect(3000)
      } else {
        logger.error('Sessão deslogada. Use /new-qr para gerar um novo QR.')
      }
    }
  })

  // Pareamento por número (opcional)
  try {
    if (!auth.state.creds?.registered && process.env.WA_PHONE_NUMBER) {
      const pairCode = await sock.requestPairingCode(process.env.WA_PHONE_NUMBER)
      logger.warn(`Código de pareamento: ${pairCode} (WhatsApp > Dispositivos conectados > "Conectar com número")`)
    }
  } catch (e) {
    logger.error(e, 'Falha ao gerar código de pareamento; use o QR em /qr.')
  }

  // Bot simples: responde "Bom dia" quando recebe "oi"
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        if (!msg.message || msg.key.fromMe) continue
        const jid = msg.key.remoteJid || ''
        if (!jid.endsWith('@s.whatsapp.net')) continue

        const text = getText(msg).trim().toLowerCase()
        if (text === 'oi') {
          await sock.sendMessage(jid, { text: 'Bom dia' }, { quoted: msg })
          logger.info({ to: jid }, 'Respondi "Bom dia"')
        }
      } catch (err) {
        logger.error(err, 'Erro ao processar mensagem')
      }
    }
  })

  isConnecting = false
}

function scheduleReconnect(ms) {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startWA().catch(err => logger.error(err, 'Erro ao reconectar'))
  }, ms)
}

async function resetSessionAndStart(forceNew = false) {
  try {
    if (sock) {
      await sock.ws?.close?.()
      sock = null
    }
  } catch {}
  if (forceNew) {
    auth.reset()
    latestQrDataUrl = null
    broadcastQr('')
  }
  await startWA()
}

// ---------- Start ----------
startWA().catch(err => logger.error(err, 'Erro fatal ao iniciar'))
