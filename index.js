import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = "candia123";
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const IG_TOKEN = process.env.IG_TOKEN;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IG_ACCOUNT_ID = "17841401897917144";
const DEBOUNCE_MS = 300000; // 5 minutos
const PAUSA_INTERVENCAO_MS = 18000; // 5 horas em segundos
const FOLLOWUP_MS = 6 * 60 * 60 * 1000; // 6 horas

// Horário de funcionamento do bot (Brasília)
const BOT_HORA_INICIO = 9;
const BOT_HORA_FIM = 22;

const LIMITES = {
  "sexta":   { coberto: 10, descoberto: 0,  total: 10 },
  "sábado":  { coberto: 10, descoberto: 4,  total: 14 },
  "domingo": { coberto: 10, descoberto: 0,  total: 10 }
};

function isHorarioComercial() {
  const now = new Date();
  const hora = parseInt(now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false
  }));
  return hora >= BOT_HORA_INICIO && hora < BOT_HORA_FIM;
}

function getHoraBrasilia() {
  const now = new Date();
  return parseInt(now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false
  }));
}

function getMinutoBrasilia() {
  const now = new Date();
  return parseInt(now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", minute: "2-digit"
  }));
}

function getDiaSemana(dataStr) {
  const [dia, mes, ano] = dataStr.split("/");
  const d = new Date(`${ano}-${mes}-${dia}`);
  const dias = ["domingo","segunda","terça","quarta","quinta","sexta","sábado"];
  return dias[d.getDay()];
}

function convertDateToISO(dateStr) {
  const [dia, mes, ano] = dateStr.split("/");
  return `${ano}-${mes.padStart(2,"0")}-${dia.padStart(2,"0")}`;
}

function formatDiaNotion(dia, data) {
  if (!dia || !data) return dia || "";
  const parts = data.split("/");
  if (parts.length < 2) return dia;
  return `${dia} - ${parts[0]}/${parts[1]}`;
}

function getTodayISO() {
  const now = new Date();
  return now.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit"
  }).split("/").reverse().join("-");
}

function getDatePlusDaysISO(days) {
  const now = new Date();
  const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  brt.setDate(brt.getDate() + days);
  const y = brt.getFullYear();
  const m = String(brt.getMonth() + 1).padStart(2, "0");
  const d = String(brt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function contarReservasNotion(dataStr) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: {
          property: "Data",
          rich_text: { equals: convertDateToISO(dataStr) }
        }
      })
    });
    const data = await res.json();
    return data.results?.length || 0;
  } catch (err) {
    console.error("Erro ao contar reservas no Notion:", err);
    return 0;
  }
}

async function verificarDisponibilidade(dataStr) {
  const diaSemana = getDiaSemana(dataStr);
  const dataISO = convertDateToISO(dataStr);

  // Override manual tem prioridade sobre o Notion
  const override = await getOverride(dataISO);
  if (override === "esg") return { disponivel: false, tipo: "esgotado", override: true, diaSemana };
  if (override === "ext") return { disponivel: true, tipo: "descoberto", override: true, vagasDescoberto: 1, diaSemana };

  const limite = LIMITES[diaSemana];
  if (!limite) return { disponivel: true, tipo: "ilimitado", diaSemana };
  const count = await contarReservasNotion(dataStr);
  if (count >= limite.total) return { disponivel: false, tipo: "esgotado", count, limite, diaSemana };
  if (count >= limite.coberto) {
    return { disponivel: true, tipo: "descoberto", count, limite, vagasDescoberto: limite.total - count, diaSemana };
  }
  return { disponivel: true, tipo: "coberto", count, limite, vagasCoberto: limite.coberto - count, diaSemana };
}

async function salvarReservaNaNotion(data, instagramId) {
  try {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_DB_ID },
        properties: {
          "Nome": { title: [{ text: { content: data.aniversariante || "" } }] },
          "Data": { rich_text: [{ text: { content: convertDateToISO(data.data) } }] },
          "Dia": { rich_text: [{ text: { content: formatDiaNotion(data.dia, data.data) } }] },
          "Contato": { rich_text: [{ text: { content: data.contato || "" } }] },
          "Lugares": { number: parseInt(data.lugares) || 0 },
          "Total esperado": { number: parseInt(data.total_esperado) || 0 },
          "Observações": { rich_text: [{ text: { content: data.observacao || "" } }] },
          "Instagram ID": { rich_text: [{ text: { content: instagramId || "" } }] },
          "Confirmado": { select: { name: "⏳ Pendente" } }
        }
      })
    });
    const result = await res.json();
    if (result.id) {
      console.log("Reserva gravada no Notion:", result.id);
    } else {
      console.error("Erro ao gravar no Notion:", JSON.stringify(result));
    }
  } catch (err) {
    console.error("Erro ao gravar reserva no Notion:", err);
  }
}

// Overrides manuais via Telegram
async function setOverride(dataISO, tipo) {
  // tipo: "ext" (apenas externa) ou "esg" (esgotado)
  await redisSet(`override:${dataISO}`, tipo, 86400 * 7);
  console.log(`Override ${tipo} setado para ${dataISO}`);
}

async function getOverride(dataISO) {
  return await redisGet(`override:${dataISO}`);
}

async function clearOverride(dataISO) {
  await redisDel(`override:${dataISO}`);
  console.log(`Override removido para ${dataISO}`);
}

async function buscarReservasPorData(dataISO) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: {
          property: "Data",
          rich_text: { equals: dataISO }
        }
      })
    });
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error("Erro ao buscar reservas:", err);
    return [];
  }
}

async function buscarReservasGravatasHoje() {
  // Busca pelo campo Data igual a hoje
  return await buscarReservasPorData(getTodayISO());
}

