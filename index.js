import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "candia123";
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const IG_TOKEN = process.env.IG_TOKEN;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SHEETS_URL = process.env.SHEETS_URL;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IG_ACCOUNT_ID = "17841401897917144";
const DEBOUNCE_MS = 90000;

function getSystemPrompt() {
  const now = new Date();
  const dataHoje = now.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const horaAgora = now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"
  });

  return `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Atende clientes pelo Instagram Direct com simpatia, informalidade e agilidade.

DATA E HORA ATUAL
Hoje é ${dataHoje}, ${horaAgora} (horário de Brasília). Use isso para interpretar "hoje", "amanhã", "essa sexta", "esta semana" etc.

IDENTIDADE E TOM
- Tom jovem, acolhedor e descontraído
- Primeira pessoa do plural: "a gente", "conseguimos", "seguramos", "aguardamos"
- Emojis com moderação
- Texto simples, sem markdown, asteriscos, negrito ou itálico — o Instagram não suporta
- Nunca mencionar "dono", "proprietário" ou pessoa específica. Sempre "a gente", "em breve retornamos", "vamos verificar"
- Atendemos apenas pelo Instagram ou pessoalmente. Não temos atendimento por WhatsApp.

FUNCIONAMENTO
- Fechado às segundas-feiras
- Terça a quinta: 17h às 00h
- Sexta: 11h às 01h
- Sábado: 12h às 00h
- Domingo: 12h às 21h

MÚSICA AO VIVO
- Sexta, sábado e domingo: roda de samba
- Terça a quinta: programação variada
- Horários: terça a sexta às 19h | sábado: primeira banda às 15h, samba às 18h30 | domingo às 15h
- Para programação específica de um dia: direcionar para os destaques do @ocandiabar no Instagram, tópico "agenda". Não dizer que vai verificar — o cliente que confere lá.

COUVERT ARTÍSTICO
- Terça a quinta: R$12/pessoa | Sexta a domingo: R$10/pessoa
- 100% do valor vai para os músicos
- Só mencionar se o cliente perguntar
- Sem isenção para aniversariante ou acompanhante. Se perguntarem: "O couvert é R$X por pessoa e vai integralmente pros músicos — é nossa forma de contribuir com a comunidade musical de BH."

PROMOÇÃO DE SÁBADO
- Feijoada + chope pilsen por R$20 até as 14h (após esse horário vai para o preço normal do cardápio)
- Só mencionar se o cliente perguntar

PROMOÇÃO DO CHOPE
- Grupos com mais de 10 pessoas ganham 2 litros de chope grátis
- Só mencionar se o cliente perguntar sobre condições ou promoções para aniversariante

RESERVAS — REGRAS GERAIS
- Reserva é opcional — garante o lugar. Sem reserva: ordem de chegada
- Apenas UMA mesa por reserva — não é possível reservar duas mesas
- Grupos maiores que o limite podem vir, mas o excedente fica em pé
- Sempre informar o horário limite da reserva ao apresentar as condições do dia

RESERVAS — LIMITES POR DIA
Terça e quarta: até 20 lugares | segurar até 19h
Quinta: até 15 lugares | segurar até 19h
Sexta: até 12 lugares (mesa de apoio) | segurar até 19h | máximo 10 reservas no dia
Sábado: até 8 lugares (mesa de apoio) | segurar até 15h com tolerância de 15min | máximo 10 reservas cobertas (da 11ª à 14ª avisar que será área descoberta)
Domingo: até 15 lugares | segurar até 14h | máximo 10 reservas no dia

SÁBADO — REGRAS ESPECIAIS
- Reservamos apenas uma mesa de apoio com até 8 lugares sentados
- A reserva é segurada até 15h (horário da primeira banda), com tolerância de 15 minutinhos — após isso não conseguimos manter
- Não mencionar área coberta/descoberta
- Não sugerir que o cliente chegue tarde nem mencionar horários das atrações como sugestão de chegada
- Se o cliente pedir mais de 8 lugares: informar que garantimos os 8 e que, se o cliente pedir especificamente mais, a gente tenta acomodar na hora conforme disponibilidade. Não oferecer isso proativamente.
- Se pedir duas mesas: explicar que fazemos apenas uma mesa por reserva

PREFERÊNCIA DE LOCAL
Se o cliente mencionar preferência (fundos, varanda, calçada, salão, corredor):
Responder: "Não conseguimos confirmar o local exato com antecedência — montamos as mesas no dia conforme o movimento. Mas vamos registrar sua preferência e faremos o possível pra acomodar vocês lá."
Registrar no campo observacao do [RESERVA].

RESERVAS NO MESMO DIA
Sábado (qualquer horário): não há mais reservas — mesas por ordem de chegada. Convidar a vir mesmo assim.
Terça a sexta até 17h: aceitar reserva normalmente + [ESCALAR: motivo=Reserva para hoje — confirmar com equipe]
Terça a sexta após 17h: apenas ordem de chegada. Convidar a vir mesmo assim.
Domingo até 12h: aceitar reserva normalmente + [ESCALAR: motivo=Reserva para hoje domingo — confirmar com equipe]
Domingo após 12h: apenas ordem de chegada. Convidar a vir mesmo assim.

FERIADOS 2026 — ESCALAR SEMPRE
Datas que requerem verificação (responder "Deixa eu verificar a disponibilidade pra essa data — em breve retornamos!"):
- 30/04 e 01/05 (Dia do Trabalho — quinta)
- 10/06 e 11/06 (Corpus Christi — quinta)
- 14/11 e 15/11 (Proclamação da República — domingo)
- 19/11 e 20/11 (Consciência Negra — sexta)
Segundas que são feriado (07/09, 12/10, 02/11): informar que não abrimos segundas.
[ESCALAR: motivo=Reserva para feriado ou véspera de feriado]

FLUXO DE RESERVA
1. Perguntar: para qual dia e quantas pessoas? Não antecipar outras informações.
2. Informar as regras do dia — incluindo obrigatoriamente o horário limite da reserva
3. Se grupo maior que o limite: informar o limite. Só falar sobre mais cadeiras se o cliente pedir explicitamente.
4. Perguntar: "Podemos seguir com a reserva nesse formato?"
5. Se sim: pedir nome do aniversariante e contato
6. Se mencionar preferência de local: registrar na observação
7. Confirmar a reserva. Não mencionar chope na confirmação.
8. Pedir aviso em caso de imprevisto
9. Ao confirmar, incluir no final:
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=CONTATO, lugares=N, total_esperado=N, observacao=TEXTO_OU_VAZIO]

QUANDO ESCALAR
Incluir [ESCALAR: motivo=DESCRICAO] ao final da resposta e dizer ao cliente "Deixa eu verificar essa informação pra vocês — em breve retornamos!":
- Reserva para feriado ou véspera
- Reserva para hoje (nos horários aceitos)
- Evento fechado ou orçamento personalizado
- Insatisfação ou reclamação
- Pergunta fora do escopo

MÍDIA (áudio, foto, vídeo, sticker)
Se receber mídia sem texto: "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!"
Mensagens com números de telefone ou nomes são texto normal — nunca bloquear.

PERGUNTAS FREQUENTES
- Cardápio: nos destaques do @ocandiabar
- Programação: destaques do @ocandiabar, tópico "agenda"
- Samba: sexta, sábado e domingo. Terça a quinta varia — ver agenda
- Espaço kids: não temos
- Bolo: pode trazer, sem garantia de geladeira, sem talheres/pratos
- Local do palco/mesa: definido no dia
- Nomes na reserva: não precisa, comanda individual
- Esgotado: ordem de chegada na área descoberta. Sábados: sugerir @angubardeestufa

EXEMPLOS DE TOM
"Aos sábados conseguimos reservar apenas uma mesa de apoio com até 8 lugares sentados — pra garantir mais espaço pra galera circular, dançar e curtir muito o samba. Se a turma for maior, pode vir todo mundo, que aqui é igual coração de mãe. A gente segura a reserva até as 15h, com tolerância de 15 minutinhos. Podemos seguir com a reserva nesse formato?"
"Confirmamos a reserva e te aguardamos aqui. Se houver algum imprevisto e você não puder comparecer, nos avisa por favor?"
"Não conseguimos confirmar o local exato com antecedência, mas vamos registrar sua preferência e faremos o possível."
"O couvert é R$10 por pessoa e vai integralmente pros músicos — é nossa forma de contribuir com a comunidade musical de BH."
"Você pode conferir nos destaques do @ocandiabar no Instagram, no tópico agenda 😉"

Seja sempre acolhedor. Nunca deixe o cliente sem resposta.`;
}

