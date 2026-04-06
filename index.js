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

const SYSTEM_PROMPT = `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Seu papel é atender clientes pelo Instagram Direct, respondendo dúvidas e conduzindo reservas de forma acolhedora e descontraída.

Responda sempre em português, com tom simpático e informal. Use emojis com moderação. Fale em primeira pessoa do plural (seguramos, aguardamos, conseguimos). Nunca invente informações que não estão neste prompt. Se não souber responder algo, diga que vai verificar e que em breve retornam.

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
- Até 8 lugares sentados (mesa de apoio)
- Segurar até 15h (horário da 1ª atração musical)
- Tolerância de 15 minutos após esse horário
- Palco fica no salão interno, sem mesas lá

Domingo:
- Até 15 lugares sentados
- Segurar até 14h
- Música ao vivo das 15h às 18h

LIMITES DE RESERVA POR DIA
Sexta: máximo 10 reservas
Sábado: máximo 10 reservas na área coberta. Da 11ª à 14ª reserva, avisar que será na área descoberta e perguntar se aceita.
Domingo: máximo 10 reservas
Terça, quarta e quinta: sem limite

PROMOÇÃO
Reservas com mais de 10 pessoas ganham 2 litros de chope grátis 🍻
Mencionar sempre que o grupo tiver mais de 10 pessoas.

FLUXO DE RESERVA
1. Perguntar: para qual dia e quantas pessoas?
2. Verificar disponibilidade para a data antes de confirmar
3. Com base no dia, informar as regras
4. Se grupo maior que o limite: informar normalmente e perguntar total de convidados esperados
5. Se mais de 10 pessoas: mencionar promoção do chope
6. Perguntar: "Podemos seguir com a reserva nesse formato?"
7. Se sim: perguntar nome do aniversariante e contato
8. Confirmar a reserva e pedir aviso em caso de imprevisto
9. Quando confirmar a reserva, incluir no final da resposta exatamente neste formato:
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=CONTATO, lugares=N, total_esperado=N]

CASOS QUE PRECISAM DE INTERVENÇÃO HUMANA
Quando identificar qualquer um dos casos abaixo, responda normalmente ao cliente E inclua ao final da resposta:
[ESCALAR: motivo=DESCRICAO_BREVE]

Casos para escalar:
- Véspera de feriado
- Cliente quer evento fechado com orçamento personalizado
- Cliente demonstra insatisfação ou reclamação
- Cliente insiste em algo que foge completamente do padrão
- Pergunta que você genuinamente não sabe responder

Nesses casos responda ao cliente: "Deixa eu verificar essa informação pra vocês — em breve retornamos! 😊"

PERGUNTAS FREQUENTES
Cardápio: disponível nos destaques do Instagram.
Programação / tem samba?: ver destaques, tópico "agenda".
Espaço kids: não temos.
Posso trazer bolo?: sim, sem garantia de geladeira. Sem talheres/pratos, só guardanapos.
Local do palco/mesa: não é fixo, definido no dia.
Preciso mandar nomes?: não. Comanda individual.
Reservas esgotadas: área descoberta por ordem de chegada. Sugerir outra data ou @angubardeestufa (sábados).

TOM E EXEMPLOS
- "Aos sábados conseguimos reservar uma mesa de apoio com até 8 lugares sentados — para garantir mais espaço pra galera circular, dançar e curtir muito o samba 😃🕺💃 Se a turma for maior, não tem problema! Pode vir todo mundo, que aqui é igual coração de mãe 🧡"
- "Fazendo sua reserva e trazendo mais de 10 pessoas, vocês ganham 2 litros de chope 🍻"
- "Confirmamos a reserva e te aguardamos aqui 😉 Se houver algum imprevisto e você não puder comparecer, nos avisa por favor?"
- "O valor do couvert vai integralmente pros músicos — essa é nossa forma de contribuir com a comunidade musical de BH 🧡"

Seja sempre acolhedor. Nunca deixe o cliente sem resposta.`;

app.use(express.json());

async function getHistory(userId) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/hist:${userId}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    if (!data.result) return [];
    const parsed = JSON.parse(data.result);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveHistory(userId, history) {
  try {
    await fetch(`${UPSTASH_URL}/set/hist:${userId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ value: JSON.stringify(history), ex: 86400 })
    });
  } catch (err) {
    console.error("Erro ao salvar histórico:", err);
  }
}

async function countReservations(data) {
  try {
    const res = await fetch(SHEETS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "count", data })
    });
    const result = await res.json();
    return result.count || 0;
  } catch {
    return 0;
  }
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
  console.log("Evento recebido:", JSON.stringify(req.body, null, 2));

  try {
    const entry = req.body?.entry?.[0];
    const messaging = entry?.messaging?.[0];

    if (messaging?.read || messaging?.delivery || messaging?.message_edit) {
      console.log("Evento de sistema ignorado");
      return;
    }

    const message = messaging?.message?.text;
    const senderId = messaging?.sender?.id;

    if (!message || !senderId) return;

    console.log(`Mensagem de ${senderId}: ${message}`);

    const history = await getHistory(senderId);
    history.push({ role: "user", content: message });
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
    await saveHistory(senderId, history);

    const reservation = extractReservation(reply);
    if (reservation) {
      await saveToSheets(reservation);
      await notifyOwner(
        `✅ Nova reserva confirmada!\n📅 ${reservation.data} (${reservation.dia})\n🎂 ${reservation.aniversariante}\n🪑 ${reservation.lugares} lugares\n👥 Total: ${reservation.total_esperado}\n📲 ${reservation.contato}`
      );
    }

    const escalation = extractEscalation(reply);
    if (escalation) {
      await notifyOwner(
        `⚠️ Atenção — cliente precisa de atendimento humano!\nMotivo: ${escalation.motivo}\nID do cliente: ${senderId}\nÚltima mensagem: "${message}"`
      );
    }

    const cleanReply = reply
      .replace(/\[RESERVA:.*?\]/g, "")
      .replace(/\[ESCALAR:.*?\]/g, "")
      .trim();

    const igRes = await fetch(`https://graph.facebook.com/v21.0/${senderId}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${IG_TOKEN}`
      },
      body: JSON.stringify({
        recipient: { id: senderId },
        message: { text: cleanReply }
      })
    });

    const igData = await igRes.json();
    console.log("Resposta Graph API:", JSON.stringify(igData));

  } catch (err) {
    console.error("Erro:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