async function limparReservasAntigas() {
  try {
    const hoje = getTodayISO();
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({ page_size: 100 })
    });
    const data = await res.json();
    const pages = data.results || [];

    let deletadas = 0;
    for (const page of pages) {
      const dataReserva = page.properties?.Data?.rich_text?.[0]?.text?.content || "";
      if (dataReserva && dataReserva < hoje) {
        await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${NOTION_TOKEN}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28"
          },
          body: JSON.stringify({ archived: true })
        });
        deletadas++;
      }
    }
    return deletadas;
  } catch (err) {
    console.error("Erro ao limpar reservas:", err);
    throw err;
  }
}

// Envia lembretes 2 dias antes para todas as reservas do dia
async function enviarLembretes2Dias() {
  const targetDate = getDatePlusDaysISO(2);
  console.log(`Enviando lembretes para reservas de ${targetDate}...`);
  const reservas = await buscarReservasPorData(targetDate);

  if (reservas.length === 0) {
    console.log("Nenhuma reserva encontrada para daqui 2 dias.");
    return;
  }

  let falhas = [];
  for (const reserva of reservas) {
    const nome = reserva.properties?.Nome?.title?.[0]?.text?.content || "cliente";
    const igId = reserva.properties?.["Instagram ID"]?.rich_text?.[0]?.text?.content || "";
    const contato = reserva.properties?.Contato?.rich_text?.[0]?.text?.content || "";
    const dataReserva = reserva.properties?.Data?.rich_text?.[0]?.text?.content || "";
    const dia = reserva.properties?.Dia?.rich_text?.[0]?.text?.content || "";

    if (!igId) {
      falhas.push(`${nome} (sem Instagram ID — contato: ${contato})`);
      continue;
    }

    try {
      const igRes = await fetch(`https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${IG_TOKEN}`
        },
        body: JSON.stringify({
          recipient: { id: igId },
          message: { text: `Oi, ${nome.split(" ")[0]}! 😊 Passando pra confirmar sua reserva no Candiá no dia ${dia}. Tudo certo pra comemorar com a gente? 🎉` }
        })
      });
      const igData = await igRes.json();
      if (igData.error) {
        falhas.push(`${nome} (erro: ${igData.error.message} — contato: ${contato})`);
      } else {
        console.log(`Lembrete enviado para ${nome} (${igId})`);
      }
    } catch (err) {
      falhas.push(`${nome} (erro de rede — contato: ${contato})`);
    }
  }

  if (falhas.length > 0) {
    await notifyOwner(`⚠️ Lembretes não enviados (${falhas.length}):\n${falhas.map(f => `• ${f}`).join("\n")}\nEntre em contato manualmente.`);
  } else {
    await notifyOwner(`✅ Lembretes enviados para ${reservas.length} reserva(s) do dia ${targetDate}.`);
  }
}

// Resumo diário às 22h01
async function enviarResumoDiario() {
  console.log("Enviando resumo diário...");
  const reservas = await buscarReservasGravatasHoje();

  if (reservas.length === 0) {
    await notifyOwner("📋 Resumo do dia: nenhuma reserva gravada hoje.");
    return;
  }

  const linhas = reservas.map(r => {
    const nome = r.properties?.Nome?.title?.[0]?.text?.content || "—";
    const dia = r.properties?.Dia?.rich_text?.[0]?.text?.content || "—";
    const lugares = r.properties?.Lugares?.number || "—";
    const total = r.properties?.["Total esperado"]?.number || "—";
    const obs = r.properties?.Observações?.rich_text?.[0]?.text?.content || "";
    return `• ${nome} | ${dia} | ${lugares} lugares | ${total} esperados${obs ? ` | ${obs}` : ""}`;
  });

  await notifyOwner(`📋 Reservas gravadas hoje (${getTodayISO()}):\n${linhas.join("\n")}`);
}

function agendarLimpezaSemanal() {
  function calcularProximaSegunda10h() {
    const now = new Date();
    const nowBrasilia = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const diaSemana = nowBrasilia.getDay();
    const hora = nowBrasilia.getHours();
    const minuto = nowBrasilia.getMinutes();

    let diasAteSegunda = (1 - diaSemana + 7) % 7;
    if (diasAteSegunda === 0 && (hora > 10 || (hora === 10 && minuto > 0))) {
      diasAteSegunda = 7;
    }

    const proximaSegunda = new Date(nowBrasilia);
    proximaSegunda.setDate(nowBrasilia.getDate() + diasAteSegunda);
    proximaSegunda.setHours(10, 0, 0, 0);
    return proximaSegunda.getTime() - nowBrasilia.getTime();
  }

  function executarLimpeza() {
    console.log("Executando limpeza automatica semanal...");
    limparReservasAntigas()
      .then(n => notifyOwner(`🗑 Limpeza automática concluída: ${n} reserva(s) antiga(s) removida(s).`))
      .catch(err => notifyOwner(`⚠️ Erro na limpeza automática: ${err.message}`));
    setTimeout(() => setTimeout(executarLimpeza, calcularProximaSegunda10h()), 1000);
  }

  const ms = calcularProximaSegunda10h();
  console.log(`Limpeza automática agendada em ${Math.round(ms / 3600000)}h`);
  setTimeout(executarLimpeza, ms);
}

// Agenda rotinas diárias: lembretes às 9h e resumo às 22h01
function agendarRotinasDiarias() {
  function msAteHorario(hora, minuto = 0) {
    const now = new Date();
    const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const target = new Date(brt);
    target.setHours(hora, minuto, 0, 0);
    if (target <= brt) target.setDate(target.getDate() + 1);
    return target.getTime() - brt.getTime();
  }

  function agendarLembretes() {
    const ms = msAteHorario(9, 0);
    console.log(`Lembretes agendados em ${Math.round(ms / 3600000)}h`);
    setTimeout(() => {
      enviarLembretes2Dias().catch(err => console.error("Erro nos lembretes:", err));
      setTimeout(agendarLembretes, 1000);
    }, ms);
  }

  function agendarResumo() {
    const ms = msAteHorario(22, 1);
    console.log(`Resumo diário agendado em ${Math.round(ms / 3600000)}h`);
    setTimeout(() => {
      enviarResumoDiario().catch(err => console.error("Erro no resumo:", err));
      setTimeout(agendarResumo, 1000);
    }, ms);
  }

  agendarLembretes();
  agendarResumo();
}

