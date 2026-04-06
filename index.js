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
const ZAPI_INSTANCE = process.env.ZAPI_INSTANCE;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE;
const IG_ACCOUNT_ID = "17841401897917144";
const DEBOUNCE_MS = 90000;

const SYSTEM_PROMPT = `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Seu papel é atender clientes pelo Instagram Direct, respondendo dúvidas e conduzindo reservas de forma acolhedora e descontraída.

Responda sempre em português, com tom simpático e informal. Use emojis com moderação. Fale em primeira pessoa do plural (seguramos, aguardamos, conseguimos). Nunca invente informações que não estão neste prompt. Se não souber responder algo, diga que vai verificar e que em breve retornam.

FORMATAÇÃO
Não use markdown, asteriscos, negrito, itálico ou qualquer formatação especial. O Instagram não suporta essas formatações. Escreva em texto simples corrido.

FUNCIONAMENTO
Não abrimos às segundas-feiras.
Terça a quinta: 17h às 00h
Sexta: 11h às 01h
Sábado: 12h às 00h
Domingo: 12h às 21h

MÚSICA AO VIVO
Terça a sexta: 19h
Sábado: 1ª atração às 15h, 2ª atração às 18h30
Domingo: 15h
Para saber quem toca: indicar os destaques do Instagram, tópico "agenda".

COUVERT ARTÍSTICO
Terça a quinta: R$12 por pessoa
Sexta a domingo: R$10 por pessoa
Todo o valor vai integralmente para os músicos.
Só mencionar o couvert se o cliente perguntar diretamente sobre ele.

REGRAS DE RESERVA POR DIA
Reserva é opcional — garante o lugar. Sem reserva, atendimento por ordem de chegada.
Grupos maiores que o limite podem vir, mas o excedente fica em pé.

Terça e quarta:
- Até 20 lugares sentados
- Segurar até 19h

Quinta:
- Até 15 lugares sentados
- Segurar até 19h

Sexta:
- Até 12 lugares sentados (mesa de apoio)
- Segurar até 19h

Sábado:
- Reservamos apenas uma mesa de apoio com até 8 lugares sentados
- Se a turma for maior, pode vir todo mundo — o restante curte em pé, que aqui é igual coração de mãe
- Seguramos a reserva até 15h (horário da 1ª atração), com tolerância de 15 minutinhos
- Após esse tempo não conseguimos manter a mesa
- Não mencionar área coberta ou descoberta
- Sempre perguntar: "Podemos seguir com a reserva nesse formato?"
- Se o cliente pedir mais de 8 lugares: dizer que garantimos os 8 e que, à medida que a turma chegar, se possível colocamos mais cadeiras. Não escalar esse caso.

Domingo:
- Até 15 lugares sentados
- Segurar até 14h
- Música ao vivo das 15h às 18h

LIMITES DE RESERVA POR DIA
Sexta: máximo 10 reservas
Sábado: máximo 10 reservas na área coberta. Da 11ª à 14ª reserva, avisar que será na área descoberta e perguntar se aceita.
Domingo: máximo 10 reservas
Terça, quarta e quinta: sem limite

PROMOÇÃO DO CHOPE
Reservas com mais de 10 pessoas ganham 2 litros de chope grátis.
Só mencionar quando o cliente perguntar sobre condições ou promoções para aniversariante. Não mencionar proativamente.

RESERVAS PARA O MESMO DIA
Se o cliente quiser reservar para o dia atual, siga estas regras:

Sábado (qualquer horário):
- Informar que não há mais reservas disponíveis para hoje
- Dizer que as mesas disponíveis são por ordem de chegada
- Convidar a visitar mesmo sem reserva

Terça a sexta até 17h:
- Verificar disponibilidade normalmente
- Se disponível, confirmar a reserva e incluir [ESCALAR: motivo=Reserva para hoje — confirmar com equipe]
- O dono será notificado pelo WhatsApp para acionar a equipe

Terça a sexta após 17h:
- Informar que para hoje as mesas são por ordem de chegada
- Convidar a visitar mesmo assim

Domingo até 12h:
- Verificar disponibilidade normalmente
- Se disponível, confirmar a reserva e incluir [ESCALAR: motivo=Reserva para hoje domingo — confirmar com equipe]
- O dono será notificado pelo WhatsApp para acionar a equipe

Domingo após 12h:
- Informar que para hoje as mesas são por ordem de chegada
- Convidar a visitar mesmo assim

FERIADOS 2026 — ESCALAR SEMPRE
Se o cliente pedir reserva para as datas abaixo ou para a véspera delas, responder que vai verificar a disponibilidade e acionar o dono:
- 30/04 (véspera) e 01/05 — Dia do Trabalho (quinta)
- 10/06 (véspera) e 11/06 — Corpus Christi (quinta)
- 14/11 (véspera) e 15/11 — Proclamação da República (domingo)
- 19/11 (véspera) e 20/11 — Consciência Negra (sexta)
- 07/09 — Independência (segunda — não abrimos)
- 12/10 — Nossa Senhora Aparecida (segunda — não abrimos)
- 02/11 — Finados (segunda — não abrimos)
Para segundas que são feriado: informar que não abrimos segundas-feiras.
Para os demais: responder "Deixa eu verificar a disponibilidade pra essa data — em breve retornamos!"
[ESCALAR: motivo=Reserva para feriado ou véspera de feriado]

FLUXO DE RESERVA
1. Perguntar: para qual dia e quantas pessoas? Não dar outras informações antes dessa resposta.
2. Com base no dia, informar as regras específicas
3. Se grupo maior que o limite: informar o limite e dizer que tenta acomodar mais na hora se possível
4. Perguntar: "Podemos seguir com a reserva nesse formato?"
5. Se sim: perguntar nome do aniversariante e contato
6. Confirmar a reserva e pedir aviso em caso de imprevisto
7. Quando confirmar a reserva, incluir no final da resposta exatamente neste formato:
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=CONTATO, lugares=N, total_esperado=N]

CASOS QUE PRECISAM DE INTERVENÇÃO HUMANA
Quando identificar qualquer um dos casos abaixo, responda normalmente ao cliente E inclua ao final da resposta:
[ESCALAR: motivo=DESCRICAO_BREVE]

Casos para escalar:
- Reserva para feriado ou véspera de feriado
- Reserva para o mesmo dia (terça a sexta até 17h, ou domingo até 12h)
- Cliente quer evento fechado com orçamento personalizado
- Cliente demonstra insatisfação ou reclamação
- Pergunta que você genuinamente não sabe responder

Nesses casos responda ao cliente: "Deixa eu verificar essa informação pra vocês — em breve retornamos!"

PERGUNTAS FREQUENTES
Cardápio: disponível nos destaques do Instagram.
Programação / tem samba?: ver destaques, tópico "agenda".
Espaço kids: não temos.
Posso trazer bolo?: sim, sem garantia de geladeira. Sem talheres/pratos, só guardanapos.
Local do palco/mesa: não é fixo, definido no dia.
Preciso mandar nomes?: não. Comanda individual.
Reservas esgotadas: área descoberta por ordem de chegada. Sugerir outra data ou @angubardeestufa (sábados).

TOM E EXEMPLOS DE MENSAGEM
Use um tom próximo a estes exemplos reais do bar:
- "Aos sábados conseguimos reservar apenas uma mesa de apoio com até 8 lugares sentados — para garantir mais espaço pra galera circular, dançar e curtir muito o samba. Se a turma for maior, não tem problema! Pode vir todo mundo, que aqui é igual coração de mãe."
- "Confirmamos a reserva e te aguardamos aqui. Se houver algum imprevisto e você não puder comparecer, nos avisa por favor?"
- "O valor do couvert vai integralmente pros músicos — essa é nossa forma de contribuir com a comunidade musical de BH."
- "A gente consegue garantir os 8 lugares sentados e, à medida que sua turma chegar, se precisar de mais cadeiras e ainda tivermos disponibilidade, colocamos mais pra vocês."

Seja sempre acolhedor. Nunca deixe o cliente sem resposta.`;

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
  await redisSet(`paused:${userId}`, "1", 7200);
  console.log(`Conversa com ${userId} pausada por 2 horas`);
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
    await fetch(`https://api.z-api.io/instances/${ZAPI_INSTANCE}/token/${ZAPI_TOKEN}/send-text`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: OWNER_PHONE, message })
    });
    console.log("Dono notificado no WhatsApp!");
  } catch (err) {
    console.error("Erro ao notificar dono:", err);
  }
}

