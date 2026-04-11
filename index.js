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
const DEBOUNCE_MS = 90000; // 1.5 min
const FOLLOWUP_MS = 6 * 60 * 60 * 1000; // 6 horas

// Horário de funcionamento do bot (Brasília)
const BOT_HORA_INICIO = 9;
const BOT_HORA_FIM = 22;

const LIMITES = {
  "sexta":   { coberto: 10, descoberto: 0,  total: 10 },
  "sábado":  { coberto: 10, descoberto: 4,  total: 14 },
  "domingo": { coberto: 10, descoberto: 0,  total: 10 }
};

// ─── Helpers de data/hora ─────────────────────────────────────────────────────

function getHoraBrasilia() {
  const now = new Date();
  return parseInt(now.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false
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

function parseDateFromCommand(text) {
  const match = text.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{4}))?/);
  if (!match) return null;
  const now = new Date();
  const dia = match[1].padStart(2, "0");
  const mes = match[2].padStart(2, "0");
  const ano = match[3] || now.getFullYear().toString();
  return `${ano}-${mes}-${dia}`;
}

function formatDateBR(isoDate) {
  const [ano, mes, dia] = isoDate.split("-");
  return `${dia}/${mes}/${ano}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Redis ────────────────────────────────────────────────────────────────────

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
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
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

// ─── Horário comercial ────────────────────────────────────────────────────────

async function isForceOutsideHoursEnabled() {
  return !!(await redisGet("force_outside_hours"));
}

async function enableForceOutsideHours(seconds = 3600) {
  await redisSet("force_outside_hours", "1", seconds);
}

async function isHorarioComercial() {
  if (await isForceOutsideHoursEnabled()) return true;
  const hora = getHoraBrasilia();
  return hora >= BOT_HORA_INICIO && hora < BOT_HORA_FIM;
}

// ─── Overrides manuais ────────────────────────────────────────────────────────

async function setOverride(dataISO, tipo) {
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

// ─── Disponibilidade ──────────────────────────────────────────────────────────

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

  const limites = LIMITES[diaSemana];
  if (!limites) return { disponivel: true, tipo: "sem_limite", diaSemana };

  const count = await contarReservasNotion(dataStr);

  if (count >= limites.coberto + limites.descoberto) {
    return { disponivel: false, tipo: "esgotado", count, diaSemana };
  }

  if (count >= limites.coberto) {
    const vagasDescoberto = limites.coberto + limites.descoberto - count;
    return { disponivel: true, tipo: "descoberto", vagasDescoberto, count, diaSemana };
  }

  const vagasCoberto = limites.coberto - count;
  return { disponivel: true, tipo: "coberto", vagasCoberto, count, diaSemana };
}

// ─── Notion ───────────────────────────────────────────────────────────────────

// PONTO 9: retry automático + notificação com dados completos em caso de falha
async function salvarReservaNaNotion(data, instagramId) {
  const properties = {
    "Nome": { title: [{ text: { content: data.aniversariante || "" } }] },
    "Data": { rich_text: [{ text: { content: convertDateToISO(data.data) } }] },
    "Dia": { rich_text: [{ text: { content: formatDiaNotion(data.dia, data.data) } }] },
    "Contato": { rich_text: [{ text: { content: data.contato || "" } }] },
    "Lugares": { number: parseInt(data.lugares) || 0 },
    "Total esperado": { number: parseInt(data.total_esperado) || 0 },
    "Instagram ID": { rich_text: [{ text: { content: instagramId || "" } }] }
  };

  if (data.observacao && data.observacao.trim()) {
    properties["Observações"] = {
      rich_text: [{ text: { content: data.observacao.trim() } }]
    };
  }

  const body = JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties });
  const headers = {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };

  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    try {
      const res = await fetch("https://api.notion.com/v1/pages", { method: "POST", headers, body });
      const result = await res.json();

      if (result.id) {
        console.log(`Reserva gravada no Notion (tentativa ${tentativa}):`, result.id);
        return true;
      }

      console.error(`Erro ao gravar no Notion (tentativa ${tentativa}):`, JSON.stringify(result));
    } catch (err) {
      console.error(`Exceção ao gravar no Notion (tentativa ${tentativa}):`, err);
    }

    if (tentativa < 2) await sleep(3000);
  }

  // Ambas as tentativas falharam — notifica com dados completos para salvar manualmente
  await notifyOwner(
    `🚨 FALHA ao salvar reserva no Notion após 2 tentativas!\n` +
    `Instagram ID: ${instagramId}\n` +
    `Nome: ${data.aniversariante}\n` +
    `Data: ${data.data} (${data.dia})\n` +
    `Contato: ${data.contato}\n` +
    `Lugares: ${data.lugares} | Total esperado: ${data.total_esperado}\n` +
    `Obs: ${data.observacao || "—"}\n` +
    `⚠️ Salve manualmente no Notion!`
  );
  return false;
}

async function buscarPageIdPorInstagram(userId) {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: { property: "Instagram ID", rich_text: { equals: userId } },
        sorts: [{ property: "Data", direction: "descending" }],
        page_size: 1
      })
    });
    const data = await res.json();
    if (!data.results || data.results.length === 0) return null;
    return data.results[0].id;
  } catch (err) {
    console.error("Erro ao buscar reserva no Notion:", err);
    return null;
  }
}

async function cancelarReservaNoNotion(userId) {
  try {
    const pageId = await buscarPageIdPorInstagram(userId);
    if (!pageId) {
      console.log(`Nenhuma reserva encontrada para ${userId}`);
      return;
    }
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        properties: { "Confirmado": { multi_select: [{ name: "Cancelado" }] } }
      })
    });
    console.log(`Reserva cancelada no Notion para ${userId}`);
  } catch (err) {
    console.error("Erro ao cancelar reserva no Notion:", err);
  }
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
        filter: { property: "Data", rich_text: { equals: dataISO } }
      })
    });
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error("Erro ao buscar reservas:", err);
    return [];
  }
}

// PONTO 10: typo corrigido (buscarReservasGravatasHoje → buscarReservasGravadasHoje)
async function buscarReservasGravadasHoje() {
  return await buscarReservasPorData(getTodayISO());
}

// PONTO 12: paginação completa — não limita a 100 registros
async function limparReservasAntigas() {
  try {
    const hoje = getTodayISO();
    let deletadas = 0;
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const bodyObj = { page_size: 100 };
      if (startCursor) bodyObj.start_cursor = startCursor;

      const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body: JSON.stringify(bodyObj)
      });
      const data = await res.json();
      const pages = data.results || [];

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

      hasMore = data.has_more || false;
      startCursor = data.next_cursor || undefined;
    }

    return deletadas;
  } catch (err) {
    console.error("Erro ao limpar reservas:", err);
    throw err;
  }
}

// ─── Lembretes e resumo diário ────────────────────────────────────────────────

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
          message: {
            text: `Oi, ${nome.split(" ")[0]}! 😊 Passando pra confirmar sua reserva no Candiá no dia ${dia}. Tudo certo pra comemorar com a gente? 🎉`
          }
        })
      });

      const igData = await igRes.json();

      if (igData.error) {
        falhas.push(`${nome} (erro: ${igData.error.message} — contato: ${contato})`);
      } else {
        console.log(`Lembrete enviado para ${nome} (${igId})`);
        await fetch(`https://api.notion.com/v1/pages/${reserva.id}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${NOTION_TOKEN}`,
            "Content-Type": "application/json",
            "Notion-Version": "2022-06-28"
          },
          body: JSON.stringify({
            properties: { "Confirmado": { multi_select: [{ name: "Pendente" }] } }
          })
        });
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