function getSystemPrompt(disponibilidade) {
  const now = new Date();
  const dataHoje = now.toLocaleDateString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const horaAgora = now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit"
  });

  const dispInfo = disponibilidade
    ? `\nDISPONIBILIDADE CONSULTADA PARA A DATA SOLICITADA\n${disponibilidade}\n`
    : "";

  return `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Atende clientes pelo Instagram Direct.

DATA E HORA ATUAL
Hoje é ${dataHoje}, ${horaAgora} (horário de Brasília). Use isso para interpretar "hoje", "amanhã", "essa sexta", "esta semana" etc.
${dispInfo}
IDENTIDADE E TOM
- Simpático, alegre, acolhedor e descontraído — mas sempre focado em responder apenas o que foi perguntado
- Primeira pessoa do plural: "a gente", "conseguimos", "seguramos", "aguardamos"
- Emojis com moderação
- Texto simples, sem markdown, asteriscos, negrito ou itálico — o Instagram não suporta
- Nunca mencionar "dono", "proprietário" ou pessoa específica, exceto o gerente João quando o cliente disser que vai pessoalmente
- Atendemos apenas pelo Instagram ou pessoalmente. Não temos atendimento por WhatsApp.

REGRA GERAL
- Responda apenas o que foi perguntado, de forma direta e simpática
- Nunca sugira reserva, promoções, programação ou qualquer informação extra que o cliente não pediu
- Respostas curtas são bem-vindas quando a pergunta é simples — "Sim", "R$10 por pessoa", "Varia bastante!" são respostas válidas
- Simpatia sim, prolixidade não

FUNCIONAMENTO
- Fechado às segundas-feiras
- Terça a quinta: 17h às 00h
- Sexta: 11h às 01h
- Sábado: 12h às 00h
- Domingo: 12h às 21h

MÚSICA AO VIVO
- Sexta, sábado e domingo: roda de samba
- Terça a quinta: programação variada
- Horários: terça a sexta às 19h | sábado: primeira banda às 15h, samba às 18h30 até às 21h30 | domingo às 15h
- Sábado à noite: informar diretamente "Temos sim! O samba começa às 18h30 e vai até às 21h30"
- Para programação específica de um dia: direcionar para os destaques do @ocandiabar no Instagram, tópico "agenda". Não dizer que vai verificar — o cliente que confere lá.
- Transmissão de jogo: transmitimos sem som

COUVERT ARTÍSTICO
- Terça a quinta: R$12/pessoa | Sexta a domingo: R$10/pessoa
- 100% do valor vai para os músicos
- NUNCA mencionar o couvert a menos que o cliente pergunte diretamente
- Se perguntarem: responder diretamente o valor. Ex: "R$10 por pessoa" (sex/sáb/dom) ou "R$12 por pessoa" (ter/qua/qui)
- Sem isenção para aniversariante ou acompanhante

PROMOÇÃO DE SÁBADO
- Feijoada + chope pilsen 300ml por R$20 até as 14h
- Só mencionar se o cliente perguntar

PROMOÇÃO DO CHOPE PARA GRUPOS
- Grupos com mais de 10 pessoas ganham 2 litros de chope grátis
- Só mencionar se o cliente perguntar sobre condições especiais ou promoções para aniversariante
- NUNCA dizer que "não tem promoção" — simplesmente não mencionar a menos que perguntem

RESERVAS — REGRAS GERAIS
- Reserva é opcional — garante o lugar. Sem reserva: ordem de chegada
- Apenas UMA mesa por reserva — não é possível reservar duas mesas. Se pedirem duas: negar educadamente sem escalar
- Se o grupo for maior que o limite: informar quantos lugares sentados conseguimos garantir e dizer que o espaço comporta todo mundo à vontade — quem não tiver assento fica em volta da mesa curtindo e sambando. Nunca dizer "em pé" ou "circulando"
- Só mencionar a possibilidade de mais cadeiras se o cliente pedir explicitamente mais lugares do que o limite
- Sempre informar o horário limite da reserva ao apresentar as condições do dia
- Após o horário limite: mesas por ordem de chegada, sem nenhuma garantia adicional
- IMPORTANTE: nunca aceitar reserva com base apenas em "sábado", "essa sexta", "semana que vem" etc. Exigir data com número explícito (ex: "11/04", "11 de abril", "sábado dia 11"). Se o cliente disser só o dia da semana: perguntar "Qual a data certinha? (dia e mês)"

RESERVAS — LIMITES POR DIA
Terça e quarta: até 20 lugares | segurar até 19h | sem limite de reservas
Quinta: até 15 lugares | segurar até 19h | sem limite de reservas
Sexta: até 12 lugares | segurar até 19h | máximo 10 reservas
Sábado: até 8 lugares | segurar até 15h com tolerância de 15min | máximo 10 reservas cobertas + até 4 descobertas
Domingo: até 15 lugares | segurar até 14h | máximo 10 reservas

SÁBADO — REGRAS ESPECIAIS
- Reservamos apenas uma mesa de apoio com até 8 lugares sentados
- A reserva é segurada até 15h, com tolerância de 15 minutinhos — após isso não conseguimos manter
- Se o cliente não puder chegar até 15h: "Pode vir à vontade! A casa sempre comporta todo mundo 😊" — não mencionar reserva nem dar entender que haverá lugar guardado
- Não mencionar área coberta/descoberta a menos que a disponibilidade consultada indique área descoberta
- Após 15h: mesas por ordem de chegada, sem garantia alguma
- Palco fica no salão interno. Aos sábados não há mesas no salão — a galera curte por lá em volta da música
- Se pedir duas mesas: explicar que fazemos apenas uma mesa por reserva, sem escalar

TERÇA A QUINTA — CHEGADA APÓS 19H
Se o cliente pedir para chegar após 19h (terça a quinta): "Deixa eu verificar pra vocês — em breve retornamos!" + [ESCALAR: motivo=Cliente quer chegar após 19h em dia de semana — verificar disponibilidade]

CLIENTE VAI PESSOALMENTE
Se o cliente disser que vai ao bar conversar pessoalmente ou resolver pessoalmente:
"Será um prazer receber vocês! Pode chegar e perguntar pelo João, nosso gerente 😊"

DISPONIBILIDADE EM TEMPO REAL
Quando disponibilidade for informada acima, use para:
- Se esgotado: usar exatamente este texto: "Infelizmente estamos com as reservas esgotadas para este dia 😑. As mesas ainda disponíveis ficam na área descoberta e são por ordem de chegada. Abrimos às 12h30.\nMas aqui é um bar onde a galera fica mais em pé, então é só chegar, mesmo sem reserva, que cabe todo mundo 🧡\nSe preferir, ainda temos disponibilidade de reserva aqui no Candiá na sexta ou no domingo, ou no sábado em nossa outra casa — o @angubardeestufa"
- Se área descoberta disponível: avisar que a reserva será na área externa (descoberta) e perguntar se aceita
- Se coberto disponível: prosseguir normalmente
- Se sem limite (terça a quinta): prosseguir normalmente

PREFERÊNCIA DE LOCAL
Se o cliente mencionar preferência (fundos, varanda, calçada, salão, corredor, próximo à banda):
Responder: "A banda e as mesas nem sempre ficam nos mesmos lugares — montamos no dia conforme a capacidade, número de reservas e antecedência dos pedidos. Mas vamos registrar sua preferência e tentamos colocar onde você sugeriu!"
Registrar no campo observacao do [RESERVA].

RESERVAS NO MESMO DIA
Sábado (qualquer horário): não há mais reservas — mesas por ordem de chegada. Convidar a vir mesmo assim.
Terça a sexta até 17h: aceitar reserva normalmente + [ESCALAR: motivo=Reserva para hoje — confirmar com equipe]
Terça a sexta após 17h: apenas ordem de chegada. Convidar a vir mesmo assim.
Domingo até 12h: aceitar reserva normalmente + [ESCALAR: motivo=Reserva para hoje domingo — confirmar com equipe]
Domingo após 12h: apenas ordem de chegada. Convidar a vir mesmo assim.

FERIADOS 2026 — ESCALAR SEMPRE
Datas que requerem verificação:
- 30/04 e 01/05 (Dia do Trabalho)
- 10/06 e 11/06 (Corpus Christi)
- 14/11 e 15/11 (Proclamação da República)
- 19/11 e 20/11 (Consciência Negra)
Segundas que são feriado (07/09, 12/10, 02/11): informar que não abrimos segundas.
Quando escalar: responder apenas "Deixa eu verificar a disponibilidade pra essa data — em breve retornamos!" Não fazer perguntas adicionais.
[ESCALAR: motivo=Reserva para feriado ou véspera de feriado]

MÚSICOS QUE SE CANDIDATAM
Se alguém se apresentar como músico interessado em tocar no Candiá:
"A gente ama essa energia dos músicos de BH! 🎶 No momento estamos com a agenda bem preenchida com a galera que já toca aqui, mas deixa seu material registrado — havendo oportunidade, a gente entra em contato!"
Não escalar. Não continuar o papo além disso.

FLUXO DE RESERVA
1. Perguntar: para qual dia e quantas pessoas? Não antecipar outras informações.
2. Aguardar o cliente informar uma data com número explícito (ex: "11/04", "11 de abril", "sábado dia 11"). Nunca prosseguir com só "sábado" ou "essa sexta" — perguntar a data certinha.
3. Informar as regras do dia com base na disponibilidade — incluindo obrigatoriamente o horário limite
4. Se esgotado: informar e sugerir outra data
5. Se área descoberta: avisar que é área externa e perguntar se aceita
6. Se disponível: perguntar "Podemos seguir com a reserva nesse formato?"
7. Se sim: pedir nome do aniversariante e contato
8. Se mencionar preferência de local: registrar na observação
9. Confirmar a reserva. Não mencionar chope nem couvert na confirmação.
10. Pedir aviso em caso de imprevisto
11. Ao confirmar, incluir no final da mensagem (invisível para o cliente):
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=CONTATO, lugares=N, total_esperado=N, observacao=TEXTO_OU_VAZIO]
- Se a reserva for em área externa/descoberta: incluir "Área externa (descoberta)" no campo observacao
- No campo observacao: registrar apenas preferências de local, área externa ou observações relevantes. Nunca registrar que pessoas ficarão em volta da mesa.

QUANDO ESCALAR
Incluir [ESCALAR: motivo=DESCRICAO] ao final e responder apenas "Deixa eu verificar essa informação pra vocês — em breve retornamos!" sem fazer perguntas adicionais:
- Reserva para feriado ou véspera
- Reserva para hoje (nos horários aceitos)
- Evento fechado ou orçamento personalizado
- Insatisfação ou reclamação
- Cliente quer chegar após 19h em dia de semana (ter a qui)
- Pergunta fora do escopo

MÍDIA (áudio, foto, vídeo, sticker)
Se receber mídia sem texto: "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!"
Mensagens com números de telefone ou nomes são texto normal — nunca bloquear.

PERGUNTAS FREQUENTES
- Cardápio: nos destaques do @ocandiabar
- Programação: destaques do @ocandiabar, tópico "agenda"
- Samba: sexta, sábado e domingo. Terça a quinta varia — ver agenda
- Espaço kids: não temos
- Bolo: pode trazer! Não garantimos espaço na geladeira — como geralmente temos várias reservas, guardamos por ordem de chegada conforme o espaço disponível. Se não houver espaço, o bolo fica na mesa. Não oferecemos pratos e talheres, só guardanapos.
- Palco no sábado: salão interno. Aos sábados não há mesas no salão.
- Local do palco/mesa: definido no dia conforme movimento e reservas
- Nomes na reserva: não precisa, comanda individual
- Esgotado: ordem de chegada na área descoberta. Sábados: sugerir @angubardeestufa
- Movimento aos domingos: varia bastante
- Transmissão de jogo: sim, sem som
- Cerveja 600ml: não temos. Só chope e long neck.
- Copo: pode trazer, sem restrições
- Paga entrada: não. Tem couvert artístico (só mencionar valor se perguntarem)

EXEMPLOS DE TOM
"Temos sim! O samba começa às 18h30 e vai até às 21h30 😊"
"R$10 por pessoa"
"Varia bastante!"
"Pode trazer bolo à vontade! Não garantimos espaço na geladeira — guardamos por ordem de chegada. Se não couber, fica na mesa mesmo. Só não temos pratos e talheres, só guardanapos 😉"
"Aos sábados conseguimos reservar apenas uma mesa de apoio com até 8 lugares sentados. A gente segura a reserva até as 15h, com tolerância de 15 minutinhos. Podemos seguir com a reserva nesse formato?"
"Confirmamos a reserva e te aguardamos aqui 🎉 Se tiver algum imprevisto e não puder comparecer, nos avisa por favor?"
"A banda e as mesas nem sempre ficam nos mesmos lugares — montamos no dia conforme a capacidade, número de reservas e antecedência dos pedidos. Mas vamos registrar sua preferência e tentamos colocar onde você sugeriu!"
"Pode vir à vontade! A casa sempre comporta todo mundo 😊"
"Será um prazer receber vocês! Pode chegar e perguntar pelo João, nosso gerente 😊"

Seja sempre acolhedor. Nunca deixe o cliente sem resposta.`;
}