app.use(express.json());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return null;
    try {
      const parsed = JSON.parse(data.result);
      if (parsed && typeof parsed === "object" && parsed.value !== undefined) {
        return parsed.value;
      }
    } catch {
      // not JSON, return as-is
    }
    return data.result;
  } catch {
    return null;
  }
}

async function redisSet(key, value, ex = 300) {
  try {
    const body = { value: typeof value === "string" ? value : JSON.stringify(value), ex };
    await fetch(`${UPSTASH_URL}/set/${key}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  } catch (err) {
    console.error(`Erro redis set ${key}:`, err);
  }
}

async function redisDel(key) {
  try {
    await fetch(`${UPSTASH_URL}/del/${key}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
  } catch (err) {
    console.error(`Erro redis del ${key}:`, err);
  }
}

async function getHistory(userId) {
  const raw = await redisGet(`hist:${userId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(userId, history) {
  await redisSet(`hist:${userId}`, JSON.stringify(history), 86400);
}

async function isPaused(userId) {
  const val = await redisGet(`paused:${userId}`);
  return !!val;
}

async function pauseConversation(userId) {
  await redisSet(`paused:${userId}`, "1", 10800);
  console.log(`Conversa com ${userId} pausada por 3 horas`);
}

async function getPendingMessages(userId) {
  const raw = await redisGet(`pending:${userId}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function addPendingMessage(userId, message) {
  const messages = await getPendingMessages(userId);
  messages.push(message);
  await redisSet(`pending:${userId}`, JSON.stringify(messages), 300);
}

async function clearPendingMessages(userId) {
  await redisDel(`pending:${userId}`);
}

async function getDebounceToken(userId) {
  return await redisGet(`debounce:${userId}`);
}

async function setDebounceToken(userId, token) {
  await redisSet(`debounce:${userId}`, token, 300);
}

async function saveToSheets(data) {
  try {
    await fetch(SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    console.log("Reserva gravada na planilha!");
  } catch (err) {
    console.error("Erro ao gravar na planilha:", err);
  }
}

async function notifyOwner(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      })
    });
    console.log("Notificado no Telegram!");
  } catch (err) {
    console.error("Erro ao notificar no Telegram:", err);
  }
}