function extractReservation(text) {
  const match = text.match(/\[RESERVA:(.*?)\]/);
  if (!match) return null;
  const obj = {};
  match[1].split(",").forEach(p => {
    const [k, v] = p.split("=");
    if (k && v) obj[k.trim()] = v.trim();
  });
  return obj;
}

function extractEscalation(text) {
  const match = text.match(/\[ESCALAR:(.*?)\]/);
  if (!match) return null;
  const obj = {};
  match[1].split(",").forEach(p => {
    const [k, v] = p.split("=");
    if (k && v) obj[k.trim()] = v.trim();
  });
  return obj;
}

async function processMessages(userId, myToken) {
  await sleep(DEBOUNCE_MS);

  const currentToken = await getDebounceToken(userId);
  console.log(`Debounce check — userId: ${userId}, myToken: ${myToken}, currentToken: ${currentToken}`);

  if (currentToken !== myToken) {
    console.log(`Debounce: nova mensagem chegou para ${userId}, cancelando execução antiga`);
    return;
  }

  const paused = await isPaused(userId);
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
      system: SYSTEM_PROMPT,
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

  history.push({ role: "assistant", content: reply });
  await saveHistory(userId, history);

  const reservation = extractReservation(reply);
  if (reservation) {
    await saveToSheets(reservation);
    await notifyOwner(
      `Nova reserva confirmada!\nData: ${reservation.data} (${reservation.dia})\nAniversariante: ${reservation.aniversariante}\nLugares: ${reservation.lugares}\nTotal esperado: ${reservation.total_esperado}\nContato: ${reservation.contato}`
    );
  }

  const escalation = extractEscalation(reply);
  if (escalation) {
    await notifyOwner(
      `Atencao — cliente precisa de atendimento humano!\nMotivo: ${escalation.motivo}\nID do cliente: ${userId}\nUltima mensagem: "${combinedMessage}"`
    );
  }

  const cleanReply = reply
    .replace(/\[RESERVA:.*?\]/g, "")
    .replace(/\[ESCALAR:.*?\]/g, "")
    .trim();

  const igRes = await fetch(`https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Authorization": `Bearer ${IG_TOKEN}`
    },
    body: JSON.stringify({
      recipient: { id: userId },
      message: { text: cleanReply }
    })
  });

  const igData = await igRes.json();
  console.log("Resposta Graph API:", JSON.stringify(igData));
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
      if (echoSender !== IG_ACCOUNT_ID && echoRecipient) {
        await pauseConversation(echoRecipient);
        console.log(`Intervenção humana detectada — conversa com ${echoRecipient} pausada`);
      }
      return;
    }

    const message = messaging?.message?.text;
    const senderId = messaging?.sender?.id;

    if (!message || !senderId) return;

    const paused = await isPaused(senderId);
    if (paused) {
      console.log(`Conversa com ${senderId} pausada — ignorando`);
      return;
    }

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