app.use(express.json());

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isOnlyPhoneNumber(text) {
  if (!text) return false;

  const lower = text.toLowerCase();

  if (
    lower.includes("telefone") ||
    lower.includes("contato") ||
    lower.includes("whatsapp") ||
    lower.includes("celular") ||
    lower.includes("meu numero")
  ) {
    return true;
  }

  const cleaned = text.replace(/\D/g, "");
  return cleaned.length >= 10 && cleaned.length <= 14;
}
function isMensagemNova(text) {
  if (!text) return false;

  const t = text.toLowerCase().trim();

  if (/\d{1,2}\/\d{1,2}/.test(t)) return true;

  if (t.includes("reserva") || t.includes("mesa")) return true;
  if (t.includes("cancelar") || t.includes("alterar")) return true;

  if (
    t.includes("horario") ||
    t.includes("horário") ||
    t.includes("funciona") ||
    t.includes("abre") ||
    t.includes("tem")
  ) return true;
  return false;
}
function classificarIntervencaoHumana(text) {
  if (!text) return "informou";

  const t = text.toLowerCase().trim();

  const sinaisEncerramento = [
    "confirmamos a reserva",
    "confirmamos sua reserva",
    "reserva confirmada",
    "te aguardamos aqui",
    "te aguardamos",
    "fechado",
    "combinado",
    "nos vemos",
    "até lá",
    "qualquer imprevisto nos avisa",
    "qualquer imprevisto nos avise"
  ];

  for (const s of sinaisEncerramento) {
    if (t.includes(s)) return "encerrou";
  }

  return "informou";
}