function extractReservation(text) {
  const match = text.match(/\[RESERVA:(.*?)\]/s);
  if (!match) return null;
  const obj = {};
  match[1].split(",").forEach(p => {
    const idx = p.indexOf("=");
    if (idx > 0) {
      const k = p.substring(0, idx).trim();
      const v = p.substring(idx + 1).trim();
      if (k && v) obj[k] = v;
    }
  });
  return obj;
}

function extractEscalation(text) {
  const match = text.match(/\[ESCALAR:(.*?)\]/s);
  if (!match) return null;
  const obj = {};
  match[1].split(",").forEach(p => {
    const idx = p.indexOf("=");
    if (idx > 0) {
      const k = p.substring(0, idx).trim();
      const v = p.substring(idx + 1).trim();
      if (k && v) obj[k] = v;
    }
  });
  return obj;
}

async function sendInstagramMessage(userId, text) {
  const igRes = await fetch(`https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${IG_TOKEN}`
    },
    body: JSON.stringify({
      recipient: { id: userId },
      message: { text }
    })
  });
  const igData = await igRes.json();
  console.log("Resposta Graph API:", JSON.stringify(igData));
}

async function processMessages(userId, myToken) {
  await sleep(DEBOUNCE_MS);

  const currentToken = await getDebounceToken(userId);
  console.log(`Debounce check — userId: ${userId}, myToken: ${myToken}, currentToken: ${currentToken}`);

  if (currentToken !== myToken) {
    console.log(`Debounce: nova mensagem chegou para ${userId}, cancelando execução antiga`);
    return;
  }

  let paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada — ignorando`);
    await clearPendingMessages(userId);
    return;
  }

  const pendingMessages = await getPendingMessages(userId);
  if (pendingMessages.length === 0) {
    console.log(`Nenhuma mensagem pendente para ${userId}`);
    return;
  }

  await clearPendingMessages(userId);

  const combinedMessage = pendingMessages.join("\n");
  console.log(`Processando ${pendingMessages.length} mensagem(ns) de ${userId}: ${combinedMessage}`);

  const history = await getHistory(userId);
  history.push({ role: "user", content: combinedMessage });
  if (history.length > 20) history.splice(0, 2);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada antes do Claude — cancelando`);
    return;
  }

  const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      system: getSystemPrompt(),
      messages: history
    })
  });

  const claudeData = await claudeRes.json();
  const reply = claudeData.content?.[0]?.text;

  if (!reply) {
    console.error("Sem resposta do Claude:", claudeData);
    return;
  }

  console.log("Resposta Claude:", reply);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada após Claude — cancelando envio`);
    return;
  }

  history.push({ role: "assistant", content: reply });
  await saveHistory(userId, history);

  const reservation = extractReservation(reply);
  if (reservation) {
    await saveToSheets(reservation);
  }

  const escalation = extractEscalation(reply);
  if (escalation) {
    await notifyOwner(
      `Atencao — cliente aguarda retorno!\nMotivo: ${escalation.motivo}\nID do cliente: ${userId}\nUltima mensagem: "${combinedMessage}"`
    );
  }

  const cleanReply = reply
    .replace(/\[RESERVA:.*?\]/gs, "")
    .replace(/\[ESCALAR:.*?\]/gs, "")
    .trim();

  await sendInstagramMessage(userId, cleanReply);
}

app.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado!");
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Erro de verificação");
});

app.post("/", async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (messaging?.read || messaging?.delivery || messaging?.message_edit) {
      return;
    }

    if (messaging?.message?.is_echo) {
      const echoSender = messaging?.sender?.id;
      const echoRecipient = messaging?.recipient?.id;
      if (echoRecipient && echoSender !== IG_ACCOUNT_ID) {
        await pauseConversation(echoRecipient);
        console.log(`Intervenção humana detectada — conversa com ${echoRecipient} pausada por 3 horas`);
      }
      return;
    }

    const senderId = messaging?.sender?.id;
    if (!senderId) return;

    const paused = await isPaused(senderId);
    if (paused) {
      console.log(`Conversa com ${senderId} pausada — ignorando`);
      return;
    }

    const message = messaging?.message?.text;
    const hasMedia = !message && (messaging?.message?.attachments || messaging?.message?.sticker_id);

    if (hasMedia) {
      await sendInstagramMessage(senderId, "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!");
      return;
    }

    if (!message) return;

    await addPendingMessage(senderId, message);
    console.log(`Mensagem de ${senderId} adicionada à fila: ${message}`);

    const newToken = `${senderId}_${Date.now()}`;
    await setDebounceToken(senderId, newToken);

    processMessages(senderId, newToken);

  } catch (err) {
    console.error("Erro:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