async function enviarResumoDiario() {
  console.log("Enviando resumo diário...");
  const reservas = await buscarReservasGravadasHoje(); // PONTO 10

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

// ─── Agendamentos ─────────────────────────────────────────────────────────────

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

// PONTO 11: worker periódico para follow-ups perdidos após restart do servidor
async function verificarFollowUpsPendentes() {
  try {
    const res = await fetch(`${UPSTASH_URL}/keys/followup:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    const keys = data.result || [];

    for (const key of keys) {
      const userId = key.replace("followup:", "");
      const timestamp = await redisGet(`followup:${userId}`);
      if (!timestamp) continue;

      const agendadoEm = parseInt(timestamp);
      if (Date.now() - agendadoEm < FOLLOWUP_MS) continue;

      if (await isPaused(userId)) continue;
      if (await isGloballyPaused()) continue;
      if (!(await isHorarioComercial())) continue;
      if (await redisGet(`reserva_confirmada:${userId}`)) continue;
      if (await redisGet(`humano_encerrou:${userId}`)) continue;

      await redisDel(`followup:${userId}`);

      let mensagem = "Oi! Ficou alguma dúvida? Se quiser, a gente segue por aqui 😊";
      if (await redisGet(`humano_informou:${userId}`)) {
        mensagem = "Oi! Só passando pra saber se ficou alguma dúvida 😊 Se quiser, a gente segue por aqui.";
      }

      await sendInstagramMessage(userId, mensagem);
      await salvarUltimaRespostaBot(userId, mensagem);
      console.log(`Follow-up (worker) enviado para ${userId}`);
    }
  } catch (err) {
    console.error("Erro no worker de follow-ups:", err);
  }
}

async function agendarVerificacaoHorario() {
  let eraFora = !(await isHorarioComercial());

  setInterval(async () => {
    const estaFora = !(await isHorarioComercial());
    if (eraFora && !estaFora) {
      console.log("Horário comercial iniciado — processando fila acumulada");
      processarFilaAcumulada().catch(err => console.error("Erro na fila acumulada:", err));
    }
    eraFora = estaFora;
  }, 60000);

  // PONTO 11: verifica follow-ups perdidos a cada 10 minutos
  setInterval(() => {
    verificarFollowUpsPendentes().catch(err => console.error("Erro no worker follow-up:", err));
  }, 10 * 60 * 1000);
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

// ─── System prompt ────────────────────────────────────────────────────────────

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

INTERPRETAÇÃO DE RESPOSTAS CURTAS

- O cliente pode responder de forma curta como "ok", "pode ser", "sim", "por favor"
- Sempre interpretar essas respostas com base na última pergunta feita
- Se a última pergunta foi de confirmação, trate como confirmação positiva
- Nunca reiniciar o fluxo ou pedir informações já solicitadas novamente
- Geralmente respostas curtas indicam continuidade da conversa, não início de novo assunto
- Se o cliente fizer múltiplas perguntas, responda de forma direta e objetiva, sem demora excessiva.
- Evite respostas longas demais.
- Após confirmar a reserva, continue respondendo normalmente caso o cliente envie novas mensagens.

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

FEIJOADA
- Temos feijoada aos sábados e domingos
- Aos sábados, até as 14h, temos a promoção: feijoada + chope pilsen 300ml por R$20 - após este horário preço normal do cardápio
- Aos domingos tem feijoada normalmente, mas sem essa promoção do combo de sábado
- Só mencionar feijoada se o cliente perguntar
- Se perguntarem apenas "tem feijoada?", responder de forma direta informando os dias
- Se perguntarem sobre promoção, informar que o combo promocional é só no sábado até as 14h

PROMOÇÃO DO CHOPE PARA GRUPOS
- Grupos com mais de 10 pessoas ganham 2 litros de chope grátis
- Se o cliente perguntar sobre benefício para grupo, condição especial, vantagem para aniversário ou promoção para grupo grande, informar esse benefício diretamente
- Só mencionar esse benefício quando a pergunta tiver relação com vantagens, promoções, condições especiais ou aniversariante
- Nunca inventar outros benefícios além dos 2 litros de chope
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

PAGAMENTO:
- Sexta a domingo: pagamento antecipado via fichas. Cada um paga o seu.
- Terça a quinta: comanda individual.

ALMOÇO:
- Servido normalmente até as 15hs, de sexta a domingo.

ACESSIBILIDADE:
- Temos rampa na entrada, mas infelizmente nossos banheiros ainda não são acessíveis.

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
7. Se sim: pedir nome do aniversariante, telefone de contato e previsão total de pessoas
8. Se mencionar preferência de local: registrar na observação
9. Confirmar a reserva. Não mencionar chope nem couvert na confirmação.
- Para confirmar a reserva, garantir sempre que tem o nome do aniversariante, telefone de contato e previsão total de pessoas
- Nunca pedir Instagram para confirmar reserva, porque esse dado já está disponível no sistema
- Se o cliente já tiver informado um desses dados, pedir apenas o que estiver faltando
10. Pedir aviso em caso de imprevisto
11. Quando nome, telefone e previsão total de pessoas estiverem definidos, confirmar a reserva e incluir no final da mensagem(invisível para o cliente):
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME, contato=TELEFONE, lugares=N, total_esperado=N, observacao=TEXTO_OU_VAZIO]
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
- Benefício para grupos grandes: grupos com mais de 10 pessoas ganham 2 litros de chope grátis
- Feijoada: temos aos sábados e domingos
- Promoção da feijoada: somente sábado até as 14h, com feijoada + chope pilsen 300ml por R$20

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

// ─── Helpers de mensagem ──────────────────────────────────────────────────────

app.use(express.json());

function isOnlyPhoneNumber(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (
    lower.includes("telefone") || lower.includes("contato") ||
    lower.includes("whatsapp") || lower.includes("celular") ||
    lower.includes("meu numero")
  ) return true;
  const digits = text.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 14;
}

function detectCancelamento(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("cancelar") || t.includes("cancelamento") ||
    t.includes("não vou mais") || t.includes("nao vou mais") ||
    t.includes("não vou conseguir") || t.includes("desmarcar")
  );
}

function classificarIntervencaoHumana(text) {
  if (!text) return "informou";
  const t = text.toLowerCase().trim();
  const sinaisEncerramento = ["ok obrigado", "ok obrigada", "valeu", "beleza", "blz"];
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

function respostaContemInfoReserva(text) {
  const keywords = [
    "reserva", "mesa", "lugares", "segurar", "15h", "19h", "14h",
    "podemos seguir", "formato", "disponível", "disponibilidade"
  ];
  const lower = text.toLowerCase();
  return keywords.some(k => lower.includes(k));
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
  const allText = [currentMessage, ...history.map(h => h.content || "")].join("\n");
  return extractExplicitDates(allText);
}

// ─── Estado da conversa ───────────────────────────────────────────────────────

async function wasMessageProcessed(messageId) {
  return !!(await redisGet(`msg_processed:${messageId}`));
}

async function markMessageProcessed(messageId) {
  await redisSet(`msg_processed:${messageId}`, "1", 86400);
}

async function shouldSkipDuplicateReply(userId, replyText) {
  const lastReply = await redisGet(`last_reply:${userId}`);
  return lastReply === replyText;
}

async function markLastReply(userId, replyText) {
  await redisSet(`last_reply:${userId}`, replyText, 15);
}

async function salvarUltimaRespostaBot(userId, text) {
  await redisSet(`ultima_resposta_bot:${userId}`, text, 86400 * 7);
}

async function getUltimaRespostaBot(userId) {
  return await redisGet(`ultima_resposta_bot:${userId}`);
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
  await redisSet(`hist:${userId}`, JSON.stringify(history), 86400 * 7);
}

async function isPaused(userId) {
  return !!(await redisGet(`paused:${userId}`));
}

async function isGloballyPaused() {
  return !!(await redisGet("global:paused"));
}

async function pauseConversation(userId) {
  await redisSet(`paused:${userId}`, "1", 60 * 30); // 30 min
  console.log(`Conversa com ${userId} pausada por 30 minutos`);
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
  // renova TTL do histórico para que conversas que voltam no dia seguinte não percam contexto
  const hist = await redisGet(`hist:${userId}`);
  if (hist) await redisSet(`hist:${userId}`, hist, 86400 * 7);
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

async function marcarConversaEscalada(userId, motivo = "") {
  await redisSet(`conversa_escalada:${userId}`, motivo || "1", 86400 * 2);
}

async function isConversaEscalada(userId) {
  return !!(await redisGet(`conversa_escalada:${userId}`));
}

async function limparConversaEscalada(userId) {
  await redisDel(`conversa_escalada:${userId}`);
}

// PONTO 11: follow-up salvo no Redis como fonte de verdade; setTimeout é fallback
async function agendarFollowUp(userId) {
  await redisSet(`followup:${userId}`, Date.now().toString(), Math.ceil(FOLLOWUP_MS / 1000) + 600);

  setTimeout(async () => {
    try {
      const token = await redisGet(`followup:${userId}`);
      if (!token) return;

      if (await isPaused(userId)) return;
      if (await isGloballyPaused()) return;
      if (!(await isHorarioComercial())) return;
      if (await redisGet(`reserva_confirmada:${userId}`)) return;
      if (await redisGet(`humano_encerrou:${userId}`)) return;

      await redisDel(`followup:${userId}`);

      let mensagem = "Oi! Ficou alguma dúvida? Se quiser, a gente segue por aqui 😊";
      if (await redisGet(`humano_informou:${userId}`)) {
        mensagem = "Oi! Só passando pra saber se ficou alguma dúvida 😊 Se quiser, a gente segue por aqui.";
      }

      await sendInstagramMessage(userId, mensagem);
      await salvarUltimaRespostaBot(userId, mensagem);
      console.log(`Follow-up (setTimeout) enviado para ${userId}`);
    } catch (err) {
      console.error(`Erro no follow-up de ${userId}:`, err);
    }
  }, FOLLOWUP_MS);
}

async function cancelarFollowUp(userId) {
  await redisDel(`followup:${userId}`);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function notifyOwner(message) {
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
    });
    console.log("Notificado no Telegram!");
  } catch (err) {
    console.error("Erro ao notificar no Telegram:", err);
  }
}

async function handleTelegramCommand(text) {
  const raw = text.trim();
  const cmd = raw.toLowerCase();

  // /Ex DD/MM → força área externa
  if (raw.toLowerCase().startsWith("/ex ")) {
    const dataISO = parseDateFromCommand(raw.slice(4).trim());
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /Ex 11/04"); return; }
    await setOverride(dataISO, "ext");
    await notifyOwner(`🟡 Override setado: ${formatDateBR(dataISO)} → apenas área EXTERNA`);
    return;
  }

  // /E DD/MM → força esgotado
  if (raw.toLowerCase().startsWith("/e ")) {
    const dataISO = parseDateFromCommand(raw.slice(3).trim());
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /E 11/04"); return; }
    await setOverride(dataISO, "esg");
    await notifyOwner(`🔴 Override setado: ${formatDateBR(dataISO)} → ESGOTADO`);
    return;
  }

  if (cmd.startsWith("/liberar ")) {
    const userId = raw.split(" ")[1]?.trim();
    if (!userId) { await notifyOwner("⚠️ Use: /liberar USER_ID"); return; }
    await redisDel(`paused:${userId}`);
    await redisDel(`humano_encerrou:${userId}`);
    await redisDel(`humano_informou:${userId}`);
    await redisDel(`followup:${userId}`);
    await redisDel(`debounce:${userId}`);
    await redisDel(`pending:${userId}`);
    await notifyOwner(`✅ Usuário liberado: ${userId}`);
    return;
  }

  if (cmd === "/pausar") {
    await redisSet("global:paused", "1", 86400 * 7);
    await notifyOwner("⏸️ Bot pausado globalmente. Nenhuma conversa será respondida até você enviar /reativar.");
    return;
  }

  if (cmd.startsWith("/reativar")) {
    const parts = raw.split(" ");
    if (parts.length > 1) {
      const userId = parts[1].trim();
      await limparConversaEscalada(userId);
      await redisDel(`paused:${userId}`);
      await notifyOwner(`▶️ Conversa ${userId} reativada!`);
      return;
    }
    await redisDel("global:paused");
    await notifyOwner("▶️ Bot reativado globalmente!");
    return;
  }

  if (cmd.startsWith("/start")) {
    const parts = raw.split(" ");
    if (parts.length > 1) {
      const userId = parts[1].trim();
      await limparConversaEscalada(userId);
      await redisDel(`paused:${userId}`);
      await redisDel(`humano_encerrou:${userId}`);
      await redisDel(`humano_informou:${userId}`);
      await redisDel(`followup:${userId}`);
      await redisDel(`debounce:${userId}`);
      await enableForceOutsideHours(3600);
      const newToken = `${userId}_${Date.now()}`;
      await setDebounceToken(userId, newToken);
      processMessages(userId, newToken);
      await notifyOwner(`▶️ Conversa ${userId} reativada e bot liberado fora do horário por 1h.`);
      return;
    }
    await redisDel("global:paused");
    await enableForceOutsideHours(3600);
    await notifyOwner("▶️ Bot reativado globalmente e liberado fora do horário por 1h.");
    return;
  }

  if (cmd === "/status") {
    const paused = await isGloballyPaused();
    const comercial = await isHorarioComercial();
    const forceOutside = await isForceOutsideHoursEnabled();
    await notifyOwner(
      paused
        ? "⏸ Bot está PAUSADO globalmente."
        : `▶️ Bot está ATIVO. Horário: ${BOT_HORA_INICIO}h às ${BOT_HORA_FIM}h. Agora: ${comercial ? "dentro do horário ✅" : "fora do horário 🌙"}${forceOutside ? " | modo forçado fora do horário ligado 🔓" : ""}`
    );
    return;
  }

  if (cmd.startsWith("/limpar ")) {
    const dataISO = parseDateFromCommand(cmd.slice(8));
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /limpar 11/04"); return; }
    await clearOverride(dataISO);
    await notifyOwner(`✅ Override removido para ${formatDateBR(dataISO)} — bot voltará a consultar o Notion normalmente.`);
    return;
  }

  if (cmd === "/limpar") {
    await notifyOwner("🗑 Iniciando limpeza manual de reservas antigas...");
    try {
      const n = await limparReservasAntigas();
      await notifyOwner(`✅ Limpeza concluída: ${n} reserva(s) antiga(s) removida(s).`);
    } catch (err) {
      await notifyOwner(`⚠️ Erro na limpeza: ${err.message}`);
    }
    return;
  }

  if (cmd.startsWith("/status ")) {
    const dataISO = parseDateFromCommand(cmd.slice(8));
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /status 11/04"); return; }
    const override = await getOverride(dataISO);
    const disp = await verificarDisponibilidade(
      formatDateBR(dataISO).replace(/\/(\d{4})$/, "").split("/").map((v, i) => i === 2 ? v : v).join("/") + "/" + dataISO.split("-")[0]
    );
    let msg = `📅 Status ${formatDateBR(dataISO)}:\n`;
    if (override) msg += `Override manual: ${override === "esg" ? "🔴 ESGOTADO" : "🟡 APENAS EXTERNA"}\n`;
    msg += `Notion: ${disp.tipo} (${disp.count ?? "?"} reservas)`;
    await notifyOwner(msg);
    return;
  }

  if (cmd === "/help") {
    await notifyOwner(
`📋 Comandos disponíveis:

/Ex DD/MM — Força área EXTERNA para uma data
Ex: /Ex 11/04

/E DD/MM — Força ESGOTADO para uma data
Ex: /E 11/04

/liberar USER_ID — destrava manualmente um cliente
Ex: /liberar 1604246050664169

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
    return;
  }
}

// ─── Instagram ────────────────────────────────────────────────────────────────

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

// ─── Processamento de mensagens ───────────────────────────────────────────────

async function processMessages(userId, myToken) {
  // PONTO 5: verifica token ANTES do sleep para evitar trabalho desnecessário
  const tokenAntes = await getDebounceToken(userId);
  if (tokenAntes !== myToken) {
    console.log(`Token cancelado para ${userId} antes do debounce — abortando`);
    return;
  }

  await sleep(DEBOUNCE_MS);

  const currentToken = await getDebounceToken(userId);
  if (currentToken !== myToken) {
    console.log(`Token cancelado para ${userId} — outra mensagem chegou`);
    return;
  }

  let paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada — cancelando processamento`);
    return;
  }

  if (await isGloballyPaused()) {
    console.log(`Bot pausado globalmente — cancelando processamento para ${userId}`);
    return;
  }

  const pendingMessages = await getPendingMessages(userId);
  if (pendingMessages.length === 0) {
    console.log(`Nenhuma mensagem pendente para ${userId}`);
    return;
  }

  await clearPendingMessages(userId);

  // PONTO 6: separador explícito entre mensagens acumuladas
  const combinedMessage = pendingMessages.join(" | ");
  const mensagemEhSoContato = isOnlyPhoneNumber(combinedMessage);

  console.log(`Processando ${pendingMessages.length} mensagem(ns) de ${userId}: ${combinedMessage}`);

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

  let systemPrompt = getSystemPrompt(disponibilidadeInfo || null);

  const contatoDetectado = await redisGet(`contato_detectado:${userId}`);
  if (contatoDetectado) {
    systemPrompt += `\nCONTATO JÁ INFORMADO PELO CLIENTE: ${contatoDetectado}\n`;
    systemPrompt += `\nIMPORTANTE: se o único dado que faltava para concluir a reserva era o contato, considere este contato como válido e prossiga para a confirmação final da reserva. Nesse caso, NÃO peça o contato novamente. Gere a resposta final de confirmação e inclua o bloco [RESERVA: ...] completo com esse contato.\n`;
  }

  if (mensagemEhSoContato) {
    systemPrompt += `\nA MENSAGEM ATUAL DO CLIENTE É APENAS O CONTATO. Se já houver contexto suficiente da reserva nas mensagens anteriores, conclua a reserva agora. NÃO trate esta mensagem como novo assunto. NÃO peça o contato novamente.\n`;
  }

  const ultimaRespostaBot = await getUltimaRespostaBot(userId);
  if (ultimaRespostaBot) {
    systemPrompt += `\nÚLTIMA MENSAGEM ENVIADA PELO BOT: ${ultimaRespostaBot}\n`;
  }

  // se histórico vazio mas cliente já tem reserva, evita tratar como novo atendimento
  if (history.length <= 1 && await redisGet(`reserva_confirmada:${userId}`)) {
    systemPrompt += `\nEste cliente já possui uma reserva confirmada anteriormente. Atenda normalmente — não inicie novo fluxo de reserva nem trate como primeiro contato.\n`;
  }

  // se histórico vazio e existe última resposta do bot, injeta como contexto mínimo
  if (history.length <= 1 && ultimaRespostaBot) {
    systemPrompt += `\nCONTEXTO DA ÚLTIMA INTERAÇÃO COM ESTE CLIENTE: a última mensagem enviada pelo bot foi: "${ultimaRespostaBot}". Use isso para dar continuidade natural à conversa, sem tratar como primeiro contato.\n`;
  }

  // PONTO 8: retry na chamada ao Claude (2 tentativas com 3s de intervalo)
  let claudeData;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
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
          system: systemPrompt,
          messages: history
        })
      });

      claudeData = await claudeRes.json();

      if (claudeData.error) {
        console.error(`Erro da API Claude (tentativa ${tentativa}):`, claudeData.error);
        if (tentativa === 2) {
          await notifyOwner(
            `⚠️ Erro na API do Claude!\nCliente ID: ${userId}\nErro: ${claudeData.error.type} — ${claudeData.error.message}\nVerifique os créditos em console.anthropic.com`
          );
          return;
        }
        await sleep(3000);
        continue;
      }

      break; // sucesso
    } catch (err) {
      console.error(`Exceção ao chamar a API Claude (tentativa ${tentativa}):`, err);
      if (tentativa === 2) {
        await notifyOwner(`⚠️ Erro ao chamar a API Claude.\nCliente ID: ${userId}\nErro: ${err.message || err}`);
        return;
      }
      await sleep(3000);
    }
  }

  let reply = claudeData.content?.[0]?.text;

  if (!reply) {
    console.error("Resposta vazia do Claude");
    await notifyOwner(`⚠️ Resposta vazia do Claude para cliente ${userId}. Verifique os créditos.`);
    return;
  }

  // Escalação embutida na resposta
  const escalarMatch = reply.match(/\[ESCALAR:\s*motivo=(.*?)\]/i);
  if (escalarMatch) {
    const motivoEscalada = escalarMatch[1]?.trim() || "Sem motivo informado";
    await notifyOwner(`⚠️ Escalonar conversa com ${userId}\nMotivo: ${motivoEscalada}`);
    await marcarConversaEscalada(userId, motivoEscalada);
    await clearPendingMessages(userId);
    await setDebounceToken(userId, `cancelled_${Date.now()}`);
    await cancelarFollowUp(userId);
    console.log(`Conversa ${userId} marcada como escalada.`);
    reply = reply.replace(/\[ESCALAR:\s*motivo=.*?\]/i, "").trim();
  }

  console.log("Resposta Claude:", reply);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada após Claude — cancelando envio`);
    return;
  }

  const finalToken = await getDebounceToken(userId);
  if (finalToken !== myToken) {
    console.log(`Token cancelado para ${userId} durante chamada ao Claude — cancelando envio`);
    return;
  }

  history.push({ role: "assistant", content: reply });
  await saveHistory(userId, history);

  const reservation = extractReservation(reply);
  if (reservation) {
    const salvou = await salvarReservaNaNotion(reservation, userId);
    if (salvou) {
      await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 2);
      await clearPendingMessages(userId);
      await redisDel(`aguardando_contato:${userId}`);
      await redisDel(`contato_detectado:${userId}`);
      console.log(`Reserva concluída e estados limpos para ${userId}`);
    } else {
      console.log(`⚠️ Falha ao salvar reserva para ${userId} — owner notificado`);
    }
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

  if (await shouldSkipDuplicateReply(userId, cleanReply)) {
    console.log(`Resposta duplicada ignorada para ${userId}`);
    return;
  }

  const replyLower = cleanReply.toLowerCase();
  const pedindoDadosReserva =
    (replyLower.includes("telefone") || replyLower.includes("contato")) &&
    (
      replyLower.includes("previsão total") || replyLower.includes("previsao total") ||
      replyLower.includes("total de pessoas") || replyLower.includes("quantas pessoas") ||
      replyLower.includes("previsão de pessoas") || replyLower.includes("previsao de pessoas")
    );

  if (pedindoDadosReserva) {
    await redisSet(`aguardando_contato:${userId}`, "1", 600);
    console.log(`Bot está aguardando telefone/previsão de pessoas de ${userId}`);
  }

  await markLastReply(userId, cleanReply);
  await redisSet(`echo_bot:${userId}`, "1", 30);
  await sendInstagramMessage(userId, cleanReply);
  await salvarUltimaRespostaBot(userId, cleanReply);

  const isConfirmacao = !!reservation;
  const isEscalacao = !!escalation;

  if (!isConfirmacao && !isEscalacao && respostaContemInfoReserva(cleanReply)) {
    await agendarFollowUp(userId);
    console.log(`Follow-up agendado para ${userId} em 6h`);
  }
}