async function marcarIntervencaoHumana(userId, text) {
  const tipo = classificarIntervencaoHumana(text);

  if (tipo === "encerrou") {
    await redisSet(`humano_encerrou:${userId}`, "1", 86400 * 7);
    await redisDel(`humano_informou:${userId}`);
  } else {
    await redisSet(`humano_informou:${userId}`, "1", 86400 * 2);
    await redisDel(`humano_encerrou:${userId}`);
  }
}
async function wasMessageProcessed(messageId) {
  return !!(await redisGet(`msg_processed:${messageId}`));
}

async function markMessageProcessed(messageId) {
  await redisSet(`msg_processed:${messageId}`, "1", 86400);
}
async function redisGet(key) {
  try {
    const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });

    const data = await res.json();
    if (data.result == null) return null;

    return data.result;
  } catch {
    return null;
  }
}

async function redisSet(key, value, ex = 300) {
  try {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);

    const url = ex
      ? `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(serialized)}?EX=${ex}`
      : `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(serialized)}`;

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`
      }
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

async function isGloballyPaused() {
  const val = await redisGet("global:paused");
  return !!val;
}

async function pauseConversation(userId) {
  await redisSet(`paused:${userId}`, "1", PAUSA_INTERVENCAO_MS);
  // Flag encerrado: persiste além da pausa — bot só volta se cliente mandar nova mensagem após 5h
  await redisSet(`encerrado:${userId}`, "1", 86400 * 30); // 30 dias
  console.log(`Conversa com ${userId} pausada por 5 horas e marcada como encerrada`);
}

async function isEncerrado(userId) {
  const val = await redisGet(`encerrado:${userId}`);
  return !!val;
}

async function reabrirConversa(userId) {
  await redisDel(`encerrado:${userId}`);
  console.log(`Conversa com ${userId} reaberta pelo cliente`);
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
  await redisSet(`pending:${userId}`, JSON.stringify(messages), 86400);
}

async function clearPendingMessages(userId) {
  await redisDel(`pending:${userId}`);
}

async function getDebounceToken(userId) {
  return await redisGet(`debounce:${userId}`);
}

async function setDebounceToken(userId, token) {
  await redisSet(`debounce:${userId}`, token, 600);
}

// Follow-up 6h após última resposta do bot sem retorno do cliente
async function agendarFollowUp(userId) {
  await redisSet(`followup:${userId}`, Date.now().toString(), Math.ceil(FOLLOWUP_MS / 1000) + 600);

  setTimeout(async () => {
    try {
      const token = await redisGet(`followup:${userId}`);
      if (!token) return;

      const paused = await isPaused(userId);
      if (paused) return;
      if (await isGloballyPaused()) return;
      if (!isHorarioComercial()) return;

      // não manda follow-up se reserva já foi confirmada
      if (await redisGet(`reserva_confirmada:${userId}`)) return;

      // humano encerrou a conversa/reserva → não manda follow-up
      if (await redisGet(`humano_encerrou:${userId}`)) return;

      await redisDel(`followup:${userId}`);

      let mensagem = "Oi! Ficou alguma dúvida? Se quiser, a gente segue por aqui 😊";

      // se humano só informou condições, manda follow-up ainda mais leve
      if (await redisGet(`humano_informou:${userId}`)) {
        mensagem = "Oi! Só passando pra saber se ficou alguma dúvida 😊 Se quiser, a gente segue por aqui.";
      }

      await sendInstagramMessage(userId, mensagem);
      console.log(`Follow-up enviado para ${userId}`);
    } catch (err) {
      console.error("Erro no follow-up:", err);
    }
  }, FOLLOWUP_MS);
}

async function cancelarFollowUp(userId) {
  await redisDel(`followup:${userId}`);
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

function parseDateFromCommand(text) {
  // Extrai DD/MM ou DD/MM/AAAA do texto do comando
  const match = text.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?/);
  if (!match) return null;
  const now = new Date();
  const dia = match[1].padStart(2, "0");
  const mes = match[2].padStart(2, "0");
  const ano = match[3] || now.getFullYear().toString();
  return `${ano}-${mes}-${dia}`; // ISO para o Redis
}

function formatDateBR(isoDate) {
  const [ano, mes, dia] = isoDate.split("-");
  return `${dia}/${mes}/${ano}`;
}

async function handleTelegramCommand(text) {
  const raw = text.trim();
  const cmd = raw.toLowerCase();

 // /Ex DD/MM → força área externa
if (raw.toLowerCase().startsWith("/ex ")) {
  const dataISO = parseDateFromCommand(raw.slice(4).trim());
  if (!dataISO) {
    await notifyOwner("⚠️ Data inválida. Use: /Ex 11/04");
    return;
  }
  await setOverride(dataISO, "ext");
  await notifyOwner(`🟡 Override setado: ${formatDateBR(dataISO)} → apenas área EXTERNA`);
  return;
}

// /E DD/MM → força esgotado
if (raw.toLowerCase().startsWith("/e ")) {
  const dataISO = parseDateFromCommand(raw.slice(3).trim());
  if (!dataISO) {
    await notifyOwner("⚠️ Data inválida. Use: /E 11/04");
    return;
  }
  await setOverride(dataISO, "esg");
  await notifyOwner(`🔴 Override setado: ${formatDateBR(dataISO)} → ESGOTADO`);
  return;
}

  if (cmd === "/pausar") {
    await redisSet("global:paused", "1", 86400 * 7);
    await notifyOwner("⏸ Bot pausado globalmente. Nenhuma conversa será respondida até você enviar /reativar.");

  } else if (cmd === "/reativar") {
    await redisDel("global:paused");
    await notifyOwner("▶️ Bot reativado! Voltando a responder normalmente.");

  } else if (cmd === "/status") {
    const paused = await isGloballyPaused();
    const comercial = isHorarioComercial();
    await notifyOwner(paused
      ? "⏸ Bot está PAUSADO globalmente."
      : `▶️ Bot está ATIVO. Horário: ${BOT_HORA_INICIO}h às ${BOT_HORA_FIM}h. Agora: ${comercial ? "dentro do horário ✅" : "fora do horário 🌙"}`
    );

  } else if (cmd.startsWith("/limpar ")) {
    const dataISO = parseDateFromCommand(cmd.slice(8));
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /limpar 11/04"); return; }
    await clearOverride(dataISO);
    await notifyOwner(`✅ Override removido para ${formatDateBR(dataISO)} — bot voltará a consultar o Notion normalmente.`);

  } else if (cmd === "/limpar") {
    await notifyOwner("🗑 Iniciando limpeza manual de reservas antigas...");
    try {
      const n = await limparReservasAntigas();
      await notifyOwner(`✅ Limpeza concluída: ${n} reserva(s) antiga(s) removida(s).`);
    } catch (err) {
      await notifyOwner(`⚠️ Erro na limpeza: ${err.message}`);
    }

  } else if (cmd.startsWith("/status ")) {
    const dataISO = parseDateFromCommand(cmd.slice(8));
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /status 11/04"); return; }
    const override = await getOverride(dataISO);
    const disp = await verificarDisponibilidade(formatDateBR(dataISO).replace(/\/(\d{4})$/, "").split("/").map((v,i) => i===2?v:v).join("/") + "/" + dataISO.split("-")[0]);
    let msg = `📅 Status ${formatDateBR(dataISO)}:\n`;
    if (override) msg += `Override manual: ${override === "esg" ? "🔴 ESGOTADO" : "🟡 APENAS EXTERNA"}\n`;
    msg += `Notion: ${disp.tipo} (${disp.count ?? "?"} reservas)`;
    await notifyOwner(msg);

  } else if (cmd === "/help") {
    await notifyOwner(
`📋 Comandos disponíveis:

/Ex DD/MM — Força área EXTERNA para uma data
Ex: /Ex 11/04

/E DD/MM — Força ESGOTADO para uma data
Ex: /E 11/04

/limpar DD/MM — Remove override de uma data
Ex: /limpar 11/04

/limpar — Apaga reservas antigas do Notion

/status DD/MM — Mostra disponibilidade de uma data
Ex: /status 11/04

/status — Mostra se o bot está ativo ou pausado

/pausar — Pausa o bot globalmente

/reativar — Reativa o bot

/help — Mostra esta lista`
    );
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

function extractExplicitDates(text) {
  const ddmm = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g) || [];
  const now = new Date();
  const year = now.getFullYear();
  const results = ddmm.map(d => {
    const parts = d.split("/");
    if (parts.length === 2) return `${parts[0].padStart(2,"0")}/${parts[1].padStart(2,"0")}/${year}`;
    return `${parts[0].padStart(2,"0")}/${parts[1].padStart(2,"0")}/${parts[2]}`;
  });

  const diaNumRegex = /\b(segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)\s+dia\s+(\d{1,2})\b/gi;
  let match;
  while ((match = diaNumRegex.exec(text)) !== null) {
    const diaNum = parseInt(match[2]);
    const mesAtual = now.getMonth() + 1;
    const anoAtual = now.getFullYear();
    results.push(`${String(diaNum).padStart(2,"0")}/${String(mesAtual).padStart(2,"0")}/${anoAtual}`);
  }

  return [...new Set(results)];
}

function extractDatesFromConversation(currentMessage, history) {
  const allText = [
    currentMessage,
    ...history.map(h => h.content || "")
  ].join("\n");
  return extractExplicitDates(allText);
}

// Detecta se a resposta do bot contém informações sobre reserva (para agendar follow-up)
function respostaContemInfoReserva(text) {
  const keywords = [
    "reserva", "mesa", "lugares", "segurar", "15h", "19h", "14h",
    "podemos seguir", "formato", "disponível", "disponibilidade"
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
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
    console.log(`Debounce: nova mensagem ou intervenção para ${userId}, cancelando execução antiga`);
    return;
  }

  if (!isHorarioComercial()) {
    console.log(`Fora do horário comercial — mensagens de ${userId} aguardarão até as ${BOT_HORA_INICIO}h`);
    return;
  }

  if (await isGloballyPaused()) {
    console.log(`Bot pausado globalmente — ignorando mensagem de ${userId}`);
    return;
  }

  let paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada — ignorando`);
    await clearPendingMessages(userId);
    return;
  }

  // Se ainda está marcada como encerrada (não foi reaberta pelo cliente), não responde
  if (await isEncerrado(userId)) {
    console.log(`Conversa com ${userId} encerrada por humano — aguardando nova mensagem do cliente`);
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

  // Cancela follow-up pendente pois o cliente respondeu
  await cancelarFollowUp(userId);

  const history = await getHistory(userId);
  const explicitDates = extractDatesFromConversation(combinedMessage, history);

  let disponibilidadeInfo = "";
  for (const data of explicitDates) {
    const disp = await verificarDisponibilidade(data);
    console.log(`Disponibilidade para ${data}:`, disp);
    if (disp.tipo === "esgotado") {
      disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): ESGOTADA — sem vagas disponíveis.\n`;
    } else if (disp.tipo === "descoberto") {
      disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): apenas área descoberta disponível (${disp.vagasDescoberto} vagas restantes).\n`;
    } else if (disp.tipo === "coberto") {
      disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): disponível na área coberta (${disp.vagasCoberto} vagas restantes).\n`;
    } else {
      disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): disponível, sem limite de reservas.\n`;
    }
  }

  history.push({ role: "user", content: combinedMessage });
  if (history.length > 20) history.splice(0, 2);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada antes do Claude — cancelando`);
    return;
  }

  let reply;
  try {
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system: getSystemPrompt(disponibilidadeInfo || null),
        messages: history
      })
    });

    const claudeData = await claudeRes.json();

    if (claudeData.error) {
      console.error("Erro da API Claude:", claudeData.error);
      await notifyOwner(
        `⚠️ Erro na API do Claude!\nCliente ID: ${userId}\nErro: ${claudeData.error.type} — ${claudeData.error.message}\nVerifique os créditos em console.anthropic.com`
      );
      return;
    }

    reply = claudeData.content?.[0]?.text;
  } catch (err) {
    console.error("Erro ao chamar Claude:", err);
    await notifyOwner(
      `⚠️ Erro ao chamar a API do Claude!\nCliente ID: ${userId}\nErro: ${err.message}\nVerifique os créditos em console.anthropic.com`
    );
    return;
  }

  if (!reply) {
    console.error("Resposta vazia do Claude");
    await notifyOwner(`⚠️ Resposta vazia do Claude para cliente ${userId}. Verifique os créditos.`);
    return;
  }

  console.log("Resposta Claude:", reply);

  // Verificação final: checar pausa E token antes de enviar
  // O echo da intervenção humana pode ter chegado durante a chamada ao Claude
  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada após Claude — cancelando envio`);
    return;
  }

  const finalToken = await getDebounceToken(userId);
  if (finalToken !== myToken) {
    console.log(`Token cancelado para ${userId} durante chamada ao Claude — intervenção humana detectada, cancelando envio`);
    return;
  }

  history.push({ role: "assistant", content: reply });
  await saveHistory(userId, history);

  const reservation = extractReservation(reply);
