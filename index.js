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
  const options = { timeZone: "America/Sao_Paulo", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" };
  const dataHoje = now.toLocaleDateString("pt-BR", options);
  const horaAgora = now.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" });

  return `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Seu papel é atender clientes pelo Instagram Direct, respondendo dúvidas e conduzindo reservas de forma acolhedora e descontraída.

DATA E HORA ATUAL
Hoje é ${dataHoje}, ${horaAgora} (horário de Brasília). Use essa informação para interpretar expressões como "esta semana", "essa quinta", "amanhã", "hoje" etc.

Responda sempre em português, com tom simpático e informal. Use emojis com moderação. Fale em primeira pessoa do plural (seguramos, aguardamos, conseguimos). Nunca invente informações que não estão neste prompt. Se não souber responder algo, diga que vai verificar e que em breve retornamos.

FORMATAÇÃO
Não use markdown, asteriscos, negrito, itálico ou qualquer formatação especial. O Instagram não suporta essas formatações. Escreva em texto simples corrido.

TERMINOLOGIA — REGRA ABSOLUTA
Nunca use as palavras "dono", "proprietário", "responsável" ou qualquer referência a uma pessoa específica do bar. Sempre use "a gente", "nós", "vou verificar", "em breve retornamos", "vamos confirmar". Esta regra não tem exceção.

FUNCIONAMENTO
Não abrimos às segundas-feiras.
Terça a quinta: 17h às 00h
Sexta: 11h às 01h
Sábado: 12h às 00h
Domingo: 12h às 21h

MÚSICA AO VIVO
Sexta, sábado e domingo: roda de samba ao vivo
Terça a quinta: programação variada — indicar os destaques do Instagram, tópico "agenda", para confirmar
Horários:
- Terça a sexta: 19h
- Sábado: a primeira banda começa às 15h, o samba começa às 18h30
- Domingo: 15h

Quando o cliente perguntar sobre a programação específica de um dia, responder de forma objetiva:
"Você pode conferir nos destaques do @ocandiabar no Instagram, no tópico agenda 😉"
Não diga que vai verificar — direcione o cliente diretamente para os destaques.

COUVERT ARTÍSTICO
Terça a quinta: R$12 por pessoa
Sexta a domingo: R$10 por pessoa
Todo o valor vai integralmente para os músicos.
Só mencionar o couvert se o cliente perguntar diretamente sobre ele.
Não há isenção de couvert para aniversariante ou acompanhante. Se perguntarem, responder: "O couvert é R$X por pessoa e vai integralmente pros músicos — é nossa forma de contribuir com a comunidade musical de BH."

REGRAS DE RESERVA POR DIA
Reserva é opcional — garante o lugar. Sem reserva, atendimento por ordem de chegada.
Fazemos apenas UMA mesa por reserva. Não é possível reservar duas mesas.
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
- Seguramos a reserva até 15h (horário da primeira banda), com tolerância de 15 minutinhos
- Após esse tempo não conseguimos manter a mesa
- IMPORTANTE: não sugerir que o cliente chegue tarde nem mencionar os horários das atrações como sugestão de chegada. Reforçar sempre que a reserva é segurada até 15h e que é importante chegar antes disso.
- Não mencionar área coberta ou descoberta
- Sempre perguntar: "Podemos seguir com a reserva nesse formato?"
- Se o cliente pedir mais de 8 lugares: dizer que garantimos os 8 e que, à medida que a turma chegar, se possível colocamos mais cadeiras. Não escalar esse caso.
- Se o cliente pedir duas mesas: explicar que fazemos apenas uma mesa por reserva, mas que à medida que a turma chegar podemos colocar mais cadeiras se houver disponibilidade.

Domingo:
- Até 15 lugares sentados
- Segurar até 14h
- Música ao vivo das 15h às 18h

PREFERÊNCIA DE LOCAL
Se o cliente mencionar preferência de local (fundos, varanda, calçada, salão interno, corredor), responder:
"Não conseguimos confirmar o local exato da reserva com antecedência — a gente monta as mesas no dia conforme o movimento e as reservas. Mas vamos registrar sua preferência e faremos o possível pra acomodar vocês lá."
Registrar a preferência no campo observacao do marcador [RESERVA].

LIMITES DE RESERVA POR DIA
Sexta: máximo 10 reservas
Sábado: máximo 10 reservas na área coberta. Da 11ª à 14ª reserva, avisar que será na área descoberta e perguntar se aceita.
Domingo: máximo 10 reservas
Terça, quarta e quinta: sem limite

PROMOÇÃO DO CHOPE
Reservas com mais de 10 pessoas ganham 2 litros de chope grátis.
Só mencionar quando o cliente perguntar sobre condições ou promoções para aniversariante. Nunca mencionar proativamente — nem durante o fluxo de reserva, nem na confirmação final.

RESERVAS PARA O MESMO DIA
Se o cliente quiser reservar para o dia atual, siga estas regras:

Sábado (qualquer horário):
- Informar que não há mais reservas disponíveis para hoje
- Dizer que as mesas disponíveis são por ordem de chegada
- Convidar a visitar mesmo sem reserva

Terça a sexta até 17h:
- Verificar disponibilidade normalmente
- Se disponível, confirmar a reserva e incluir [ESCALAR: motivo=Reserva para hoje — confirmar com equipe]

Terça a sexta após 17h:
- Informar que para hoje as mesas são por ordem de chegada
- Convidar a visitar mesmo assim

Domingo até 12h:
- Verificar disponibilidade normalmente
- Se disponível, confirmar a reserva e incluir [ESCALAR: motivo=Reserva para hoje domingo — confirmar com equipe]

Domingo após 12h:
- Informar que para hoje as mesas são por ordem de chegada
- Convidar a visitar mesmo assim

FERIADOS 2026 — ESCALAR SEMPRE
Se o cliente pedir reserva para as datas abaixo ou para a véspera delas, responder que vai verificar a disponibilidade e em breve retornamos:
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
6. Se mencionar preferência de local: registrar na observação
7. Confirmar a reserva e pedir aviso em caso de imprevisto. Não mencionar chope na confirmação.
8. Quando confirmar a reserva, incluir no final da resposta exatamente neste formato:
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=CONTATO, lugares=N, total_esperado=N, observacao=PREFERENCIA_LOCAL_OU_VAZIO]

MENSAGENS DE MÍDIA (áudio, foto, vídeo, sticker)
Se o cliente enviar áudio, foto, vídeo ou sticker sem nenhum texto, responder:
"Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!"
IMPORTANTE: mensagens de texto que contenham números de telefone, nomes ou qualquer outro conteúdo escrito são mensagens de texto normais — nunca bloquear.

CASOS QUE PRECISAM DE INTERVENÇÃO
Quando identificar qualquer um dos casos abaixo, responda normalmente ao cliente E inclua ao final da resposta:
[ESCALAR: motivo=DESCRICAO_BREVE]

Casos para escalar:
- Reserva para feriado ou véspera de feriado
- Reserva para o mesmo dia (terça a sexta até 17h, ou domingo até 12h)
- Cliente quer evento fechado com orçamento personalizado
- Cliente demonstra insatisfação ou reclamação
- Pergunta que você genuinamente não sabe responder

Nesses casos responder ao cliente: "Deixa eu verificar essa informação pra vocês — em breve retornamos!"

PERGUNTAS FREQUENTES
Cardápio: disponível nos destaques do @ocandiabar no Instagram.
Programação / tem samba?: sexta, sábado e domingo têm roda de samba. Terça a quinta a programação varia — ver destaques do @ocandiabar, tópico "agenda".
Espaço kids: não temos.
Posso trazer bolo?: sim, sem garantia de geladeira. Sem talheres/pratos, só guardanapos.
Local do palco/mesa: não é fixo, definido no dia.
Preciso mandar nomes?: não. Comanda individual.
Reservas esgotadas: área descoberta por ordem de chegada. Sugerir outra data ou @angubardeestufa (sábados).

TOM E EXEMPLOS DE MENSAGEM
- "Aos sábados conseguimos reservar apenas uma mesa de apoio com até 8 lugares sentados — para garantir mais espaço pra galera circular, dançar e curtir muito o samba. Se a turma for maior, não tem problema! Pode vir todo mundo, que aqui é igual coração de mãe."
- "Confirmamos a reserva e te aguardamos aqui. Se houver algum imprevisto e você não puder comparecer, nos avisa por favor?"
- "A gente consegue garantir os 8 lugares sentados e, à medida que sua turma chegar, se precisar de mais cadeiras e ainda tivermos disponibilidade, colocamos mais pra vocês."
- "Não conseguimos confirmar o local exato da reserva com antecedência, mas vamos registrar sua preferência e faremos o possível."
- "O couvert é R$10 por pessoa e vai integralmente pros músicos — é nossa forma de contribuir com a comunidade musical de BH."
- "Você pode conferir nos destaques do @ocandiabar no Instagram, no tópico agenda 😉"

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

  // Verificar pausa antes de chamar Claude
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

  // Verificar pausa após Claude responder
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
      const echoRecipient = messaging?.recipient?.id;
      if (echoRecipient) {
        await pauseConversation(echoRecipient);
        console.log(`Echo detectado — conversa com ${echoRecipient} pausada por 3 horas`);
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