// ─── Rotas Express ────────────────────────────────────────────────────────────

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

    if (messaging?.read || messaging?.delivery || messaging?.message_edit) return;

    if (messaging?.message?.is_echo) {
      const recipientId = messaging?.recipient?.id;
      const echoDoBot = await redisGet(`echo_bot:${recipientId}`);

      if (echoDoBot) {
        await redisDel(`echo_bot:${recipientId}`);
        console.log(`Echo do bot ignorado para ${recipientId}`);
        return;
      }

      // Intervenção humana real
      console.log(`Intervenção humana REAL detectada para ${recipientId}`);

      // salva mensagem do atendente no histórico para o Claude ter contexto depois
      const echoText = messaging?.message?.text;
      if (echoText) {
        const hist = await getHistory(recipientId);
        hist.push({ role: "assistant", content: `[atendente] ${echoText}` });
        if (hist.length > 20) hist.splice(0, 2);
        await saveHistory(recipientId, hist);
        console.log(`Mensagem do atendente salva no histórico de ${recipientId}`);
      }

      await pauseConversation(recipientId);
      await clearPendingMessages(recipientId);
      await marcarIntervencaoHumana(recipientId, messaging?.message?.text || "");
      await setDebounceToken(recipientId, `cancelled_${Date.now()}`);
      await cancelarFollowUp(recipientId);
      return;
    }

    const senderId = messaging?.sender?.id;
    if (!senderId) return;

    if (await isConversaEscalada(senderId)) {
      console.log(`Conversa com ${senderId} está escalada — ignorando mensagem`);
      return;
    }

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

    let message = messaging?.message?.text || "";

    // PONTO 7: só grava contato se reserva ainda não estiver confirmada
    if (message && isOnlyPhoneNumber(message)) {
      if (!(await redisGet(`reserva_confirmada:${senderId}`))) {
        console.log(`Telefone detectado automaticamente de ${senderId}: ${message}`);
        await redisSet(`contato_detectado:${senderId}`, message, 86400);
      }
    }

    if (await redisGet(`reserva_confirmada:${senderId}`)) {
      console.log(`Cliente ${senderId} já tem reserva — mantendo atendimento normal`);
    }

    const aguardandoContato = await redisGet(`aguardando_contato:${senderId}`);
    const contatoDetectado = await redisGet(`contato_detectado:${senderId}`);

    const hasMedia = !message && (
      messaging?.message?.sticker_id ||
      messaging?.message?.attachments?.some(a => a.type !== "fallback")
    );

    if (hasMedia && !isOnlyPhoneNumber(message)) {
      if (aguardandoContato || contatoDetectado) {
        console.log(`Mídia/card recebido de ${senderId} com contexto de contato já detectado — ignorando bloqueio de mídia.`);
        return;
      } else {
        if (await isHorarioComercial()) {
          await sendInstagramMessage(senderId, "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!");
        }
        return;
      }
    }

    if (!message) return;

    if (detectCancelamento(message)) {
      console.log(`Cancelamento detectado de ${senderId}`);
      await cancelarReservaNoNotion(senderId);
    }

    await addPendingMessage(senderId, message);
    console.log(`Mensagem de ${senderId} adicionada à fila: ${message}`);

    if (await isPaused(senderId)) {
      console.log(`Conversa com ${senderId} pausada — mensagem enfileirada, aguardando expiração`);
      return;
    }

    // Se conversa foi encerrada por humano e pausa expirou: cliente reabre com nova mensagem

    if (!(await isHorarioComercial())) {
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarLimpezaSemanal();
  agendarRotinasDiarias();
  agendarVerificacaoHorario();
  notifyOwner("🟢 Bot Candiá iniciado e online!").catch(() => {});
});
