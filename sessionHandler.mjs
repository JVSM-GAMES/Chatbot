import Pino from 'pino'

const logger = Pino({ level: process.env.LOG_LEVEL || 'info' })

// Sessões por cliente
const sessions = {}

// Definição do menu
const mainMenu = {
  text: "Bem-vindo! Escolha uma opção:\n1. Produtos\n2. Suporte\n3. Falar com atendente",
  options: {
    "1": {
      text: "Menu Produtos:\n1. Produto A\n2. Produto B\n0. Voltar",
      options: {
        "1": { text: "Detalhes Produto A" },
        "2": { text: "Detalhes Produto B" },
        "0": "back"
      }
    },
    "2": {
      text: "Menu Suporte:\n1. Perguntas Frequentes\n2. Abrir Chamado\n0. Voltar",
      options: {
        "1": { text: "Veja nossas FAQs em www.site.com/faq" },
        "2": { text: "Digite seu chamado:" },
        "0": "back"
      }
    },
    "3": { text: "Um atendente entrará em contato em breve." }
  }
}

// Timeout de inatividade (5 min aviso, 10 min reset)
const INACTIVITY_WARNING = 5 * 60 * 1000
const INACTIVITY_RESET = 10 * 60 * 1000

export async function handleMessage(sock, jid, text, originalMsg) {
  if (!sessions[jid]) {
    sessions[jid] = {
      path: [],
      lastActivity: Date.now(),
      warningSent: false
    }
    await sendText(sock, jid, mainMenu.text)
  } else {
    sessions[jid].lastActivity = Date.now()
    sessions[jid].warningSent = false
  }

  checkTimeout(sock, jid)

  let session = sessions[jid]
  let currentMenu = traverseMenu(mainMenu, session.path)

  if (text === "0" && session.path.length > 0) {
    session.path.pop()
    currentMenu = traverseMenu(mainMenu, session.path)
    await sendText(sock, jid, currentMenu.text)
    return
  }

  if (currentMenu.options && currentMenu.options[text]) {
    const next = currentMenu.options[text]
    if (next === "back") {
      session.path.pop()
      const menu = traverseMenu(mainMenu, session.path)
      await sendText(sock, jid, menu.text)
    } else if (next.options) {
      session.path.push(text)
      await sendText(sock, jid, next.text)
    } else {
      await sendText(sock, jid, next.text)
    }
  } else {
    await sendText(sock, jid, "Opção inválida. Escolha novamente:\n" + currentMenu.text)
  }
}

// Função para enviar mensagem
async function sendText(sock, jid, text) {
  try {
    await sock.sendMessage(jid, { text })
    logger.info({ to: jid, text }, 'Mensagem enviada')
  } catch (err) {
    logger.error(err, 'Erro ao enviar mensagem')
  }
}

// Percorre menu conforme path da sessão
function traverseMenu(menu, path) {
  let current = menu
  for (const p of path) {
    current = current.options[p]
  }
  return current
}

// Verifica inatividade
function checkTimeout(sock, jid) {
  const session = sessions[jid]
  if (!session) return

  const now = Date.now()
  const elapsed = now - session.lastActivity

  if (!session.warningSent && elapsed > INACTIVITY_WARNING && elapsed < INACTIVITY_RESET) {
    sendText(sock, jid, "Você está inativo há 5 minutos. O atendimento será encerrado em 5 minutos se não houver resposta.")
    session.warningSent = true
  }

  if (elapsed >= INACTIVITY_RESET) {
    sendText(sock, jid, "Atendimento encerrado por inatividade. Reiniciando sessão.")
    delete sessions[jid]
  }
}