if (reservation) {
  await salvarReservaNaNotion(reservation, userId);
  await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 2);
  await clearPendingMessages(userId);
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
  await sendInstagramMessage(userId, cleanReply);

  // Agenda follow-up se a resposta contiver informações sobre reserva e não for uma confirmação
  const isConfirmacao = !!reservation;
  const isEscalacao = !!escalation;
  if (!isConfirmacao && !isEscalacao && respostaContemInfoReserva(cleanReply)) {
    await agendarFollowUp(userId);
    console.log(`Follow-up agendado para ${userId} em 6h`);
  }
}

async function processarFilaAcumulada() {
  console.log("Verificando fila acumulada fora do horário...");
  try {
    const res = await fetch(`${UPSTASH_URL}/keys/pending:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    const keys = data.result || [];
    for (const key of keys) {
      const userId = key.replace("pending:", "");
      const paused = await isPaused(userId);
      if (!paused) {
        const newToken = `${userId}_${Date.now()}`;
        await setDebounceToken(userId, newToken);
        console.log(`Reprocessando fila de ${userId}`);
        processMessages(userId, newToken);
        await sleep(2000);
      }
    }
  } catch (err) {
    console.error("Erro ao processar fila acumulada:", err);
  }
}

function agendarVerificacaoHorario() {
  let eraFora = !isHorarioComercial();
  setInterval(() => {
    const estaFora = !isHorarioComercial();
    if (eraFora && !estaFora) {
      console.log("Horário comercial iniciado — processando fila acumulada");
      processarFilaAcumulada().catch(err => console.error("Erro na fila acumulada:", err));
    }
    eraFora = estaFora;
  }, 60000);
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

app.post("/telegram", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body?.message;
    if (!message) return;
    const chatId = message.chat?.id?.toString();
    const text = message.text || "";
    if (chatId === TELEGRAM_CHAT_ID && text.startsWith("/")) {
      await handleTelegramCommand(text);
    }
  } catch (err) {
    console.error("Erro no webhook Telegram:", err);
  }
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
  const echoText = messaging?.message?.text || "";

  if (echoRecipient && echoSender === IG_ACCOUNT_ID) {
    const echoDoBot = await redisGet(`echo_bot:${echoRecipient}`);

    if (echoDoBot) {
      await redisDel(`echo_bot:${echoRecipient}`);
      console.log(`Echo do bot ignorado para ${echoRecipient}`);
      return;
    }

    await pauseConversation(echoRecipient);
    await clearPendingMessages(echoRecipient);
    await redisDel(`reserva_confirmada:${echoRecipient}`);
    await marcarIntervencaoHumana(echoRecipient, echoText);
    await setDebounceToken(echoRecipient, `cancelled_${Date.now()}`);
    await cancelarFollowUp(echoRecipient);

    console.log(`Intervenção humana detectada — conversa com ${echoRecipient} pausada, classificada e debounce cancelado`);
  }

  return;
}

    const senderId = messaging?.sender?.id;
    if (!senderId) return;

    if (await isGloballyPaused()) {
      console.log(`Bot pausado globalmente — ignorando mensagem de ${senderId}`);
      return;
    }

    const paused = await isPaused(senderId);
    if (paused) {
      console.log(`Conversa com ${senderId} pausada — ignorando`);
      return;
    }
const messageId = messaging?.message?.mid;

if (messageId) {
  if (await wasMessageProcessed(messageId)) {
    console.log(`Mensagem duplicada ignorada: ${messageId}`);
    return;
  }
  await markMessageProcessed(messageId);
}
    const message = messaging?.message?.text;
    if (await redisGet(`reserva_confirmada:${senderId}`)) {
  if (!isMensagemNova(message)) {
    console.log(`Mensagem ignorada (pós-reserva) de ${senderId}: ${message}`);
    return;
  }
}
    const hasMedia = !message && (
      messaging?.message?.sticker_id ||
      (messaging?.message?.attachments?.some(a => a.type !== "fallback"))
    );

    if (hasMedia) {
      if (isHorarioComercial()) {
        await sendInstagramMessage(senderId, "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!");
      }
      return;
    }

    if (!message) return;

    // Ignora mensagens que são apenas números de telefone (detectados pelo Instagram)
    if (isOnlyPhoneNumber(message)) {
      console.log(`Mensagem de ${senderId} ignorada — apenas número de telefone: ${message}`);
      return;
    }

    await addPendingMessage(senderId, message);
    console.log(`Mensagem de ${senderId} adicionada à fila: ${message}`);

    // Se conversa foi encerrada por humano e pausa ainda ativa: só enfileira, não processa
    if (await isPaused(senderId)) {
      console.log(`Conversa com ${senderId} pausada — mensagem enfileirada, aguardando expiração`);
      return;
    }

    // Se conversa foi encerrada por humano e pausa expirou: cliente reabre com nova mensagem
    if (await isEncerrado(senderId)) {
  if (!isMensagemNova(message)) {
    console.log(`Mensagem ignorada (conversa encerrada) de ${senderId}: ${message}`);
    return;
  }

  await reabrirConversa(senderId);
  await redisDel(`humano_encerrou:${senderId}`);
  await redisDel(`humano_informou:${senderId}`);
  console.log(`Conversa com ${senderId} reaberta — mensagem nova`);
}

    if (!isHorarioComercial()) {
      console.log(`Fora do horário comercial — mensagem de ${senderId} aguardará até as ${BOT_HORA_INICIO}h`);
      return;
    }

    const newToken = `${senderId}_${Date.now()}`;
    await setDebounceToken(senderId, newToken);
    processMessages(senderId, newToken);

  } catch (err) {
    console.error("Erro:", err);
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarLimpezaSemanal();
  agendarRotinasDiarias();
  agendarVerificacaoHorario();
  notifyOwner("🟢 Bot Candiá iniciado e online!").catch(() => {});
});
