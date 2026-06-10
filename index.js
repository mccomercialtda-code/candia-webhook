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
const NOTION_PROGRAMACAO_DB_ID = "34ddbe8049f980a8be44c3f937a912ec";
const NOTION_CLIENTES_DB_ID = "33adbe8049f980bd9701edf5d610526d";
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IG_ACCOUNT_ID = "17841401897917144";
const DEBOUNCE_MS = 90000; // 1.5 min
const FOLLOWUP_MS = 6 * 60 * 60 * 1000; // 6 horas

// Horário de funcionamento do bot (Brasília)
const HORARIOS_ATENDIMENTO = {
  1: [{ inicio: 8, fim: 12 }, { inicio: 13, fim: 23 }], // segunda
  2: [{ inicio: 8, fim: 12 }, { inicio: 13, fim: 23 }], // terça
  3: [{ inicio: 8, fim: 12 }, { inicio: 13, fim: 23 }], // quarta
  4: [{ inicio: 8, fim: 12 }, { inicio: 13, fim: 23 }], // quinta
  5: [{ inicio: 8, fim: 12 }, { inicio: 13, fim: 18 }], // sexta
  6: [{ inicio: 8, fim: 12 }, { inicio: 16, fim: 19 }], // sábado
  0: [{ inicio: 8, fim: 12 }, { inicio: 15, fim: 23 }],  // domingo
};

const LIMITES = {
  "sexta":   { coberto: 10, descoberto: 0,  total: 10 },
  "sábado":  { coberto: 10, descoberto: 4,  total: 14 },
  "domingo": { coberto: 10, descoberto: 0,  total: 10 }
};

// ─── Helpers de data/hora ─────────────────────────────────────────────────────

// retorna a data atual (00:00) no fuso de Brasília como objeto Date
function getDataBrasilia() {
  const agora = new Date();
  const formatter = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit"
  });
  const partes = formatter.formatToParts(agora);
  const dia = partes.find(p => p.type === "day").value;
  const mes = partes.find(p => p.type === "month").value;
  const ano = partes.find(p => p.type === "year").value;
  return new Date(`${ano}-${mes}-${dia}T00:00:00-03:00`);
}

// retorna a data completa formatada por extenso no fuso de Brasília (ex.: "terça-feira, 03/06/2026")
function getDataBrasiliaCompleta() {
  const agora = new Date();
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(agora);
}

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
  const now = new Date();
  const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hora = brt.getHours();
  const diaSemana = brt.getDay();
  const faixas = HORARIOS_ATENDIMENTO[diaSemana] || [];
  return faixas.some(f => hora >= f.inicio && hora < f.fim);
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

async function verificarDisponibilidadeLocal(dataStr, local) {
  const limites = { "Fundos": 3, "Corredor": 3, "Frente": 4 };
  const limite = limites[local];
  if (!limite) return { disponivel: true, count: 0 };

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
          and: [
            { property: "Data", rich_text: { equals: convertDateToISO(dataStr) } },
            { property: "Local", select: { equals: local } }
          ]
        }
      })
    });
    const data = await res.json();
    const count = data.results?.length || 0;
    return { disponivel: count < limite, count, limite };
  } catch (err) {
    console.error("Erro ao verificar disponibilidade de local:", err);
    return { disponivel: true, count: 0 };
  }
}

async function proximoNumeroDoDia(dataISO) {
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
    return (data.results?.length || 0) + 1;
  } catch {
    return 1;
  }
}

async function verificarDisponibilidade(dataStr) {
  const diaSemana = getDiaSemana(dataStr);
  const dataISO = convertDateToISO(dataStr);

  // Override manual tem prioridade sobre o Notion
  const override = await getOverride(dataISO);
  if (override === "esg") return { disponivel: false, tipo: "esgotado", override: true, diaSemana };
  if (override === "ext") return { disponivel: true, tipo: "descoberto", override: true, vagasDescoberto: 1, diaSemana };

  // verifica se há limite especial configurado para este dia
  const regraDiaEsp = await getRegraDia(dataISO);
  let limites = LIMITES[diaSemana];

  if (regraDiaEsp?.limite_reservas) {
    const limiteEsp = parseInt(regraDiaEsp.limite_reservas);
    if (!isNaN(limiteEsp)) {
      limites = { coberto: limiteEsp, descoberto: 0, total: limiteEsp };
    }
  }

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
  // Guarda: bloqueia qualquer reserva com ano anterior a 2026
  const partesData = String(data.data || "").split("/");
  const anoReserva = partesData.length === 3 ? parseInt(partesData[2]) : NaN;
  if (!isNaN(anoReserva) && anoReserva < 2026) {
    console.error(`Reserva bloqueada: ano ${anoReserva} < 2026 para ${instagramId}`);
    await notifyOwner(
      `⚠️ Reserva BLOQUEADA — ano inválido (${anoReserva} < 2026)!\n` +
      `👤 Cliente: ${instagramId}\n` +
      `📋 Aniversariante: ${data.aniversariante || "—"}\n` +
      `📅 Data: ${data.data || "—"}${data.dia ? ` (${data.dia})` : ""}\n` +
      `👥 Pessoas: ${data.total_esperado || "—"}\n` +
      `📞 Contato: ${data.contato || "—"}\n` +
      `📍 Local: ${data.local || "—"}\n\n` +
      `Corrija o ano e use /reservar @username para gravar manualmente.`
    );
    return false;
  }

  const properties = {
    "Nome": { title: [{ text: { content: data.aniversariante || "" } }] },
    "Data": { rich_text: [{ text: { content: convertDateToISO(data.data) } }] },
    "Dia": { rich_text: [{ text: { content: formatDiaNotion(data.dia, data.data) } }] },
    "Contato": { rich_text: [{ text: { content: data.contato || "" } }] },
    "Lugares": { number: parseInt(data.lugares) || 0 },
    "Total esperado": { number: parseInt(data.total_esperado) || 0 },
    "Instagram ID": { rich_text: [{ text: { content: instagramId || "" } }] }
  };

  // adiciona Instagram Username se disponível no cache
  const igUsername = instagramId ? await redisGet(`ig_username:${instagramId}`) : null;
  if (igUsername) {
    properties["Instagram Username"] = {
      rich_text: [{ text: { content: igUsername } }]
    };
  }

  if (data.observacao && data.observacao.trim()) {
    properties["Observações"] = {
      rich_text: [{ text: { content: data.observacao.trim() } }]
    };
  }

  if (data.local && data.local.trim()) {
    properties["Local"] = { select: { name: data.local.trim() } };
  }

  const numeroDoDia = await proximoNumeroDoDia(convertDateToISO(data.data));
  properties["Nº do dia"] = { number: numeroDoDia };

  const body = JSON.stringify({ parent: { database_id: NOTION_DB_ID }, properties });
  const headers = {
    "Authorization": `Bearer ${NOTION_TOKEN}`,
    "Content-Type": "application/json",
    "Notion-Version": "2022-06-28"
  };

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
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

    if (tentativa < 2) await sleep(5000);
  }

  // Ambas as tentativas falharam — notifica com dados completos para salvar manualmente
  await notifyOwner(
    `⚠️ Reserva NÃO gravada no Notion!\n` +
    `👤 Cliente: ${instagramId}\n` +
    `📋 Aniversariante: ${data.aniversariante || "—"}\n` +
    `📅 Data: ${data.data || "—"}${data.dia ? ` (${data.dia})` : ""}\n` +
    `👥 Pessoas: ${data.total_esperado || "—"}\n` +
    `📞 Contato: ${data.contato || "—"}\n` +
    `📍 Local: ${data.local || "—"}\n\n` +
    `Grave manualmente ou use /reservar @username`
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

// retorna a data BR (DD/MM/AAAA) da reserva mais recente do cliente, ou null
async function getDataReservaCliente(userId) {
  if (!userId) return null;
  const cached = await redisGet(`reserva_data:${userId}`);
  if (cached) return cached;
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
    const dataISO = data.results[0].properties?.Data?.rich_text?.[0]?.text?.content || "";
    if (!dataISO) return null;
    const dataBR = formatDateBR(dataISO);
    await redisSet(`reserva_data:${userId}`, dataBR, 86400 * 30);
    return dataBR;
  } catch (err) {
    console.error(`Erro ao buscar data da reserva no Notion para ${userId}:`, err);
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

async function buscarProgramacaoPorData(dataISO) {
  const callNotion = async () => {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_PROGRAMACAO_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: { property: "Data", date: { equals: dataISO } }
      })
    });
    return await res.json();
  };

  try {
    let data;
    try {
      data = await callNotion();
    } catch (err) {
      if (err.message && err.message.includes("Unexpected token '<'")) {
        console.log("Rate limit Notion programação — aguardando 10s antes de retry");
        await sleep(10000);
        data = await callNotion();
      } else {
        throw err;
      }
    }
    const results = data.results || [];
    if (results.length > 0) {
      let especial = false;
      let mensagemExata = null;
      let instrucoes = null;
      const linhas = results.map(p => {
        if (p.properties?.["Especial"]?.checkbox) {
          especial = true;
          const me = p.properties?.["Mensagem Exata"]?.rich_text?.[0]?.plain_text || null;
          const ins = p.properties?.["Instruções"]?.rich_text?.[0]?.plain_text || null;
          if (me && !mensagemExata) mensagemExata = me;
          if (ins && !instrucoes) instrucoes = ins;
        }
        const artista = p.properties?.Artista?.title?.[0]?.plain_text || "A confirmar";
        const horarioProp = p.properties?.Horario;
        const horario = (
          horarioProp?.select?.name ||
          horarioProp?.rich_text?.[0]?.plain_text ||
          horarioProp?.date?.start ||
          ""
        ).trim();
        console.log(`Horario raw:`, JSON.stringify(horarioProp));
        const estilo = (p.properties?.Estilo?.rich_text?.[0]?.plain_text || "").trim();
        const igRaw = (p.properties?.Instagram?.rich_text?.[0]?.plain_text || "").trim();
        const instagram = igRaw ? (igRaw.startsWith("@") ? igRaw : `@${igRaw}`) : "";
        const partes = [];
        if (horario) partes.push(horario);
        partes.push(instagram || artista);
        if (estilo) partes.push(estilo);
        return `- ${partes.join(" — ")}`;
      });
      return { linhas: linhas.join("\n"), especial, mensagemExata, instrucoes };
    }
    return null;
  } catch (err) {
    console.error("Erro ao buscar programação:", err);
    return null;
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
        await redisSet(`echo_bot:${igId}`, "1", 30);
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
  }
  // sucesso silencioso — sem notificação quando tudo funciona
}

// Busca reservas criadas hoje (pelo campo created_time da API Notion)
async function buscarReservasCriadasHoje() {
  try {
    const hoje = getTodayISO(); // YYYY-MM-DD
    const inicioDia = `${hoje}T00:00:00.000Z`;
    const fimDia = `${hoje}T23:59:59.999Z`;

    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: {
          and: [
            { timestamp: "created_time", created_time: { on_or_after: inicioDia } },
            { timestamp: "created_time", created_time: { on_or_before: fimDia } }
          ]
        }
      })
    });
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    console.error("Erro ao buscar reservas criadas hoje:", err);
    return [];
  }
}

// Relatório diário às 22h: reservas GRAVADAS hoje (independente da data da reserva)
async function enviarResumoDiario() {
  console.log("Enviando resumo diário...");
  const reservas = await buscarReservasCriadasHoje();

  if (reservas.length === 0) {
    await notifyOwner("📋 Resumo do dia: nenhuma reserva gravada hoje.");
    return;
  }

  const linhas = reservas.map(r => {
    const nome = r.properties?.Nome?.title?.[0]?.text?.content || "—";
    const dataReserva = r.properties?.Data?.rich_text?.[0]?.text?.content || "—";
    const lugares = r.properties?.Lugares?.number || "—";
    const total = r.properties?.["Total esperado"]?.number || "—";
    const obs = r.properties?.Observações?.rich_text?.[0]?.text?.content || "";
    return `• ${nome} | ${dataReserva} | ${lugares} lugares | ${total} esperados${obs ? ` | ${obs}` : ""}`;
  });

  await notifyOwner(`📋 Reservas gravadas hoje (${getTodayISO()}):\n${linhas.join("\n")}`);
}

// Relatório semanal: todas as reservas futuras agrupadas por data
async function enviarRelatorioSemanal() {
  console.log("Enviando relatório semanal de reservas...");
  try {
    const hoje = getTodayISO();
    let todasReservas = [];
    let hasMore = true;
    let startCursor = undefined;

    while (hasMore) {
      const bodyObj = {
        page_size: 100,
        filter: {
          property: "Data",
          rich_text: { is_not_empty: true }
        },
        sorts: [{ property: "Data", direction: "ascending" }]
      };
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
        const dataISO = page.properties?.Data?.rich_text?.[0]?.text?.content || "";
        if (dataISO >= hoje) todasReservas.push(page);
      }

      hasMore = data.has_more || false;
      startCursor = data.next_cursor || undefined;
    }

    if (todasReservas.length === 0) {
      await notifyOwner("📅 Relatório semanal: nenhuma reserva futura encontrada.");
      return;
    }

    // Agrupa por data
    const porData = {};
    for (const r of todasReservas) {
      const dataISO = r.properties?.Data?.rich_text?.[0]?.text?.content || "—";
      const dia = r.properties?.Dia?.rich_text?.[0]?.text?.content || dataISO;
      if (!porData[dataISO]) porData[dataISO] = { dia, reservas: [] };
      porData[dataISO].reservas.push(r);
    }

    const blocos = [];
    for (const dataISO of Object.keys(porData).sort()) {
      const { dia, reservas } = porData[dataISO];
      const linhas = reservas.map(r => {
        const nome = r.properties?.Nome?.title?.[0]?.text?.content || "—";
        const lugares = r.properties?.Lugares?.number || "—";
        const total = r.properties?.["Total esperado"]?.number || "—";
        const obs = r.properties?.Observações?.rich_text?.[0]?.text?.content || "";
        return `${nome} - ${lugares}p - prev ${total}${obs ? ` - ${obs}` : ""}`;
      });
      blocos.push(`${dia}\n${linhas.join("\n")}`);
    }

    await notifyOwner(`📅 Reservas futuras:\n\n${blocos.join("\n\n")}`);
  } catch (err) {
    console.error("Erro ao enviar relatório semanal:", err);
    await notifyOwner(`⚠️ Erro ao gerar relatório semanal: ${err.message}`);
  }
}

// ─── Agendamentos ─────────────────────────────────────────────────────────────
async function sincronizarClientesComReservas() {
  try {
    console.log("Sincronizando clientes com reservas...");
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
        const igId = page.properties?.["Instagram ID"]?.rich_text?.[0]?.text?.content || "";
        const nome = page.properties?.Nome?.title?.[0]?.text?.content || "";
        const contato = page.properties?.Contato?.rich_text?.[0]?.text?.content || "";
        const igUsername = page.properties?.["Instagram Username"]?.rich_text?.[0]?.text?.content || "";

        if (!igId && !igUsername) continue;

        await criarOuAtualizarCliente(igId || "sem_id", {
          nome: nome || undefined,
          telefone: contato ? contato.replace(/\D/g, "") : undefined,
          username: igUsername || undefined,
          origem: "Orgânico",
          motivo: "Reserva",
          atualizarReserva: false
        });
      }

      hasMore = data.has_more || false;
      startCursor = data.next_cursor || undefined;
    }
    console.log("Sincronização de clientes concluída.");
  } catch (err) {
    console.error("Erro ao sincronizar clientes com reservas:", err);
  }
}

function agendarLimpezaDiaria() {
  function msAte10h() {
    const now = new Date();
    const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

    const target = new Date(brt);
    target.setHours(10, 0, 0, 0);

    if (target <= brt) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - brt.getTime();
  }

async function executar() {
    try {
      // sincroniza clientes antes de limpar reservas
      await sincronizarClientesComReservas();
      const removidas = await limparReservasAntigas();

      if (removidas > 0) {
        await notifyOwner(`🗑 ${removidas} reserva(s) antiga(s) removida(s).`);
      } else {
        console.log("Limpeza automática concluída: 0 reservas removidas.");
      }

    } catch (err) {
      await notifyOwner(`⚠️ Erro na limpeza automática: ${err.message}`);
    }

    setTimeout(executar, msAte10h());
  }

  const ms = msAte10h();
  console.log(`Limpeza automática diária agendada em ${Math.round(ms / 3600000)}h`);

  setTimeout(executar, ms);
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

  
  function agendarResumo() {
    const ms = msAteHorario(22, 1);
    console.log(`Resumo diário agendado em ${Math.round(ms / 3600000)}h`);
    setTimeout(() => {
      enviarResumoDiario().catch(err => console.error("Erro no resumo:", err));
      setTimeout(agendarResumo, 1000);
    }, ms);
  }

  function agendarRelatorioSemanal() {
    const now = new Date();
    const brt = new Date(now.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const diaSemana = brt.getDay(); // 0=dom, 2=ter, 3=qua, 4=qui, 6=sab

    // Relatório às 18h de ter a qui; às 12h no sab e dom
    const diasComRelatorio = {
      2: 18, // terça
      3: 18, // quarta
      4: 18, // quinta
      6: 12, // sábado
      0: 12  // domingo
    };

    if (diasComRelatorio[diaSemana] !== undefined) {
      const ms = msAteHorario(diasComRelatorio[diaSemana], 0);
      console.log(`Relatório semanal agendado em ${Math.round(ms / 3600000)}h`);
      setTimeout(() => {
        enviarRelatorioSemanal().catch(err => console.error("Erro no relatório semanal:", err));
        setTimeout(agendarRelatorioSemanal, 1000);
      }, ms);
    } else {
      // dia sem relatório (seg, sex) — verifica de novo em 1h
      setTimeout(agendarRelatorioSemanal, 60 * 60 * 1000);
    }
  }

  agendarResumo();
  agendarRelatorioSemanal();
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

      // não envia follow-up se houve intervenção humana nos últimos 5 minutos
      const ultimaIntervencaoWorker = await redisGet(`ultima_intervencao:${userId}`);
      if (ultimaIntervencaoWorker && Date.now() - parseInt(ultimaIntervencaoWorker) < 5 * 60 * 1000) {
        console.log(`Follow-up (worker) cancelado para ${userId} — intervenção humana recente`);
        await redisDel(`followup:${userId}`);
        continue;
      }

      await redisDel(`followup:${userId}`);

      let mensagem = "Oi! Ficou alguma dúvida? Se quiser, a gente segue por aqui 😊";
      if (await redisGet(`humano_informou:${userId}`)) {
        mensagem = "Oi! Só passando pra saber se ficou alguma dúvida 😊 Se quiser, a gente segue por aqui.";
      }

      await redisSet(`echo_bot:${userId}`, "1", 180);
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

  // sincroniza flag de reserva a cada 30 minutos
  setInterval(() => {
    sincronizarReservasClientes().catch(err => console.error("Erro na sincronização de reservas:", err));
  }, 30 * 60 * 1000);
}

async function processarFilaAcumulada() {
  // evita processamento duplo simultâneo
  const lockUrl = `${UPSTASH_URL}/set/${encodeURIComponent("lock:fila_acumulada")}/1?NX&EX=30`;
  const lockRes = await fetch(lockUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
  });
  const lockData = await lockRes.json();
  if (lockData.result !== "OK") {
    console.log("Fila acumulada já está sendo processada — ignorando");
    return;
  }
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


// ─── CRM Clientes ─────────────────────────────────────────────────────────────

async function detectarMotivoContato(mensagem) {
  const t = mensagem.toLowerCase();
  if (t.includes("reserva") || t.includes("reservar") || t.includes("mesa") || t.includes("aniversário") || t.includes("aniversario")) return "Reserva";
  if (t.includes("programação") || t.includes("programacao") || t.includes("show") || t.includes("banda") || t.includes("musica") || t.includes("música") || t.includes("samba")) return "Programação";
  if (t.includes("cancel") || t.includes("desmarcar")) return "Cancelamento";
  return "Informações";
}

async function buscarClienteNotion(instagramId, username = "") {
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_CLIENTES_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: { property: "Instagram ID", rich_text: { equals: instagramId } },
        page_size: 1
      })
    });
   const data = await res.json();
    if (data.object === "error") console.error("Erro Notion buscar cliente:", JSON.stringify(data));
if (data.results && data.results.length > 0) return data.results[0];

    // fallback: busca por username se ID não encontrou
    if (username) {
      const usernameClean = username.replace("@", "").toLowerCase();
      const res2 = await fetch(`https://api.notion.com/v1/databases/${NOTION_CLIENTES_DB_ID}/query`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body: JSON.stringify({
          filter: { property: "Username", rich_text: { contains: usernameClean } },
          page_size: 1
        })
      });
      const data2 = await res2.json();
      if (data2.results && data2.results.length > 0) return data2.results[0];
    }

    return null;
  } catch (err) {
    console.error("Erro ao buscar cliente no Notion:", err);
    return null;
  }
}

async function criarOuAtualizarCliente(userId, { nome, telefone, username, origem, motivo, atualizarReserva = false, observacao = "" } = {}) {
  try {
    const clienteExistente = await buscarClienteNotion(userId, username || "");
    const agora = new Date().toISOString().split("T")[0];

    if (clienteExistente) {
      // Atualiza campos variáveis
      const props = {
        "Último contato": { date: { start: agora } }
      };
      if (telefone) props["Telefone"] = { rich_text: [{ text: { content: telefone } }] };
      if (username) props["Username"] = { rich_text: [{ text: { content: username } }] };
      if (nome && nome !== "—") props["Nome"] = { title: [{ text: { content: nome } }] };
      if (observacao) {
        const obsAtual = clienteExistente.properties?.Observações?.rich_text?.[0]?.text?.content || "";
        const novaObs = obsAtual ? `${obsAtual}
${observacao}` : observacao;
        props["Observações"] = { rich_text: [{ text: { content: novaObs } }] };
      }

      if (atualizarReserva) {
        const totalAtual = clienteExistente.properties?.["Total de reservas"]?.number || 0;
        const novoTotal = totalAtual + 1;
        props["Total de reservas"] = { number: novoTotal };
        if (novoTotal >= 2) props["Cliente recorrente"] = { checkbox: true };

        // Acumula histórico
        const histAtual = clienteExistente.properties?.["Histórico de reservas"]?.rich_text?.[0]?.text?.content || "";
        const dataHoje = new Date().toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
        const novoHist = histAtual ? `${histAtual} | ${dataHoje}` : dataHoje;
        props["Histórico de reservas"] = { rich_text: [{ text: { content: novoHist } }] };
        if (nome && nome !== "—") props["Nome"] = { title: [{ text: { content: nome } }] };
      }

      await fetch(`https://api.notion.com/v1/pages/${clienteExistente.id}`, {
        method: "PATCH",
        headers: {
          "Authorization": `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body: JSON.stringify({ properties: props })
      });
    } else {
      // Cria novo registro
      const props = {
        "Nome": { title: [{ text: { content: nome || "—" } }] },
        "Instagram ID": { rich_text: [{ text: { content: userId } }] },
        "Username": { rich_text: [{ text: { content: username || "" } }] },
        "Telefone": { rich_text: [{ text: { content: telefone || "" } }] },
        "Origem": { select: { name: origem || "Orgânico" } },
        "Motivo do primeiro contato": { select: { name: motivo || "Informações" } },
        "Primeiro contato": { date: { start: agora } },
        "Último contato": { date: { start: agora } },
        "Total de reservas": { number: 0 },
        "Atendido por humano": { checkbox: false },
        "Cliente recorrente": { checkbox: false },
      };
      if (observacao) props["Observações"] = { rich_text: [{ text: { content: observacao } }] };

      const resCreate = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${NOTION_TOKEN}`,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body: JSON.stringify({ parent: { database_id: NOTION_CLIENTES_DB_ID }, properties: props })
      });
      const resultado = await resCreate.json();
      if (resultado.object === "error") console.error("Erro Notion criar cliente:", JSON.stringify(resultado));
      else console.log("Cliente criado no Notion:", resultado.id);
    }
  } catch (err) {
    console.error("Erro ao criar/atualizar cliente no Notion:", err);
  }
}

async function marcarClienteAtendidoPorHumano(userId) {
  try {
    const cliente = await buscarClienteNotion(userId);
    if (!cliente) return;
    await fetch(`https://api.notion.com/v1/pages/${cliente.id}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        properties: { "Atendido por humano": { checkbox: true } }
      })
    });
  } catch (err) {
    console.error("Erro ao marcar cliente atendido por humano:", err);
  }
}

async function sincronizarReservasClientes() {
  if (!(await isHorarioComercial())) return;
  try {
    const res = await fetch(`${UPSTASH_URL}/keys/ig_username:*`, {
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    const keys = data.result || [];

    // chamada Notion com retry no caso de receber HTML (rate limit)
    async function buscarPageComRetry(userId) {
      const callNotion = async () => {
        const notionRes = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
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
        const json = await notionRes.json();
        if (!json.results || json.results.length === 0) return null;
        return json.results[0].id;
      };
      try {
        return await callNotion();
      } catch (err) {
        if (err.message && err.message.includes("Unexpected token '<'")) {
          console.log("Rate limit Notion — aguardando 10s antes de retry");
          await sleep(10000);
          try {
            return await callNotion();
          } catch (retryErr) {
            console.error(`Retry sincronização falhou para ${userId}:`, retryErr.message);
            return null;
          }
        }
        console.error(`Erro Notion na sincronização para ${userId}:`, err.message);
        return null;
      }
    }

    for (const key of keys) {
      const userId = key.replace("ig_username:", "");
      if (await redisGet(`reserva_confirmada:${userId}`)) continue;
      const pageId = await buscarPageComRetry(userId);
      if (pageId) {
        await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
        console.log(`Flag reserva sincronizada para ${userId}`);
      }
      await sleep(8000); // evita rate limit do Notion
    }
  } catch (err) {
    console.error("Erro ao sincronizar reservas:", err);
  }
}

async function gerarResumoConversa(hist) {
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
        max_tokens: 200,
        system: `Data de hoje no fuso de Brasília: ${getDataBrasiliaCompleta()}.
"Amanhã" = dia seguinte a essa data.
"Essa semana" = semana atual nesse fuso.
Qualquer data sem ano explícito = 2026.
NUNCA usar 2025.

Você vai resumir em 1-3 frases curtas o que foi combinado nesta conversa entre cliente e atendente de um bar. Foque em: data/hora da reserva, número de pessoas, condições especiais prometidas, status da reserva. REGRAS OBRIGATÓRIAS: (1) Se houver um bloco [RESERVA: ...] no histórico, a reserva está CONFIRMADA — nunca diga que não há reserva confirmada nesses casos. (2) Se o bloco [RESERVA: ...] NÃO estiver presente, a reserva NÃO está confirmada — descreva o status real: pendente, aguardando telefone, aguardando confirmação etc. NUNCA, em nenhuma hipótese, escrever a palavra 'confirmada' para a reserva se o bloco [RESERVA: ...] não estiver presente no histórico. (3) NUNCA reproduzir, copiar ou citar trechos das mensagens do histórico no resumo — escreva SEMPRE com suas próprias palavras, em terceira pessoa, descrevendo o que foi combinado. Não use aspas. Não cole frases do cliente nem do atendente. Seja objetivo e direto. Responda apenas o resumo, sem introdução.`,
        messages: [{ role: "user", content: hist.map(h => `${h.role}: ${h.content}`).join("\n") }]
      })
    });
    const data = await claudeRes.json();
    return data.content?.[0]?.text || "";
  } catch (err) {
    console.error("Erro ao gerar resumo:", err);
    return "";
  }
}

async function salvarHistoricoCompleto(userId, mensagem, role = "user") {
  try {
    const key = `hist_completo:${userId}`;
    const raw = await redisGet(key);
    const hist = raw ? JSON.parse(raw) : [];
    hist.push({ role, content: mensagem, ts: new Date().toISOString() });
    await redisSet(key, JSON.stringify(hist), 86400 * 60);
  } catch (err) {
    console.error("Erro ao salvar histórico completo:", err);
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────

function getSystemPrompt(disponibilidade, regrasDia = null) {
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

 const regrasEspeciaisInfo = "";

   return `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Atende clientes pelo Instagram Direct.

DATA E HORA ATUAL
Data de hoje no fuso de Brasília: ${getDataBrasiliaCompleta()} — agora são ${horaAgora}.
"Amanhã" = dia seguinte a essa data.
"Essa semana" = semana atual nesse fuso.
Qualquer data sem ano explícito = 2026.
NUNCA usar 2025.

ATENÇÃO — INTERPRETAÇÃO DE DATAS
* O ano atual é ${now.getFullYear()}. SEMPRE interpretar datas sem ano explícito como ${now.getFullYear()}.
* Exemplos: "03/06" = 03/06/${now.getFullYear()}, "dia 13 de junho" = 13/06/${now.getFullYear()}
* NUNCA assumir 2025 (nem qualquer ano anterior a ${now.getFullYear()}) para qualquer data
* Se o mês mencionado já passou neste ano, usar ${now.getFullYear() + 1}
* Quando o cliente mencionar um dia da semana sem data específica ("quinta", "sábado", "domingo", "essa sexta", "essa semana"), interpretar sempre como o próximo dia da semana mais próximo a partir de hoje
* Nunca pedir confirmação de qual data o cliente quer — assumir o próximo dia correspondente e seguir
${dispInfo}${regrasEspeciaisInfo}

IDENTIDADE E TOM

* Simpático, leve, acolhedor e com cara de conversa real — nunca robótico
* Falar como alguém do bar, não como sistema
* Primeira pessoa do plural: "a gente", "conseguimos", "seguramos", "aguardamos"
* Emojis com moderação
* Texto simples, sem markdown
* Nunca mencionar "dono" ou "proprietário"
* Atendimento apenas via Instagram ou presencial

ATENDIMENTO E CONTATO

* O cliente já está no Instagram Direct — NUNCA dizer "entre em contato pelo Instagram", "manda mensagem no @ocandiabar" ou qualquer variação que trate o Instagram como canal externo
* Para informações que o bot não tem acesso (fotos, mídias, cardápio completo), a única exceção permitida é direcionar para os destaques do próprio perfil: "você pode ver aqui nos destaques do nosso perfil 😊" — NUNCA "acesse o @ocandiabar" ou "vá no nosso Instagram"
* Para qualquer outra informação que o bot não tenha acesso e não seja cardápio/programação/fotos, escalar silenciosamente sem dizer que não tem a informação

SAUDAÇÃO

* Se o cliente disser "tudo bem?", responder:
  "Tudo bem, e você? 😊"
  ou
  "Tudo bem por aqui, e por aí? 😊"
* Sempre já puxar o assunto na sequência
* Nunca usar "tudo bem sim, obrigado"

REGRA GERAL

* Responder apenas o que foi perguntado
* Nunca sugerir nada que o cliente não pediu
* Respostas curtas e naturais
* Soar humano, não institucional
* Em geral, NÃO mencionar o dia da semana em respostas. Evitar dizer "é uma sexta", "é um sábado", "cai numa quinta", "dia X é terça" etc. Responder com a data numérica (DD/MM ou DD/MM/AAAA) na maior parte dos casos. EXCEÇÃO PERMITIDA: ao informar o horário-limite da mesa após confirmar disponibilidade, pode usar a estrutura "No <dia> a mesa fica segurada até as <hora>…" conforme exemplos em FLUXO DE RESERVA. Mesmo nessa exceção, jamais usar dia da semana apenas para responder "qual é o dia" — só dentro do contexto do horário-limite
* Nunca usar separadores como "---", "***" ou similares nas mensagens
* Se o cliente não perguntar diretamente por reserva, pode oferecer — mas somente uma vez. Não ofereça em todas as mensagens
* NUNCA inventar ou usar blocos de comando como [CONSULTAR_DISPONIBILIDADE:] ou qualquer outro bloco não definido — esses blocos não existem no sistema e serão enviados ao cliente como texto. Os únicos blocos válidos são [RESERVA:...] e [ESCALAR:...]
* Se a disponibilidade de uma data não estiver no contexto, responder normalmente — o sistema já verificou antes de chamar o Claude

CONTEXTO DO CLIENTE (OBRIGATÓRIO)

* Sempre considerar o que o cliente já informou
* Nunca repetir perguntas já respondidas
* Perguntar apenas o que ainda estiver faltando
* Se o cliente disser "só passando pra confirmar", "tudo certo?", "confirmar a reserva" ou similar, e houver flag de reserva confirmada no contexto, responder confirmando a reserva — NUNCA perguntar "confirmar o quê?"
* Se não houver dados suficientes no contexto, perguntar gentilmente: "Pode me confirmar seu nome? Assim confirmo tudo certinho pra você 😊"
* Se o cliente já aceitou as condições da reserva e a reserva foi confirmada, NUNCA repetir as restrições como se fossem um problema — a reserva está feita e as condições já foram acordadas
* Ao responder dúvidas pós-confirmação, tratar como esclarecimento, não como novo aviso de restrição

ESTRUTURA DE RESPOSTA (OBRIGATÓRIO)
Sempre seguir esta ordem:

1. Confirmar o que o cliente disse
2. Perguntar apenas o que falta
3. Só explicar regras depois que tiver a data

* Nunca misturar pergunta com explicação longa
* Nunca explicar regras antes da data
* Manter fluidez de conversa

RESPOSTAS CURTAS (CRÍTICO)

* Nunca mais de 2 ideias por mensagem
* Se o cliente fizer várias perguntas:
  → responder no máximo 2
  → continuar na próxima mensagem
* Se a resposta ficar longa: dividir em múltiplas mensagens curtas
* Nunca enviar blocos grandes de texto

INTERPRETAÇÃO DE RESPOSTAS CURTAS

* "ok", "sim", "pode ser" indicam continuidade
* Nunca reiniciar fluxo
* Nunca repetir perguntas

NÃO REPETIR INFORMAÇÕES

* Não repetir regras já explicadas
* Avançar sempre o fluxo

ENDEREÇO
* Avenida Francisco Sá, 430 - Prado, Belo Horizonte

FUNCIONAMENTO

* Horários de funcionamento:
  - Terça a quinta: 16h às 00h
  - Sexta: 11h às 01h
  - Sábado: 12h às 00h
  - Domingo: 12h às 21h
  - Segunda: fechado
* NUNCA dizer que "a música vai até o fechamento" ou "até fechar". A música ao vivo tem horário próprio (ver seção MÚSICA AO VIVO). Se o cliente perguntar até que horas vai a música, responder com o horário da música, NÃO com o horário de fechamento do bar.
* O Candiá é pet friendly — animais de estimação são bem-vindos
* Para perguntas sobre horário de funcionamento em feriados, escalar silenciosamente respondendo APENAS com [ESCALAR: motivo=Dúvida sobre horário em feriado] e nada mais — NUNCA inventar ou assumir horário de feriado

JOGOS / TRANSMISSÕES

* O Candiá transmite todos os jogos de futebol
* Se o cliente perguntar sobre transmissão de jogos, confirmar que sim
* Nunca dizer que não transmite jogos

MÚSICA AO VIVO

* Tem música ao vivo TODOS os dias que o bar funciona (terça a domingo)
* HORÁRIOS DA MÚSICA AO VIVO (OBRIGATÓRIO, sem exceção):
  - Terça a sábado: música ao vivo até aproximadamente 22h
  - Domingo: música ao vivo até aproximadamente 18h
* NUNCA dizer que a música vai até a meia-noite, até o fechamento, "até fechar" ou qualquer horário diferente dos acima
* NUNCA dizer que o bar fecha à meia-noite quando o cliente perguntar sobre música — responda apenas com o horário da música
* Sexta a domingo: samba
* Terça a quinta: programação variada (samba, pagode, brasilidades, etc)
* Se o cliente perguntar onde é a música, onde toca o samba, ou onde fica o palco, responder: "A música normalmente fica na parte interna do bar 😊"
* NUNCA dizer que não tem música ao vivo em dia de funcionamento
* Se existir PROGRAMAÇÃO DO DIA neste prompt, use OBRIGATORIAMENTE esses dados para responder qualquer pergunta sobre música, artista, horário, estilo ou Instagram do artista — mesmo que a pergunta seja indireta
* Ao informar programação, usar SEMPRE o estilo musical exato que consta no Notion — nunca generalizar
* @rayramirandaa toca brasilidades — NUNCA informar como samba
* Se o estilo no Notion for "brasilidades", dizer "brasilidades". Se for "samba e pagode", dizer "samba e pagode". Nunca substituir por "samba" genérico
* Se o cliente perguntar o Instagram do artista e houver PROGRAMAÇÃO DO DIA, responda com o @ da programação — nunca redirecione para @ocandiabar nesse caso
* Só direcionar para os destaques se NÃO houver PROGRAMAÇÃO DO DIA no prompt — nesse caso, responder: "A programação completa está aqui nos destaques do nosso perfil, no tópico 'Agenda' 😊"
* NUNCA dizer apenas "acompanhe pelo Instagram" sem especificar onde encontrar
* Nunca inventar nomes de artistas ou horários
* NUNCA dizer "deixa eu checar", "vou verificar", "em breve retorno" sobre programação — se houver PROGRAMAÇÃO DO DIA no prompt, responda imediatamente com os dados
* REGRA CRÍTICA — MENSAGEM EXATA: se o BRIEFING DO DIA começar com "MENSAGEM EXATA:", use OBRIGATORIAMENTE e INTEGRALMENTE o texto que segue como resposta. Copie palavra por palavra, sem alterar, sem resumir, sem parafrasear, sem adicionar nada antes ou depois. Esta instrução SOBREPÕE qualquer outra regra deste prompt, inclusive regras de tamanho de mensagem, tom ou estrutura.
* EXCEÇÃO ÚNICA: se o RESUMO DA CONVERSA já indicar que o cliente recebeu essa mensagem anteriormente, NÃO repetir — responder naturalmente ao contexto atual usando as informações do resumo
* Se o briefing for MENSAGEM EXATA e o cliente perguntar especificamente sobre programação/atrações/horários das músicas, após enviar a mensagem exata, complementar com os horários das atrações disponíveis no PROGRAMAÇÃO DO DIA

* Ao consultar a programação de uma data, verificar se há campo MENSAGEM EXATA DA PROGRAMAÇÃO no contexto — se sim, enviar OBRIGATORIAMENTE esse texto palavra por palavra quando o cliente perguntar sobre programação ou evento especial, sem alterar nem resumir
* As INSTRUÇÕES ESPECIAIS DO DIA devem ser seguidas para conduzir a conversa naquele dia — substituem briefing de programação mas NÃO substituem as regras fixas de reserva por dia da semana
* Se não houver mensagem exata, seguir o fluxo normal

* FLUXO OBRIGATÓRIO ao receber qualquer pergunta sobre programação, evento, show, música ou atrações:
  1. Verificar se existe MENSAGEM EXATA DA PROGRAMAÇÃO no contexto
  2. Se existe → enviar essa mensagem palavra por palavra, sem alterar, sem adicionar, sem resumir. PARAR AQUI.
  3. Se não existe → informar a programação normal do dia (artista, horário, estilo)

* Este fluxo se aplica a qualquer variação da pergunta: "o que tem hoje?", "qual a programação?", "quem vai tocar?", "tem show?", "qual o evento?", "o que vai rolar?" etc.

* NUNCA misturar a mensagem exata com outras informações — ela já contém tudo que o cliente precisa saber sobre o evento
* NUNCA resumir ou parafrasear a mensagem exata — usar o texto integral
* A mensagem exata NÃO substitui as regras de reserva do dia — se o cliente perguntar sobre reserva após receber a mensagem exata, seguir normalmente o fluxo de reserva do dia da semana correspondente

COUVERT

* Terça a quinta: R$12
* Sexta a domingo: R$10
* Só mencionar se perguntarem
* ATENÇÃO: sempre verificar o dia da data mencionada antes de informar o valor — R$12 para terça/quarta/quinta e R$10 para sexta/sábado/domingo
* NUNCA mencionar couvert, valor de entrada ou taxa na mensagem de confirmação da reserva
* Informar couvert apenas se o cliente perguntar explicitamente

ENTRADA / COUVERT

* Entrada e couvert são a mesma coisa
* Sempre dizer que há couvert
* Nunca dizer "não tem entrada"
* NUNCA dizer "entrada gratuita", "entrada franca", "entrada livre" ou qualquer variação — sempre há couvert
* NUNCA mencionar couvert, valor de entrada ou taxa na mensagem de confirmação da reserva
* Informar couvert apenas se o cliente perguntar explicitamente

FORMA DE PAGAMENTO / COMANDA

* Terça a quinta: comanda individual
* Sexta a domingo: pagamento antecipado via fichas — cada um paga o seu, não precisa dividir conta
* Se perguntarem sobre comanda ou forma de pagamento, responder:
  "De sexta a domingo trabalhamos com pagamento antecipado, via fichas. Aí não precisa se preocupar em dividir a conta, cada um paga o seu 😜"
* Só mencionar se perguntarem

VALE ALIMENTAÇÃO / VALE REFEIÇÃO

* Aceitamos vale alimentação, vale refeição, VR, Sodexo, Ticket e similares APENAS no almoço de sexta-feira
* Para qualquer outro dia ou período: não aceitamos
* Se perguntarem se aceitam, verificar: se for sexta no almoço, confirmar que sim. Caso contrário, informar que não aceitamos
* Nunca dizer que aceitamos sem essa condição — só sexta no almoço
* NUNCA confirmar VR/VA/Sodexo/Ticket para outros dias da semana, para jantar de sexta ou para qualquer outro período — somente almoço de sexta-feira

CARDÁPIO
* NUNCA informar preços de itens individuais do cardápio (cervejas, drinks, comidas, porções) — para preços, SEMPRE direcionar: "Você pode ver nosso cardápio aqui nos destaques do nosso perfil 😊"
* NUNCA listar valores de cerveja, chope, drinks, comida nem dar faixa de preços
* Exceção única: feijoada promocional de sábado (R$20 até 14h) pode ser informada porque é uma promoção específica e divulgada
* Exceções adicionais (só se o cliente perguntar explicitamente o preço): taça de vinho R$25, caldos R$19 — nunca mencionar valor espontaneamente

CERVEJAS

* REFERÊNCIA INTERNA (NUNCA dizer isso ao cliente literalmente): trabalhamos com chope artesanal, algumas long necks, vinhos e drinks
* NUNCA confirmar que temos Heineken regular, garrafa de 600ml, ou qualquer outra cerveja específica
* Para qualquer pergunta sobre cervejas específicas (Heineken, Brahma, Skol, Original, 600ml, etc), responder: "Você pode conferir nossas opções de cerveja aqui nos destaques do nosso perfil 😊"
* EXCEÇÃO — só pode confirmar diretamente se o cliente perguntar:
  - Heineken Zero (sem álcool) — disponível, long neck
  - Stella sem glúten — disponível, long neck
* Heineken Zero e Stella sem glúten estão disponíveis durante todo o horário de funcionamento — nunca dizer que só estão disponíveis a partir de determinado horário
* NUNCA dizer que não temos cerveja sem álcool — temos Heineken Zero
* NUNCA dizer que não temos cerveja sem glúten — temos Stella sem glúten
* Para qualquer outra opção de cerveja, sempre direcionar ao cardápio nos destaques do perfil

VINHO E TAXA DE ROLHA

* Agora temos vinhos disponíveis — se o cliente perguntar se tem vinho, confirmar: "Sim, agora temos vinhos no nosso cardápio 🍷"
* SÓ informar o preço se o cliente perguntar explicitamente: R$25 a taça
* NUNCA mencionar o valor espontaneamente
* Se o cliente perguntar sobre taxa de rolha: R$40 por garrafa
* Informar que não temos taças nem balde de gelo disponíveis para vinho trazido pelo cliente (apenas para os vinhos da casa)
* NUNCA oferecer essas informações espontaneamente — apenas se perguntado

CALDOS

* Agora temos caldos disponíveis — se o cliente perguntar, confirmar: "Sim, agora temos caldos no nosso cardápio 😊"
* Opções: mandioca, feijão, verde, de abóbora e canjica
* SÓ informar o preço se o cliente perguntar explicitamente: R$19 cada
* NUNCA mencionar o valor espontaneamente
* NUNCA oferecer espontaneamente — apenas se perguntado

PROMOÇÃO GRUPO / CORTESIA ANIVERSARIANTE / BENEFÍCIO ANIVERSARIANTE

* Necessário fazer reserva e levar mais de 10 pessoas → Ganha 2 litros de chope
* Sempre tratar isso como benefício principal
* Nunca dizer que não tem benefício/cortesia/promoção
* NUNCA mencionar este benefício espontaneamente — só informar se o cliente perguntar sobre condições especiais, cortesia ou benefícios
* Se o cliente perguntar sobre "condições especiais", "promoções", "tem alguma promoção?", "quais as condições?", "tem cortesia?", "tem benefício?" ou qualquer variação, responder OBRIGATORIAMENTE com TODAS as promoções abaixo (não responder que não tem promoção em nenhuma hipótese):

  "Temos sim algumas condições especiais 😊

  🍺 Reservas com grupo a partir de 10 pessoas ganham 2 litros de chope de cortesia

  E nos dias de jogo do Brasil:
  🍺 1 hora de rodada dupla de Pilsen 300ml antes das partidas
  🎶 Música ao vivo antes/depois dos jogos
  🥃 Rodada de shot de cachaça a cada gol do Brasil por conta da casa"

* Se o cliente pedir para trocar os 2 litros de chope por outra coisa, informar que pode trocar por 1 caipirinha
* Se a data estiver esgotada (sem reservas disponíveis), NUNCA informar condições de aniversário vinculadas à reserva — sem reserva confirmada, o benefício não pode ser garantido
* NUNCA dizer "não temos promoções" ou "não temos condições especiais" — sempre informar pelo menos a cortesia de grupo + as promoções de jogo do Brasil

PROMOÇÕES — DIAS DE JOGO DO BRASIL

* Nos dias de jogo do Brasil, quando o cliente perguntar especificamente sobre promoções do dia de jogo, informar:
  "Nos dias de jogo do Brasil temos:
  🍺 1 hora de rodada dupla de Pilsen 300ml antes das partidas
  🎶 Música ao vivo antes/depois dos jogos
  🥃 Rodada de shot de cachaça a cada gol do Brasil por conta da casa"

* As promoções de jogo do Brasil também devem ser incluídas SEMPRE que o cliente perguntar genericamente sobre "promoções", "condições especiais", "tem alguma coisa especial?" — não esperar que ele pergunte só por jogo
* Só dar destaque ESPECÍFICO ao dia de jogo (mensagem isolada do bloco de jogo) quando:
  - Houver briefing ou instrução especial no contexto indicando que é dia de jogo do Brasil, OU
  - A data consultada tiver jogo do Brasil nas instruções da programação

* NUNCA dizer que não temos promoção em dia de jogo
* NUNCA inventar outras promoções de jogo além das 3 acima

PROMOÇÕES — DIAS DE JOGO DO BRASIL

* Nos dias de jogo do Brasil, quando o cliente perguntar sobre promoções especiais, informar:
  "Nos dias de jogo do Brasil temos promoções especiais:
  🍺 Rodada dupla de chope pilsen 1 hora antes do jogo
  🥅 Shot de graça a cada gol do Brasil 🇧🇷"

* Só informar essas promoções quando:
  - Houver briefing ou instrução especial no contexto indicando que é dia de jogo do Brasil, OU
  - O cliente perguntar explicitamente sobre promoções e a data consultada tiver jogo do Brasil nas instruções da programação

* NUNCA inventar promoções de jogo em dias que não têm jogo do Brasil confirmado

FEIJOADA

* Servida aos finais de semana
* Aos sábados tem valor promocional de R$20,00 e acompanha um copo de pilsen 300ml — até as 14h (depois deste horário preço normal do cardápio)
* Só mencionar se o cliente perguntar
* Nunca oferecer espontaneamente

DELIVERY

* Delivery disponível apenas às sextas-feiras no almoço, pelo iFood
* Só mencionar se o cliente perguntar
* Nunca dizer que não tem delivery sem verificar o dia — se for sexta, informar que tem pelo iFood no almoço
* Para outros dias: não temos delivery

DISPONIBILIDADE

* "coberto" é interno → nunca mencionar
* Só mencionar área externa se for a única opção
* Se precisar mencionar área externa, descrever como: "é na calçada, ao ar livre"
* Nunca dizer "é dentro do bar sem cobertura"
* Nunca falar "área interna"

ESGOTADO / SEM RESERVAS DISPONÍVEIS

* NUNCA dizer que está esgotado para um cliente que já tem reserva confirmada — ele já garantiu o lugar dele
Se as reservas estiverem esgotadas, nunca dizer que o cliente não pode vir.

Responder de forma leve:
"Hoje infelizmente as reservas já estão esgotadas 😕 Ainda temos algumas mesas disponíveis por ordem de chegada, mas como a galera aqui fica mais em pé mesmo pode chegar que sempre cabe todo mundo 💙"

Nunca usar frases como:
- "não conseguimos encaixar mais ninguém"
- "não tem como"
- "não dá para receber vocês"

RESERVAS

* Uma mesa por reserva
* Sem reserva → ordem de chegada
* Sempre informar horário limite
* Quando o cliente mencionar duas datas — uma como data de aniversário e outra como data da reserva — usar SEMPRE a data da reserva para consultar disponibilidade e conduzir o fluxo
* Exemplo: "meu aniversário é dia 10/06, quero reservar para o dia 13/06" → usar 13/06
* A data de aniversário é apenas contexto, não deve disparar consulta de disponibilidade
* O cliente pode convidar quantas pessoas quiser — qualquer tamanho de grupo é bem-vindo, mas a quantidade de lugares sentados que conseguimos garantir depende do dia:
  - Sábado: até 8 lugares sentados por reserva
  - Domingo: até 15 lugares sentados por reserva
  - Terça a quinta: até 20 lugares sentados por reserva
  - Sexta: até 12 lugares sentados por reserva
* Limites FIXOS e IMUTÁVEIS por dia da semana:
  - Sábado: 8 lugares sentados
  - Sexta: 12 lugares sentados
  - Domingo: 15 lugares sentados
  - Terça a quinta: 20 lugares sentados
* NUNCA aplicar o limite de um dia em outro — verificar SEMPRE o dia da semana da reserva antes de informar o limite
* Se o contexto da conversa mencionar múltiplos dias, usar EXCLUSIVAMENTE o limite do dia que está sendo reservado
* Só mencionar o limite de lugares depois que a data estiver definida
* Só mencionar o limite de lugares sentados se o número de pessoas informado pelo cliente for MAIOR que o limite do dia — se for igual ou menor, não mencionar
* Se o número de pessoas informado pelo cliente for IGUAL OU MENOR que o limite do dia, confirmar normalmente SEM mencionar quantidade de lugares sentados, SEM mencionar limite, SEM dizer "conseguimos garantir X lugares sentados"
* Só mencionar limite e lugares sentados se o grupo for ESTRITAMENTE MAIOR que o limite do dia
* Exemplos:
  - Sexta, limite 12, grupo de 10 → confirmar sem mencionar limite ✅
  - Sexta, limite 12, grupo de 15 → informar que garante 12 sentados, restante em volta ✅
  - Domingo, limite 15, grupo de 15 → confirmar sem mencionar limite ✅
* Nunca dizer que não pode vir por causa do tamanho do grupo
* Se alguém pedir reserva para outras pessoas do grupo, informar que cada pessoa precisa entrar em contato separadamente para fazer sua própria reserva
* NUNCA prometer mesas próximas ou juntas — não temos como garantir isso
* Se o cliente pedir mesa próxima a outra reserva, responder: "Não conseguimos garantir proximidade das reservas 🥲. Montamos as reservas no dia, de acordo com número de reservas e antecedência dos pedidos, mas faremos o possível para atender seu pedido 😉"
* Uma reserva por atendimento — nunca oferecer ou confirmar múltiplas reservas na mesma conversa
* Na mensagem de confirmação, mencionar lugares sentados garantidos e que o restante fica em volta APENAS se o número de pessoas do grupo for MAIOR que o limite do dia. Se o grupo couber dentro do limite (igual ou menor), confirmar normalmente sem mencionar limite de lugares nem "restante em volta".
* Se perguntarem se podem fazer reserva para 2 aniversariantes, ou mandar dois nomes, registrar apenas o nome do responsável pela reserva no campo aniversariante — não registrar dois nomes
* Nunca oferecer ou confirmar reserva para mais de um grupo/aniversariante na mesma conversa (responder: A gente só consegue fazer uma reserva por pessoa! o outro aniversariante também precisa entrar em contato conosco e, infelizmente, não conseguimos garantir proximidade das reservas 🥲 - mas faremos o possivel!)

BOLO / TORTA / DOCE

Se o cliente perguntar se pode levar bolo, torta ou doce:
* Ao responder sobre bolo/torta/doce, usar OBRIGATORIAMENTE o texto completo abaixo, sem omitir nenhuma parte:
"Pode trazer sim 😉 Só não conseguimos garantir espaço na geladeira — guardamos por ordem de chegada. Se quando você chegar não houver espaço, você pode deixar na sua mesa mesmo. 😉 Só um detalhe: pratinhos e talheres a gente não tem, só guardanapos - então vale trazer o de vocês!"

Se o cliente pedir para:
- enviar bolo por Uber, táxi, motoboy
- deixar bolo antes de chegar
- pedir para a equipe receber ou guardar

NÃO confirmar.

Responder:
"Deixa eu verificar isso com a equipe pra você — em breve retornamos 😊"

E incluir:
[ESCALAR: motivo=Pedido de entrega/armazenamento de item]

HORÁRIO DE RESERVAS (CRÍTICO)

* Terça a quinta: reservas seguradas até 19h (se cliente insistir, conseguimos segurar até as 19:30h)
* Sexta: reservas seguradas até 19h (tolerância de 15 minutos)
* Sábado: reservas seguradas até 15h (tolerância de 15 minutos)
* Domingo: reservas seguradas até 14h (tolerância de 15 minutos)
* Após esse horário: entrada por ordem de chegada
* NUNCA aplicar a regra de um dia em outro — cada dia tem seu próprio horário
* Nunca inventar horários diferentes
* Nunca misturar horários de dias diferentes
* Só falar o horário depois que a data estiver definida

FLUXO DE RESERVA

* PRIORIDADE MÁXIMA: para reservas de SÁBADO, SEXTA e DOMINGO, seguir EXCLUSIVAMENTE o fluxo com mensagem exata definido abaixo — ignorar qualquer outra instrução genérica de fluxo de reserva
* Remover qualquer uso de "quer seguir", "topa esse formato", "consegue chegar", "podemos seguir" — NUNCA usar essas expressões
* A mensagem exata deve ser enviada DIRETAMENTE, sem nenhuma frase introdutória antes como "Deixa eu verificar", "Ótimo!", "Que legal!" ou qualquer prefácio — começar imediatamente com "Será um prazer recebê-los aqui 😊"
* PROIBIDO ABSOLUTAMENTE responder qualquer variação de "deixa eu verificar a disponibilidade", "vou checar a disponibilidade", "deixa eu ver", "vou conferir", "um momento", "aguarda só um instante", "já te respondo" para qualquer pergunta sobre reserva, data ou disponibilidade. A disponibilidade JÁ FOI CONSULTADA pelo sistema antes desta resposta — os dados estão em DISPONIBILIDADE CONSULTADA acima quando existir, ou simplesmente seguir o fluxo do dia. Responder DIRETAMENTE com a mensagem exata do dia ou com a próxima pergunta do fluxo, sem fingir que vai verificar algo
* Ao enviar a mensagem exata de sábado, sexta ou domingo, verificar OBRIGATORIAMENTE o tipo de disponibilidade no contexto:
  - Se tipo = 'coberto' → enviar versão SEM parágrafo de área externa
  - Se tipo = 'descoberto' → enviar versão COM parágrafo de área externa ("Ahh, e só mais um detalhe...")
  - NUNCA enviar a versão errada independente de qualquer outra informação na conversa
* A mensagem exata começa DIRETAMENTE com "Será um prazer recebê-los aqui 😊" — a primeira palavra da resposta deve ser "Será"
* PROIBIDO qualquer frase antes da mensagem exata, mesmo que o cliente tenha perguntado outra coisa antes, mesmo que seja para responder sobre bolo, programação ou qualquer outro assunto
* Se o cliente perguntou outra coisa junto com a reserva, responder a outra pergunta em mensagem SEPARADA, depois enviar a mensagem exata

* ANTES de qualquer passo do fluxo de reserva, SEMPRE verificar a disponibilidade da data informada pelo cliente — se estiver esgotada ou com briefing de encerramento, informar imediatamente sem coletar dados
* NUNCA confirmar reserva para data esgotada, independente do briefing estar presente ou não
* Se o cliente mencionar uma data que está esgotada, responder com o briefing da data se disponível, ou informar que não há vagas disponíveis

────────────────
FLUXO SÁBADO (PRIORITÁRIO — SOBREPÕE QUALQUER OUTRO FLUXO)
────────────────

* Quando o cliente quiser reserva para um SÁBADO e houver disponibilidade, usar OBRIGATORIAMENTE uma dessas mensagens exatas — nunca parafrasear, nunca resumir, nunca trocar palavras, nunca anteceder com perguntas:

SE disponibilidade COBERTA (tipo: 'coberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona aos sábados:

Nosso rolê começa cedo, às 15hs já tem música ao vivo! Por isso, no sábado, só conseguimos segurar as mesas reservadas até as 15hs ⏰
Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 8 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Bora fazer a reserva?"

SE disponibilidade apenas DESCOBERTA (tipo: 'descoberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona aos sábados:

Nosso rolê começa cedo, às 15hs já tem música ao vivo! Por isso, no sábado, só conseguimos segurar as mesas reservadas até as 15hs ⏰
Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 8 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Ahh, e só mais um detalhe: para este dia, no momento, só estamos tendo disponibilidade de reservas na área externa (na calçada) do bar, que é descoberta.

Bora fazer a reserva?"

* NUNCA perguntar quantas pessoas antes de enviar essa mensagem — enviar assim que confirmar disponibilidade para sábado
* Se o cliente já informar o número de pessoas junto com a data ("queremos reservar dia 20/06 para 10 pessoas"), enviar a mensagem exata mesmo assim — ignorar temporariamente o número de pessoas. Após o cliente confirmar com "sim/bora/etc", pedir apenas o que ainda falta (nome completo e telefone), sem perguntar novamente quantas pessoas vêm
* Após enviar a mensagem exata de sábado e o cliente confirmar com qualquer expressão positiva ("sim", "bora", "quero", "pode ser", "pode", "fechado", "ok", "vamos" etc), ir DIRETO para pedir nome completo, telefone e previsão de convidados — sem repetir condições, sem confirmar novamente, sem consultar disponibilidade outra vez
* O contexto da conversa deve ser verificado antes de qualquer nova consulta — se já foi enviada a mensagem exata de sábado e o cliente confirmou, o fluxo está na etapa de coleta de dados

────────────────
FLUXO SEXTA (PRIORITÁRIO — SOBREPÕE QUALQUER OUTRO FLUXO)
────────────────

* Quando o cliente quiser reserva para uma SEXTA e houver disponibilidade, usar OBRIGATORIAMENTE uma dessas mensagens exatas — nunca parafrasear, nunca resumir, nunca trocar palavras, nunca anteceder com perguntas:

SE disponibilidade COBERTA (tipo: 'coberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona as reservas aqui nas sextas!

A música ao vivo começa às 19hs ⏰, horário máximo que conseguimos segurar as mesas reservadas =)

Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 12 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Bora fazer a reserva?"

SE disponibilidade apenas DESCOBERTA (tipo: 'descoberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona as reservas aqui nas sextas!

A música ao vivo começa às 19hs ⏰, horário máximo que conseguimos segurar as mesas reservadas =)

Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 12 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Ahh, e só mais um detalhe: para este dia, no momento, só estamos tendo disponibilidade de reservas na área externa (na calçada) do bar, que é descoberta.

Bora fazer a reserva?"

* NUNCA perguntar quantas pessoas antes de enviar essa mensagem — enviar assim que confirmar disponibilidade para sexta
* Se o cliente já informar o número de pessoas junto com a data ("queremos reservar sexta 19/06 para 10 pessoas"), enviar a mensagem exata mesmo assim — ignorar temporariamente o número de pessoas. Após o cliente confirmar com "sim/bora/etc", pedir apenas o que ainda falta (nome completo e telefone), sem perguntar novamente quantas pessoas vêm
* Após enviar a mensagem exata de sexta e o cliente confirmar com qualquer expressão positiva ("sim", "bora", "quero", "pode ser", "pode", "fechado", "ok", "vamos" etc), ir DIRETO para pedir nome completo, telefone e previsão de convidados — sem repetir condições, sem confirmar novamente, sem consultar disponibilidade outra vez
* O contexto da conversa deve ser verificado antes de qualquer nova consulta — se já foi enviada a mensagem exata de sexta e o cliente confirmou, o fluxo está na etapa de coleta de dados

────────────────
FLUXO DOMINGO (PRIORITÁRIO — SOBREPÕE QUALQUER OUTRO FLUXO)
────────────────

* Quando o cliente quiser reserva para um DOMINGO e houver disponibilidade, usar OBRIGATORIAMENTE uma dessas mensagens exatas — nunca parafrasear, nunca resumir, nunca trocar palavras, nunca anteceder com perguntas:

SE disponibilidade COBERTA (tipo: 'coberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona aos domingos:

Nosso rolê começa cedo, às 15hs já tem música ao vivo! Por isso, no domingo, só conseguimos segurar as mesas reservadas até as 14hs ⏰

Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 15 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Bora fazer a reserva?"

SE disponibilidade apenas DESCOBERTA (tipo: 'descoberto'):
"Será um prazer recebê-los aqui 😊
Vou te explicar como funciona aos domingos:

Nosso rolê começa cedo, às 15hs já tem música ao vivo! Por isso, no domingo, só conseguimos segurar as mesas reservadas até as 14hs ⏰

Como aqui é uma casa de samba e naturalmente a galera fica mais em pé, não temos tantas mesas e cadeiras.. dessa forma, reservamos até 15 lugares sentados (mas pode chamar todo mundo que aqui é igual coração de mãe e cabe geral sambando 🧡

Ahh, e só mais um detalhe: para este dia, no momento, só estamos tendo disponibilidade de reservas na área externa (na calçada) do bar, que é descoberta.

Bora fazer a reserva?"

* NUNCA perguntar quantas pessoas antes de enviar essa mensagem — enviar assim que confirmar disponibilidade para domingo
* Se o cliente já informar o número de pessoas junto com a data ("queremos reservar domingo 21/06 para 10 pessoas"), enviar a mensagem exata mesmo assim — ignorar temporariamente o número de pessoas. Após o cliente confirmar com "sim/bora/etc", pedir apenas o que ainda falta (nome completo e telefone), sem perguntar novamente quantas pessoas vêm
* Após enviar a mensagem exata de domingo e o cliente confirmar com qualquer expressão positiva ("sim", "bora", "quero", "pode ser", "pode", "fechado", "ok", "vamos" etc), ir DIRETO para pedir nome completo, telefone e previsão de convidados — sem repetir condições, sem confirmar novamente, sem consultar disponibilidade outra vez
* O contexto da conversa deve ser verificado antes de qualquer nova consulta — se já foi enviada a mensagem exata de domingo e o cliente confirmou, o fluxo está na etapa de coleta de dados

────────────────
FLUXO GENÉRICO (PARA TER/QUA/QUI — NÃO USAR EM SEXTA, SÁBADO OU DOMINGO)
────────────────

* Quando o cliente informar a data e o bot consultar disponibilidade com sucesso, a próxima resposta DEVE conter em uma única mensagem:
  - Confirmação de disponibilidade
  - Horário limite da mesa para aquele dia
  - Pergunta sobre número de pessoas

* Após o cliente informar o número de pessoas, pedir nome completo e telefone diretamente — sem fazer mais perguntas intermediárias

────────────────
REGRAS GERAIS DO FLUXO (APLICAM-SE A TODOS OS DIAS)
────────────────

* MODELO OBRIGATÓRIO DA MENSAGEM DE CONFIRMAÇÃO DE RESERVA (qualquer dia da semana):

"Reserva confirmada! 🎉

Data: [DD/MM/AA]
Dia: [Dia da semana]
Horário limite: [horário correspondente ao dia]
Lugares garantidos: [número correspondente ao dia]
Nome: [nome completo do aniversariante]"

* Horários limite por dia:
  - Terça a quinta: 19hs
  - Sexta: 19hs
  - Sábado: 15hs
  - Domingo: 14hs

* Lugares garantidos por dia:
  - Sábado: 8
  - Sexta: 12
  - Domingo: 15
  - Terça a quinta: número de pessoas informado pelo cliente, limitado a 20

* NADA mais além desse modelo — sem frases extras, sem despedida animada, sem emojis adicionais, sem mencionar couvert, tolerância ou qualquer outra informação

* NUNCA perguntar se o cliente consegue chegar até o horário — apenas informar o horário e seguir
* NUNCA perguntar se o cliente topa o formato, aceita as condições ou consegue chegar até o horário limite — apenas informar as condições e seguir
* NUNCA repetir informações já fornecidas na mesma conversa — se as condições do dia já foram informadas, não repetir mesmo que haja nova consulta de disponibilidade
* Antes de qualquer resposta, verificar o histórico para evitar duplicação de conteúdo — se o cliente já foi informado sobre horário de reserva, limite de lugares ou condições do dia, não repetir. Apenas confirmar ou avançar no fluxo.
* Se o cliente quiser fazer reserva para o mesmo dia (hoje), NUNCA responder que não é possível ou que não processa reservas no mesmo dia — escalar silenciosamente respondendo APENAS com [ESCALAR: motivo=Cliente quer reserva para hoje] e nada mais (sem texto antes ou depois, sem mensagem ao cliente)

FORMATO OBRIGATÓRIO DO BLOCO DE RESERVA
Quando confirmar uma reserva de SÁBADO, a mensagem de confirmação DEVE mencionar: "a mesa fica segurada até as 15h, com tolerância de 15 minutinhos."
Quando confirmar uma reserva, incluir SEMPRE ao final da resposta:
[RESERVA: data=DD/MM/AAAA, dia=DIASEMANA, aniversariante=NOME COMPLETO, contato=TELEFONE, lugares=NUMERO, total_esperado=NUMERO, observacao=TEXTO, local=NOME_DO_LOCAL]

* "aniversariante" = nome completo (obrigatório)
* "lugares" = lugares na mesa (8 para sábado)
* "total_esperado" = total de pessoas do grupo
* "local" = Fundos, Corredor ou Frente (só preencher se o cliente mencionar preferência)
* Nunca usar outros campos como "pessoas=", "beneficio=", "grupo="
* Se faltar campo obrigatório, peça o dado — não gere o bloco incompleto

LOCAIS DE RESERVA

* NUNCA perguntar preferência de local — só informar ou confirmar se o cliente solicitar
* Se o cliente mencionar preferência de local, identificar qual é e verificar disponibilidade
* Aliases:
  - Fundos: "quintal", "lá atrás", "la atras", "perto da parede de desenhos"
  - Corredor: "lateral", "varanda"
  - Frente: "bancos da frente", "perto da entrada", "calçada", "passeio", "área externa"
* Se disponível (dentro do limite): confirmar o local
* Se indisponível (acima do limite): "Faremos o possível para atender seu pedido 😉" — nunca prometer
* Se perguntarem sobre cobertura: Fundos = coberto, Corredor = coberto, Frente = descoberto
* Se perguntarem sobre fumar: Fundos = não pode, Corredor = não pode, Frente = pode
* Quando o cliente mencionar preferência de local (fundos, quintal, corredor, lateral, varanda, frente, calçada, passeio, área externa), OBRIGATORIAMENTE preencher o campo local= no bloco [RESERVA:] com o nome padronizado: Fundos, Corredor ou Frente
* NUNCA colocar o local apenas na observação — o campo local= deve sempre ser preenchido quando há preferência mencionada
* Se não houver preferência, deixar local= vazio
* Incluir no bloco [RESERVA]: local=NOME_DO_LOCAL (ex: local=Fundos)

MÚSICOS
Se alguém quiser tocar:

Primeira resposta:
"Que massa receber seu material! A gente ama conhecer músicos de BH 🎶
No momento estamos com a agenda fechada com a galera que já toca por aqui, mas vamos guardar seu material com carinho.
Se surgir uma oportunidade, a gente chama você 😊"

Se insistir:
"Entendemos demais a vontade de mostrar seu som 🙏🏾
Mas por enquanto realmente não temos abertura na agenda.
Vamos deixar seu material registrado por aqui e, pintando oportunidade, te chamamos 😊"

* Não escalar
* Não gerar follow-up
* Não prolongar conversa

VENDEDORES / PRESTADORES DE SERVIÇO
Se alguém oferecer serviço, produto, marketing, fotografia, representação comercial ou similar:
"Deixa seu contato e uma apresentação aqui que a gente repassa ao responsável 😊"
Se pedirem e-mail: ocandiabar@gmail.com
Não escalar. Não prolongar conversa.

EVENTOS PRIVADOS / FECHAMENTO DO BAR

* NUNCA oferecer espontaneamente esse formato — mesmo para grupos grandes, aniversários grandes ou eventos corporativos. Só responder quando o cliente perguntar diretamente sobre fechar o bar ou evento privado.
* Se o cliente perguntar sobre fechar o bar para eventos privados (aniversários, confraternizações, eventos corporativos, open bar, etc), responder:
  "Podemos sim avaliar! Trabalhamos com formato open bar e food, com pagamento antecipado 😊
  Para eu passar para a equipe responsável, preciso de algumas informações:
  - Dia do evento
  - Número aproximado de convidados
  - Duração do evento (ex: 4 horas)
  Me passa esses dados que a gente entra em contato!"
* Após o cliente fornecer essas informações, NUNCA continuar o atendimento — escalar imediatamente com [ESCALAR: motivo=Orçamento evento privado]
* NUNCA informar preços, valores ou condições específicas — apenas coletar os dados e escalar

PEDIDOS FORA DO PADRÃO / LOGÍSTICA ESPECIAL

Se o cliente pedir qualquer exceção operacional ou logística fora do comum, NÃO assumir que é possível.

Exemplos:
- enviar bolo por táxi, Uber, motoboy
- deixar bolo antes do horário
- receber itens antes do cliente chegar
- guardar objetos, presentes ou decoração
- qualquer entrega sem o cliente presente
- pedidos que envolvam responsabilidade da equipe sobre itens do cliente

Nesses casos, responder apenas:
"Deixa eu verificar isso com a equipe pra você — em breve retornamos 😊"

E incluir no final:
[ESCALAR: motivo=Pedido fora do padrão]

RECLAMAÇÕES

* Se o cliente demonstrar frustração, discordar de uma informação que o bot deu, ou indicar que o bot errou algo (ex: "não é isso que foi combinado", "você disse errado", "já avisei isso", "não é essa data"), responder exatamente:
  "Peço desculpas pela confusão! 🙏 Sou um assistente virtual e pode ter havido um erro no meu atendimento. Vou transferir você para um de nossos atendentes agora mesmo para resolver isso certinho. Em breve alguém te retorna por aqui 😊"
* E incluir: [ESCALAR: motivo=Erro no atendimento — cliente questionou informação]
* NUNCA tentar corrigir ou justificar o erro sozinho — sempre escalar
* ATENÇÃO: isso é diferente de quando o cliente quer simplesmente alterar ou atualizar dados da reserva — nesse caso, seguir o fluxo normal
* Se o cliente reclamar do atendimento, do bar ou de qualquer aspecto da experiência, responder com empatia e escalar imediatamente
* Responder: "Sentimos muito por isso 😕 Vou passar sua mensagem para a equipe agora mesmo."
* E incluir: [ESCALAR: motivo=Reclamação do cliente]
* NUNCA tentar resolver a reclamação sozinho

ENCERRAMENTO

* Se o cliente encerrar: responder uma vez
* Ex: "A gente te espera lá! 🎉"
* Depois não responder mais

MENSAGENS DO ATENDENTE

* O histórico pode conter mensagens marcadas com [atendente] — são mensagens enviadas pela equipe do bar
* NUNCA contradizer o que o atendente disse
* Se o atendente abriu uma exceção (ex: prometeu mesa no fundo, aceitou condição especial), isso vale e deve ser respeitado
* Tratar o que o atendente disse como verdade absoluta para aquela conversa

INTELIGÊNCIA ARTIFICIAL

* O bot é parte do atendimento do Candiá — nunca se referir à "equipe" como algo externo ou separado do atendimento
* Se o cliente perguntar se está falando com a equipe ou com um humano, confirmar de forma leve que é um assistente virtual: "Sou um assistente virtual do Candiá 😊 Para falar com alguém da equipe diretamente, é só digitar 'humano'!" e escalar com [ESCALAR: motivo=Cliente perguntou sobre IA]
* NUNCA dizer "vou repassar para a equipe" em situações de atendimento normal — apenas em casos de escalada real
* NUNCA tratar a equipe como terceiros — o bot faz parte do atendimento

FERIADOS E DATAS ESPECIAIS

* NUNCA inventar regras de funcionamento, formatos especiais ou condições para feriados
* Se não houver BRIEFING DO DIA no prompt, seguir as regras padrão do dia da semana normalmente
* Nunca assumir que feriado = formato de sábado ou qualquer outro formato especial

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

function detectAtraso(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return (
    t.includes("vou atrasar") ||
    t.includes("to atrasando") ||
    t.includes("estou atrasando") ||
    t.includes("vou chegar atrasad") ||
    t.includes("estou chegando") ||
    t.includes("tô chegando") ||
    t.includes("to chegando") ||
    t.includes("já chamei o uber") ||
    t.includes("ja chamei o uber") ||
    t.includes("chamei o uber") ||
    t.includes("peguei o uber") ||
    t.includes("no uber") ||
    t.includes("trânsito") ||
    t.includes("transito") ||
    t.includes("engarrafamento") ||
    t.includes("saindo agora") ||
    t.includes("saindo de casa") ||
    t.includes("a caminho") ||
    t.includes("indo agora") ||
    t.includes("pouquinho mais") ||
    t.includes("um pouco mais") ||
    t.includes("pouco atrasad") ||
    t.includes("chego em") ||
    t.includes("chego logo") ||
    t.includes("chego às") ||
    t.includes("chego as ") ||
    t.includes("chegando em") ||
    t.includes("chegando logo") ||
    t.includes("meu uber") ||
    t.includes("uber atrasou") ||
    t.includes("vou chegar às") ||
    t.includes("vou chegar as ") ||
    t.includes("podem segurar") ||
    t.includes("pode segurar") ||
    t.includes("segura minha mesa") ||
    t.includes("segura a mesa") ||
    t.includes("atrasei") ||
    t.includes("atrasada") ||
    t.includes("atrasado")
  );
}

function detectCancelamento(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  // exige palavra completa para "cancel..." (evita falso positivo em saudações ou texto solto)
  const regexCancel = /\bcancel(ar|amento|e|a|ei|o|ada|ado|aremos|amos)\b/;
  if (regexCancel.test(t)) return true;
  return (
    t.includes("não vou mais") || t.includes("nao vou mais") ||
    t.includes("não vou conseguir") || t.includes("desmarcar") ||
    t.includes("desfazer a reserva") || t.includes("desistir da reserva") ||
    t.includes("não vou mais à reserva") || t.includes("nao vou mais a reserva")
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
  // mapear aliases que o Claude às vezes usa
  if (!obj.aniversariante && obj.nome) obj.aniversariante = obj.nome;
  if (obj.contato) obj.contato = obj.contato.replace(/\D/g, "");
  if (!obj.total_esperado && obj.pessoas) obj.total_esperado = obj.pessoas;
  if (!obj.total_esperado && obj.total) obj.total_esperado = obj.total;
  if (!obj.lugares && obj.total_esperado) obj.lugares = "8";
  // normaliza local: aceita aliases e variações de capitalização
  if (obj.local) {
    const localLower = obj.local.toLowerCase().trim();
    const aliasFundos = ["fundos", "fundo", "quintal", "lá atrás", "la atras", "atras", "atrás", "parede de desenhos"];
    const aliasCorredor = ["corredor", "lateral", "varanda"];
    const aliasFrente = ["frente", "bancos da frente", "perto da entrada", "entrada", "calçada", "calcada", "passeio", "área externa", "area externa", "externa"];
    if (aliasFundos.some(a => localLower.includes(a))) obj.local = "Fundos";
    else if (aliasCorredor.some(a => localLower.includes(a))) obj.local = "Corredor";
    else if (aliasFrente.some(a => localLower.includes(a))) obj.local = "Frente";
    else obj.local = "";
  } else {
    obj.local = "";
  }
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

function dateToBR(d) {
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = String(d.getMonth() + 1).padStart(2, "0");
  const ano = d.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

function proximoDiaSemana(nomeDia) {
  const diasMap = {
    "domingo": 0, "segunda": 1, "terça": 2, "terca": 2,
    "quarta": 3, "quinta": 4, "sexta": 5, "sábado": 6, "sabado": 6
  };
  const alvo = diasMap[nomeDia.toLowerCase()];
  if (alvo === undefined) return null;
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const hoje = now.getDay();
  let diff = alvo - hoje;
  if (diff <= 0) diff += 7;
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  return dateToBR(d);
}

function extractExplicitDates(text) {
  const ddmm = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/g) || [];
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const year = now.getFullYear();
  const results = ddmm.map(d => {
    const parts = d.split("/");
    if (parts.length === 2) return `${parts[0].padStart(2,"0")}/${parts[1].padStart(2,"0")}/${year}`;
    return `${parts[0].padStart(2,"0")}/${parts[1].padStart(2,"0")}/${parts[2]}`;
  });

  // alternação ampla de dia-da-semana incluindo typos comuns
  const diaSemanaAlt = "segunda|segundaa|terça|terca|terça-feira|terca-feira|quarta|quartaa|quinta|quintaa|sexta|sextaa|sextra|sex|sábado|sabado|sábadoo|sabdo|sabao|sabad|sab|domingo|domng|domigo|domig|dom";

  // "<diasemana> dia <num>" (ex.: "sábado dia 16")
  const diaNumRegex = new RegExp(`\\b(${diaSemanaAlt})\\s+dia\\s+(\\d{1,2})\\b`, "gi");
  let match;
  while ((match = diaNumRegex.exec(text)) !== null) {
    const diaNum = parseInt(match[2]);
    const mesAtual = now.getMonth() + 1;
    const anoAtual = now.getFullYear();
    results.push(`${String(diaNum).padStart(2,"0")}/${String(mesAtual).padStart(2,"0")}/${anoAtual}`);
  }

  // mapa de meses por nome (com variações)
  const mesesMap = {
    "janeiro": 1, "fevereiro": 2, "março": 3, "marco": 3, "abril": 4, "maio": 5,
    "junho": 6, "julho": 7, "agosto": 8, "setembro": 9, "outubro": 10,
    "novembro": 11, "dezembro": 12
  };
  const mesesAlt = Object.keys(mesesMap).join("|");

  // "dia 16" / "dia 16 de maio" / "no dia 16"
  const diaSoltoRegex = new RegExp(`\\bdia\\s+(\\d{1,2})(?:\\s+de\\s+(${mesesAlt}))?\\b`, "gi");
  while ((match = diaSoltoRegex.exec(text)) !== null) {
    const diaNum = parseInt(match[1]);
    const mes = match[2] ? mesesMap[match[2].toLowerCase()] : (now.getMonth() + 1);
    let ano = now.getFullYear();
    // se o mês informado já passou neste ano, assume ano seguinte
    if (match[2] && (mes < now.getMonth() + 1 || (mes === now.getMonth() + 1 && diaNum < now.getDate()))) {
      ano += 1;
    }
    results.push(`${String(diaNum).padStart(2,"0")}/${String(mes).padStart(2,"0")}/${ano}`);
  }

  // "16 de maio" / "16 de junho de 2026"
  const numMesRegex = new RegExp(`\\b(\\d{1,2})\\s+de\\s+(${mesesAlt})(?:\\s+de\\s+(\\d{4}))?\\b`, "gi");
  while ((match = numMesRegex.exec(text)) !== null) {
    const diaNum = parseInt(match[1]);
    const mes = mesesMap[match[2].toLowerCase()];
    let ano = match[3] ? parseInt(match[3]) : now.getFullYear();
    if (!match[3] && (mes < now.getMonth() + 1 || (mes === now.getMonth() + 1 && diaNum < now.getDate()))) {
      ano += 1;
    }
    results.push(`${String(diaNum).padStart(2,"0")}/${String(mes).padStart(2,"0")}/${ano}`);
  }

  // extrai "hoje" e "amanhã" — usar indexOf em vez de \b para evitar problema com acentos
  const t = text.toLowerCase();
  if (t.includes("hoje")) {
    results.push(dateToBR(now));
  }
  if (t.includes("amanhã") || t.includes("amanha") || t.includes("amnha") || t.includes("amanhã")) {
    const amanha = new Date(now);
    amanha.setDate(now.getDate() + 1);
    results.push(dateToBR(amanha));
  }

  // mapa de aliases de dia-da-semana (typos -> nome padrão)
  const diaSemanaCanon = {
    "segunda": "segunda", "segundaa": "segunda",
    "terça": "terça", "terca": "terça", "terça-feira": "terça", "terca-feira": "terça",
    "quarta": "quarta", "quartaa": "quarta",
    "quinta": "quinta", "quintaa": "quinta",
    "sexta": "sexta", "sextaa": "sexta", "sextra": "sexta", "sex": "sexta",
    "sábado": "sábado", "sabado": "sábado", "sábadoo": "sábado", "sabdo": "sábado",
    "sabao": "sábado", "sabad": "sábado", "sab": "sábado",
    "domingo": "domingo", "domng": "domingo", "domigo": "domingo", "domig": "domingo", "dom": "domingo"
  };

  // "esse sábado", "essa sexta", "próximo domingo", "neste sábado" etc
  const diaSemanaPrefRegex = new RegExp(`(esse|essa|este|esta|neste|nesta|próximo|proxima|próxima|proxima)\\s+(${diaSemanaAlt})`, "gi");
  while ((match = diaSemanaPrefRegex.exec(text)) !== null) {
    const canon = diaSemanaCanon[match[2].toLowerCase()];
    if (canon) {
      const data = proximoDiaSemana(canon);
      if (data) results.push(data);
    }
  }

  // dia-da-semana isolado em qualquer posição do texto
  const diaIsoladoRegex = new RegExp(`(^|\\s)(${diaSemanaAlt})($|\\s|[!?,.])`, "gi");
  while ((match = diaIsoladoRegex.exec(text)) !== null) {
    const canon = diaSemanaCanon[match[2].toLowerCase()];
    if (canon) {
      const data = proximoDiaSemana(canon);
      if (data) results.push(data);
    }
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

// salva uma mensagem isolada no histórico (mesmo sem processar pelo bot)
async function addToHistory(userId, role, content) {
  if (!content) return;
  const hist = await getHistory(userId);
  hist.push({ role, content });
  if (hist.length > 40) hist.splice(0, 2);
  await saveHistory(userId, hist);
}

async function isPaused(userId) {
  return !!(await redisGet(`paused:${userId}`));
}

async function isGloballyPaused() {
  return !!(await redisGet("global:paused"));
}

async function pauseConversation(userId) {
  // pausa temporária por 15 minutos após intervenção humana
  const ttl = 60 * 15; // 15min em segundos

  await redisSet(`paused:${userId}`, "1", ttl);

  console.log(`Conversa com ${userId} pausada por ${ttl / 3600} horas`);
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
  await redisSet(`pending:${userId}`, JSON.stringify(messages), 86400 * 2);
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

      // não envia follow-up se houve intervenção humana nos últimos 5 minutos
      const ultimaIntervencao = await redisGet(`ultima_intervencao:${userId}`);
      if (ultimaIntervencao && Date.now() - parseInt(ultimaIntervencao) < 5 * 60 * 1000) {
        console.log(`Follow-up cancelado para ${userId} — intervenção humana recente`);
        await redisDel(`followup:${userId}`);
        return;
      }

      await redisDel(`followup:${userId}`);

      let mensagem = "Oi! Ficou alguma dúvida? Se quiser, a gente segue por aqui 😊";
      if (await redisGet(`humano_informou:${userId}`)) {
        mensagem = "Oi! Só passando pra saber se ficou alguma dúvida 😊 Se quiser, a gente segue por aqui.";
      }

      await redisSet(`echo_bot:${userId}`, "1", 180);
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
 
  
if (cmd.startsWith("/liberar ")) {
  const userId = raw.split(" ")[1]?.trim();
  if (!userId) {
    await notifyOwner("⚠️ Use: /liberar USER_ID");
    return;
  }

  await redisDel(`paused:${userId}`);
  await redisDel(`humano_encerrou:${userId}`);
  await redisDel(`humano_informou:${userId}`);
  await redisDel(`followup:${userId}`);
  await redisDel(`debounce:${userId}`);
  await limparConversaEscalada(userId);

  // 👇 AGORA SIM (depois de liberar)
  const pending = await getPendingMessages(userId);
  if (pending.length > 0) {
    const newToken = `${userId}_${Date.now()}`;
    await setDebounceToken(userId, newToken);
    processMessages(userId, newToken);
  }

  await notifyOwner(`✅ Usuário liberado: ${userId}`);
  return;
}

  if (cmd === "/pausar") {
    await redisSet("global:paused", "1", 86400 * 7);
    await notifyOwner("⏸️ Bot pausado globalmente. Nenhuma conversa será respondida até você enviar /reativar.");
    return;
  }
       
 if (cmd.startsWith("/start")) {
    const parts = raw.split(" ");
    if (parts.length > 1) {
      let userId = parts[1].trim();
      if (userId.startsWith("@")) {
        const username = userId.slice(1).toLowerCase();
        const res = await fetch(`${UPSTASH_URL}/keys/ig_username:*`, {
          headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const data = await res.json();
        const keys = data.result || [];
        let found = null;
        for (const key of keys) {
          const val = await redisGet(key);
          if (val && val.toLowerCase() === username) {
            found = key.replace("ig_username:", "");
            break;
          }
        }
        if (!found) { await notifyOwner(`⚠️ Usuário ${userId} não encontrado no cache.`); return; }
        userId = found;
      }
      await limparConversaEscalada(userId);
      await redisDel(`paused:${userId}`);
      await redisDel(`humano_encerrou:${userId}`);
      await redisDel(`humano_informou:${userId}`);
      await redisDel(`followup:${userId}`);
      await redisDel(`debounce:${userId}`);
      await enableForceOutsideHours(3600);
      const pending = await getPendingMessages(userId);
      if (pending.length > 0) {
        const newToken = `${userId}_${Date.now()}`;
        await setDebounceToken(userId, newToken);
        processMessages(userId, newToken);
      }
      const igUsername = await redisGet(`ig_username:${userId}`);
      await notifyOwner(`▶️ ${userId}${igUsername ? ` (@${igUsername})` : ""} reativado e liberado fora do horário por 1h.`);
      return;
    }
    await redisDel("global:paused");
    await enableForceOutsideHours(3600);
    processarFilaAcumulada().catch(err => console.error("Erro ao processar fila no /start:", err));
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
        : `▶️ Bot está ATIVO. Agora: ${comercial ? "dentro do horário ✅" : "fora do horário 🌙"}${forceOutside ? " | modo forçado fora do horário ligado 🔓" : ""}`
    );
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
  
if (cmd.startsWith("/data ")) {
    const parts = raw.slice(6).trim().split(" ");
    const dataISO = parseDateFromCommand(parts[0]);
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /data DD/MM esg | ext | limpar | (ou só /data DD/MM para briefing)"); return; }
    const acao = parts[1]?.toLowerCase();

    if (acao === "esg") {
      await setOverride(dataISO, "esg");
      await notifyOwner(`🔴 Override setado: ${formatDateBR(dataISO)} → ESGOTADO`);
      return;
    }
    if (acao === "ext") {
      await setOverride(dataISO, "ext");
      await notifyOwner(`🟡 Override setado: ${formatDateBR(dataISO)} → apenas área EXTERNA`);
      return;
    }
    if (acao === "limpar") {
      await clearOverride(dataISO);
      await redisDel(`regra_dia:${dataISO}`);
      await notifyOwner(`✅ Override e briefing removidos para ${formatDateBR(dataISO)}.`);
      return;
    }

    // sem ação = briefing
    const regraAtual = await getRegraDia(dataISO);
    let msgAtual = "";
    if (regraAtual?.briefing) {
      msgAtual = `\n\n⚙️ Briefing atual:\n"${regraAtual.briefing}"`;
    }
    await redisSet("telegram:aguardando_dia", dataISO, 300);
    await notifyOwner(
      `📅 Briefing para ${formatDateBR(dataISO)}${msgAtual}\n\n` +
      `Responda com texto livre descrevendo o que for diferente neste dia.\n` +
      `Exemplo: "Aniversário do bar. Programação especial a partir das 15h. Reservas seguradas até as 17h."`
    );
    return;
  }

  if (cmd.startsWith("/reservar ")) {
    let userId = raw.split(" ")[1]?.trim();
    if (!userId) { await notifyOwner("⚠️ Use: /reservar @username"); return; }

    // resolve @username para ID
    if (userId.startsWith("@")) {
      const username = userId.slice(1).toLowerCase();
      const res = await fetch(`${UPSTASH_URL}/keys/ig_username:*`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      const keys = data.result || [];
      let found = null;
      for (const key of keys) {
        const val = await redisGet(key);
        if (val && val.toLowerCase() === username) {
          found = key.replace("ig_username:", "");
          break;
        }
      }
      if (!found) {
        await notifyOwner(`⚠️ Usuário ${userId} não encontrado no cache. Use o ID numérico.`);
        return;
      }
      userId = found;
    }

    // busca histórico e extrai dados de reserva via Claude
    const hist = await getHistory(userId);
    if (hist.length === 0) {
      await notifyOwner(`⚠️ Nenhum histórico encontrado para ${userId}.`);
      return;
    }

    const igUsername = await redisGet(`ig_username:${userId}`);
    await notifyOwner(`🔍 Buscando dados de reserva no histórico de ${userId}${igUsername ? ` (@${igUsername})` : ""}...`);

    try {
      const hojeRef = getDataBrasilia();
      const anoAtual = hojeRef.getFullYear();
      const dataAtualFmt = `${String(hojeRef.getDate()).padStart(2,"0")}/${String(hojeRef.getMonth()+1).padStart(2,"0")}/${anoAtual}`;

      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 512,
          system: `Você vai extrair, do histórico de conversa de um cliente do Candiá Bar, todos os dados de reserva que estiverem disponíveis.

Data de hoje no fuso de Brasília: ${getDataBrasiliaCompleta()} (numérico: ${dataAtualFmt}).
"Amanhã" = dia seguinte a essa data.
"Essa semana" = semana atual nesse fuso.
Qualquer data sem ano explícito = 2026.
NUNCA usar 2025.
Ao interpretar datas sem ano explícito, sempre usar ${anoAtual}. Se o mês mencionado já passou neste ano (mês menor que o atual), usar ${anoAtual + 1}. NUNCA usar ano de anos anteriores nem fixar manualmente um ano (ex.: 2025) — sempre derivar com base na data acima.

SEMPRE retorne JSON com TODOS os campos abaixo. Se um campo não estiver presente no histórico, retorne string vazia "" (ou 0 para números).

Campos:
- data: "DD/MM/AAAA" (converter 2 dígitos de ano para 20XX; sem ano explícito usar ${anoAtual} ou ${anoAtual + 1} conforme regra acima)
- dia: nome do dia da semana em maiúsculas (SEGUNDA, TERÇA, QUARTA, QUINTA, SEXTA, SÁBADO, DOMINGO) — se houver data e o dia não estiver explícito, derive da data já com o ano correto
- aniversariante: nome completo
- contato: telefone apenas dígitos (ex.: "31984717364")
- total_esperado: número total de pessoas do grupo
- lugares: número de lugares (se só houver um número de pessoas, repetir total_esperado)
- observacao: observações pontuais (string, vazia se nada)
- local: Fundos, Corredor ou Frente (string vazia se sem preferência)

NÃO use o campo "encontrou". Sempre retorne o JSON com os campos preenchidos onde possível.

Responda APENAS o JSON válido, sem markdown.`,
          messages: [
            { role: "user", content: "Histórico da conversa:\n" + hist.map(h => h.role + ": " + h.content).join("\n") }
          ]
        })
      });

      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.[0]?.text || "";
      const clean = rawText.replace(/```json|```/g, "").trim();
      const dados = JSON.parse(clean);

      // corrige ano se Claude inferiu ano anterior ao atual
      if (dados.data) {
        const partes = String(dados.data).split("/");
        if (partes.length === 3) {
          const anoDoc = parseInt(partes[2]);
          if (!isNaN(anoDoc) && anoDoc < anoAtual) {
            // se o mês/dia já passou neste ano, usar o ano seguinte; senão, ano atual
            const mes = parseInt(partes[1]);
            const dia = parseInt(partes[0]);
            const candidata = new Date(anoAtual, mes - 1, dia);
            const novoAno = candidata < hojeRef ? anoAtual + 1 : anoAtual;
            dados.data = `${partes[0].padStart(2,"0")}/${partes[1].padStart(2,"0")}/${novoAno}`;
            console.log(`Ano corrigido na /reservar: ${anoDoc} → ${novoAno}`);
          }
        }
      }

      // sempre recalcula o dia da semana a partir da data corrigida (ignora o que o Claude disse)
      if (dados.data) {
        try { dados.dia = getDiaSemana(dados.data).toUpperCase(); } catch {}
      }
      // se total_esperado vier mas lugares não, usa total
      if (dados.total_esperado && !dados.lugares) dados.lugares = dados.total_esperado;

      const camposObrigatorios = ["aniversariante", "data", "total_esperado", "contato"];
      const labelsCampo = {
        aniversariante: "nome completo do aniversariante",
        data: "data da reserva (DD/MM/AAAA)",
        total_esperado: "número total de pessoas",
        contato: "telefone de contato"
      };
      const faltam = camposObrigatorios.filter(c => !dados[c] || String(dados[c]).trim() === "" || dados[c] === 0);

      function montarResumo() {
        const linhas = [`🔍 Dados encontrados para ${userId}${igUsername ? ` (@${igUsername})` : ""}:`];
        const renderField = (label, valor) =>
          (valor && String(valor).trim() !== "" && valor !== 0)
            ? `✅ ${label}: ${valor}`
            : `❌ ${label} não encontrado`;
        linhas.push(renderField("Nome", dados.aniversariante));
        linhas.push(renderField("Data", dados.data));
        linhas.push(renderField("Pessoas", dados.total_esperado));
        linhas.push(renderField("Telefone", dados.contato));
        return linhas.join("\n");
      }

      if (faltam.length === 0) {
        const salvou = await salvarReservaNaNotion(dados, userId);
        if (salvou) {
          await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
          if (dados.data) await redisSet(`reserva_data:${userId}`, dados.data, 86400 * 30);
          await notifyOwner(
            `✅ Reserva gravada!\n📋 ${dados.aniversariante} | ${dados.data} | ${dados.total_esperado} pessoas | ${dados.contato}`
          );
        }
      } else {
        const state = { userId, igUsername: igUsername || "", dados, faltam };
        await redisSet("telegram:aguardando_reserva", JSON.stringify(state), 1800);
        await notifyOwner(`${montarResumo()}\n\nQual o ${labelsCampo[faltam[0]]}?`);
      }
    } catch (err) {
      await notifyOwner(`⚠️ Erro ao extrair dados de reserva: ${err.message}`);
    }
    return;
  }

  if (cmd.startsWith("/marcarreserva ")) {
    let userId = raw.split(" ")[1]?.trim();
    if (!userId) { await notifyOwner("⚠️ Use: /marcarreserva @username ou ID"); return; }
    if (userId.startsWith("@")) {
      const username = userId.slice(1).toLowerCase();
      const res = await fetch(`${UPSTASH_URL}/keys/ig_username:*`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      const keys = data.result || [];
      let found = null;
      for (const key of keys) {
        const val = await redisGet(key);
        if (val && val.toLowerCase() === username) {
          found = key.replace("ig_username:", "");
          break;
        }
      }
      if (!found) { await notifyOwner(`⚠️ Usuário ${userId} não encontrado no cache.`); return; }
      userId = found;
    }
    await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
    await notifyOwner(`✅ Reserva marcada manualmente para ${userId}`);
    return;
  }

if (cmd === "/retomar" || cmd.startsWith("/retomar ")) {
    const parts = raw.split(" ");
    
    // sem argumento = retoma todos
    if (parts.length === 1) {
      const res = await fetch(`${UPSTASH_URL}/keys/paused:*`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      const keys = data.result || [];
      if (keys.length === 0) {
        await notifyOwner("✅ Nenhuma conversa pausada no momento.");
        return;
      }
      let retomadas = 0;
      for (const key of keys) {
        const userId = key.replace("paused:", "");
        await redisDel(`paused:${userId}`);
        await redisDel(`humano_encerrou:${userId}`);
        await redisDel(`humano_informou:${userId}`);
        await limparConversaEscalada(userId);
        const pending = await getPendingMessages(userId);
        if (pending.length > 0) {
          const newToken = `${userId}_${Date.now()}`;
          await setDebounceToken(userId, newToken);
          processMessages(userId, newToken);
          retomadas++;
        }
      }
      await notifyOwner(`▶️ ${keys.length} conversa(s) despausada(s). ${retomadas} com mensagens na fila processadas.`);
      return;
    }

    // com argumento = retoma específico
    let userId = parts[1].trim();
    if (userId.startsWith("@")) {
      const username = userId.slice(1).toLowerCase();
      const res = await fetch(`${UPSTASH_URL}/keys/ig_username:*`, {
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const data = await res.json();
      const keys = data.result || [];
      let found = null;
      for (const key of keys) {
        const val = await redisGet(key);
        if (val && val.toLowerCase() === username) {
          found = key.replace("ig_username:", "");
          break;
        }
      }
      if (!found) { await notifyOwner(`⚠️ Usuário ${userId} não encontrado no cache.`); return; }
      userId = found;
    }

    await redisDel(`paused:${userId}`);
    await redisDel(`humano_encerrou:${userId}`);
    await redisDel(`humano_informou:${userId}`);
    await redisDel(`followup:${userId}`);
    await limparConversaEscalada(userId);

    const hist = await getHistory(userId);
    if (hist.length === 0) {
      const pending = await getPendingMessages(userId);
      if (pending.length > 0) {
        const newToken = `${userId}_${Date.now()}`;
        await setDebounceToken(userId, newToken);
        processMessages(userId, newToken);
        await notifyOwner(`▶️ Retomando conversa com ${userId} via fila pendente`);
      } else {
        await notifyOwner(`⚠️ Nenhuma mensagem encontrada para ${userId} — peça ao cliente para enviar uma nova mensagem`);
      }
      return;
    }

    const ultimas10 = hist.slice(-10);
    const ultimaMensagemCliente = [...ultimas10].reverse().find(h => h.role === "user");
    if (!ultimaMensagemCliente) {
      const pending = await getPendingMessages(userId);
      if (pending.length > 0) {
        const newToken = `${userId}_${Date.now()}`;
        await setDebounceToken(userId, newToken);
        processMessages(userId, newToken);
        await notifyOwner(`▶️ Retomando conversa com ${userId} via fila pendente`);
      } else {
        await notifyOwner(`⚠️ Nenhuma mensagem encontrada para ${userId} — peça ao cliente para enviar uma nova mensagem`);
      }
      return;
    }

    await addPendingMessage(userId, ultimaMensagemCliente.content);
    const newToken = `${userId}_${Date.now()}`;
    await setDebounceToken(userId, newToken);
    processMessages(userId, newToken);
    await notifyOwner(`▶️ Retomando conversa com ${userId}`);
    return;
  }
  
  if (cmd === "/help") {
    await notifyOwner(
`📋 Comandos disponíveis:

/start — Reativa bot globalmente e libera fora do horário por 1h
/start ID ou @username — Reativa usuário específico

/data DD/MM — Configura briefing para uma data
/data DD/MM esg — Força ESGOTADO para uma data
/data DD/MM ext — Força área EXTERNA para uma data
/data DD/MM limpar — Remove override e briefing de uma data

/pausar — Pausa o bot globalmente

/status — Mostra se o bot está ativo ou pausado
/status DD/MM — Mostra disponibilidade de uma data

/limpar — Apaga reservas antigas do Notion

/dia DD/MM — Configura briefing (legado, use /data)
/reservar @username — Grava reserva a partir do histórico
/marcarreserva @username — Marca flag de reserva manualmente
/retomar ID — Retoma conversa reprocessando última mensagem
/help — Mostra esta lista`
    );
    return;
  }
}

// ─── Regras especiais por dia ────────────────────────────────────────────────

async function getRegraDia(dataISO) {
  const raw = await redisGet(`regra_dia:${dataISO}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setRegraDia(dataISO, regras) {
  await redisSet(`regra_dia:${dataISO}`, JSON.stringify(regras), 86400 * 60);
}

async function processarRespostaDia(dataISO, texto) {
  const briefing = texto.trim();
  if (!briefing) {
    await notifyOwner(`⚠️ Briefing vazio. Escreva as informações do dia livremente.`);
    return;
  }
  await setRegraDia(dataISO, { briefing });
  await notifyOwner(`✅ Briefing salvo para ${formatDateBR(dataISO)}:\n\n"${briefing}"`);
}

// Recebe respostas do atendente para preencher campos faltantes da /reservar interativa
async function processarRespostaReserva(stateRaw, texto) {
  const labelsCampo = {
    aniversariante: "nome completo do aniversariante",
    data: "data da reserva (DD/MM/AAAA)",
    total_esperado: "número total de pessoas",
    contato: "telefone de contato"
  };

  let state;
  try { state = JSON.parse(stateRaw); }
  catch {
    await redisDel("telegram:aguardando_reserva");
    await notifyOwner("⚠️ Estado de reserva corrompido. Use /reservar novamente.");
    return;
  }

  const campo = state.faltam[0];
  const valor = texto.trim();
  if (!valor) {
    await notifyOwner(`⚠️ Resposta vazia. Qual o ${labelsCampo[campo]}?`);
    return;
  }

  if (campo === "contato") {
    state.dados.contato = valor.replace(/\D/g, "");
  } else if (campo === "data") {
    const m = valor.match(/(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?/);
    if (!m) {
      await notifyOwner(`⚠️ Data inválida. Envie no formato DD/MM ou DD/MM/AAAA.`);
      return;
    }
    const dia = m[1].padStart(2, "0");
    const mes = m[2].padStart(2, "0");
    let ano = m[3] || String(new Date().getFullYear());
    if (ano.length === 2) ano = "20" + ano;
    state.dados.data = `${dia}/${mes}/${ano}`;
    try { state.dados.dia = getDiaSemana(state.dados.data).toUpperCase(); } catch {}
  } else if (campo === "total_esperado") {
    const num = parseInt(valor.replace(/\D/g, ""));
    if (!num || isNaN(num)) {
      await notifyOwner(`⚠️ Número inválido. Quantas pessoas?`);
      return;
    }
    state.dados.total_esperado = num;
    if (!state.dados.lugares) state.dados.lugares = num;
  } else {
    state.dados[campo] = valor;
  }

  state.faltam.shift();

  if (state.faltam.length > 0) {
    await redisSet("telegram:aguardando_reserva", JSON.stringify(state), 1800);
    await notifyOwner(`Qual o ${labelsCampo[state.faltam[0]]}?`);
    return;
  }

  // todos os campos preenchidos — grava no Notion
  await redisDel("telegram:aguardando_reserva");
  const salvou = await salvarReservaNaNotion(state.dados, state.userId);
  if (salvou) {
    await redisSet(`reserva_confirmada:${state.userId}`, "1", 86400 * 30);
    if (state.dados.data) await redisSet(`reserva_data:${state.userId}`, state.dados.data, 86400 * 30);
    const contatoFmt = state.dados.contato.length === 11
      ? `(${state.dados.contato.slice(0,2)}) ${state.dados.contato.slice(2,7)}-${state.dados.contato.slice(7)}`
      : state.dados.contato;
    await notifyOwner(
      `✅ Reserva gravada!\n📋 ${state.dados.aniversariante} | ${state.dados.data} | ${state.dados.total_esperado} pessoas | ${contatoFmt}`
    );
  } else {
    await notifyOwner(`⚠️ Falha ao gravar reserva para ${state.userId}.`);
  }
}

// ─── Instagram ────────────────────────────────────────────────────────────────

async function buscarUsernameInstagram(userId) {
  try {
    const cached = await redisGet(`ig_username:${userId}`);
    if (cached) return cached;
    const res = await fetch(`https://graph.instagram.com/v25.0/${userId}?fields=username&access_token=${IG_TOKEN}`);
    const data = await res.json();
    const username = data.username || null;
    if (username) await redisSet(`ig_username:${userId}`, username, 86400 * 30);
    return username;
  } catch (err) {
    console.error(`Erro ao buscar username de ${userId}:`, err);
    return null;
  }
}

// remove blocos internos antes de enviar ao cliente (defesa em todos os call sites)
function limparBlocosInternos(texto) {
  if (!texto) return texto;
  return texto.replace(/\[(?:CONSULTAR|RESERVA|ESCALAR|BRIEFING)[^\]]*\]/gs, "").trim();
}

// divide mensagens longas em partes preservando parágrafos
function dividirMensagem(texto, limite = 900) {
  if (!texto || texto.length <= limite) return [texto];
  const paragrafos = texto.split("\n\n");
  const mensagens = [];
  let atual = "";
  for (const p of paragrafos) {
    if ((atual + "\n\n" + p).length > limite) {
      if (atual) mensagens.push(atual.trim());
      atual = p;
    } else {
      atual = atual ? atual + "\n\n" + p : p;
    }
  }
  if (atual) mensagens.push(atual.trim());
  return mensagens.filter(m => m && m.length > 0);
}

async function sendInstagramMessage(userId, text) {
  const limpo = limparBlocosInternos(text);
  if (!limpo) return;
  const partes = dividirMensagem(limpo, 900);
  for (let i = 0; i < partes.length; i++) {
    const parte = partes[i];
    const igRes = await fetch(`https://graph.instagram.com/v25.0/${IG_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Authorization": `Bearer ${IG_TOKEN}`
      },
      body: JSON.stringify({
        recipient: { id: userId },
        message: { text: parte }
      })
    });
    const igData = await igRes.json();
    console.log(`Resposta Graph API (parte ${i+1}/${partes.length}):`, JSON.stringify(igData));
    if (i < partes.length - 1) await sleep(500);
  }
}

// escalada silenciosa: notifica owner, marca como escalada e limpa estado
async function escalarConversa(userId, motivo) {
  const username = await redisGet(`ig_username:${userId}`);
  await notifyOwner(
    `⚠️ Escalonar conversa com ${userId}${username ? ` (@${username})` : ""}\nMotivo: ${motivo}\nUse: /reativar ${userId}`
  );
  await marcarConversaEscalada(userId, motivo);
  await clearPendingMessages(userId);
  await setDebounceToken(userId, `cancelled_${Date.now()}`);
  await cancelarFollowUp(userId);
  console.log(`Conversa ${userId} marcada como escalada (silenciosa). Motivo: ${motivo}`);
}

// atualiza o campo Local da última reserva do cliente no Notion (sem criar nova entrada)
async function atualizarLocalReservaNoNotion(userId, novoLocal) {
  try {
    const pageId = await buscarPageIdPorInstagram(userId);
    if (!pageId) {
      console.log(`Sem pageId no Notion para ${userId} — não foi possível atualizar local`);
      return false;
    }
    const props = {};
    if (novoLocal && novoLocal !== "Sem preferência") {
      props["Local"] = { select: { name: novoLocal } };
    } else {
      props["Local"] = { select: null };
    }
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({ properties: props })
    });
    const result = await res.json();
    if (result.object === "error") {
      console.error(`Erro ao atualizar local no Notion para ${userId}:`, JSON.stringify(result));
      return false;
    }
    console.log(`Local atualizado no Notion para ${userId} → ${novoLocal}`);
    return true;
  } catch (err) {
    console.error(`Exceção ao atualizar local no Notion para ${userId}:`, err);
    return false;
  }
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
  const ultimaIntervencao = await redisGet(`ultima_intervencao:${userId}`);

  if (!ultimaIntervencao || Date.now() - parseInt(ultimaIntervencao) > 2 * 60 * 60 * 1000) {
    await redisDel(`paused:${userId}`);
    console.log(`Conversa com ${userId} auto-reativada durante processamento`);
    paused = false;
  } else {
    console.log(`Conversa com ${userId} pausada — cancelando processamento`);
    return;
  }
}

if (await isGloballyPaused()) {
  console.log(`Bot pausado globalmente — mensagens de ${userId} aguardam na fila`);
  return;
}

  const pendingMessages = await getPendingMessages(userId);
  if (pendingMessages.length === 0) {
    console.log(`Nenhuma mensagem pendente para ${userId}`);
    return;
  }

  await clearPendingMessages(userId);

  const mensagensFiltradas = pendingMessages.filter(m => !detectAtraso(m));
  if (mensagensFiltradas.length === 0) {
    console.log(`Todas as mensagens de ${userId} eram de atraso — ignorando`);
    return;
  }
  const combinedMessage = mensagensFiltradas.join(" | ");
  const mensagemEhSoContato = isOnlyPhoneNumber(combinedMessage);

  console.log(`Processando ${pendingMessages.length} mensagem(ns) de ${userId}: ${combinedMessage}`);
  // CRM: garante que cliente existe no Notion
  (async () => {
    try {
      const username = await redisGet(`ig_username:${userId}`);
      await criarOuAtualizarCliente(userId, {
        username: username || "",
        origem: "Orgânico",
        motivo: await detectarMotivoContato(combinedMessage)
      });
    } catch (e) { console.error("Erro CRM processMessages:", e); }
  })();

  await cancelarFollowUp(userId);

  const history = await getHistory(userId);
 const explicitDates = extractExplicitDates(combinedMessage);

const jaTemReserva = await redisGet(`reserva_confirmada:${userId}`);

const textoLower = combinedMessage.toLowerCase();

// PRIORIDADE ABSOLUTA: se cliente quer reserva para hoje, escalar silenciosamente
// antes de consultar disponibilidade, antes de mensagem exata, antes de qualquer outra lógica
if (!jaTemReserva) {
  const hojeBR = dateToBR(getDataBrasilia());
  const algumaDataEhHoje = explicitDates.some(d => d === hojeBR);
  const temContextoReserva =
    textoLower.includes("reserva") ||
    textoLower.includes("reservar") ||
    textoLower.includes("mesa") ||
    textoLower.includes("aniversário") ||
    textoLower.includes("aniversario");
  const mencionaHoje =
    /\bhoje\b/.test(textoLower) ||
    /\bagora\b/.test(textoLower) ||
    textoLower.includes("essa noite") ||
    textoLower.includes("esta noite") ||
    textoLower.includes("essa tarde") ||
    textoLower.includes("esta tarde");
  if (algumaDataEhHoje || (mencionaHoje && temContextoReserva)) {
    console.log(`Reserva para hoje detectada de ${userId} — escalada silenciosa antes de qualquer fluxo`);
    await escalarConversa(userId, "Cliente quer reserva para hoje");
    return;
  }
}

const querAlterarReserva =
  textoLower.includes("alterar") ||
  textoLower.includes("mudar") ||
  textoLower.includes("trocar") ||
  textoLower.includes("remarcar") ||
  textoLower.includes("cancelar") ||
  textoLower.includes("cancelamento") ||
  textoLower.includes("aumentar") ||
  textoLower.includes("diminuir") ||
  textoLower.includes("mais pessoas") ||
  textoLower.includes("menos pessoas");

  // só consulta disponibilidade se a mensagem tiver contexto de reserva
  const textoTemContextoReserva =
    textoLower.includes("reserva") ||
    textoLower.includes("mesa") ||
    textoLower.includes("reservar") ||
    textoLower.includes("lugar") ||
    textoLower.includes("lugares") ||
    textoLower.includes("aniversário") ||
    textoLower.includes("aniversario") ||
    textoLower.includes("tem vaga") ||
    textoLower.includes("disponib") ||
    querAlterarReserva ||
    (await redisGet(`aguardando_contato:${userId}`)) !== null ||
    history.some(h => h.role === "assistant" && h.content?.includes("[RESERVA:"));

  let disponibilidadeInfo = "";
  if ((!jaTemReserva || querAlterarReserva) && textoTemContextoReserva) {
    const hojeStr = dateToBR(getDataBrasilia());
    for (const data of explicitDates) {
      const disp = await verificarDisponibilidade(data);
      // bloqueia reserva no mesmo dia após horário limite
      if (data === hojeStr) {
        const horaAtual = getHoraBrasilia();
        const diaSemana = getDiaSemana(data);
        const horariosLimite = { "sexta": 19, "sábado": 15, "domingo": 14, "terça": 19, "quarta": 19, "quinta": 19, "segunda": 19 };
        const limiteHora = horariosLimite[diaSemana] || 19;
        if (horaAtual >= limiteHora) {
          disponibilidadeInfo += `Data ${data}: reservas encerradas para hoje — horário limite já passou.\n`;
          continue;
        }
      }
      console.log(`Disponibilidade para ${data}:`, disp);
      if (disp.tipo === "esgotado") {
        disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): ESGOTADA — sem vagas disponíveis.\n`;
      } else if (disp.tipo === "descoberto") {
        disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): disponível, porém apenas área descoberta (calçada, ao ar livre) — área coberta esgotada. (${disp.vagasDescoberto} vagas restantes).\n`;
      } else if (disp.tipo === "coberto") {
        disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): disponível (${disp.vagasCoberto} vagas restantes).\n`;
      } else {
        disponibilidadeInfo += `Data ${data} (${disp.diaSemana}): disponível, sem limite de reservas.\n`;
      }
    }
  }

  history.push({ role: "user", content: combinedMessage });
  if (history.length > 40) history.splice(0, 2);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada antes do Claude — cancelando`);
    return;
  }

  // busca regras especiais do dia atual
function getPrimaryDate(explicitDates, currentMessage, history = []) {
  if (!explicitDates || explicitDates.length === 0) return null;
  // prioriza datas da mensagem atual
  const datesInCurrent = extractExplicitDates(currentMessage);
  if (datesInCurrent.length > 0) return datesInCurrent[0];
  // segunda prioridade: últimas 3 mensagens do histórico
  const ultimas3 = history.slice(-3).map(h => h.content || "").join(" ");
  const datesInRecent = extractExplicitDates(ultimas3);
  if (datesInRecent.length > 0) {
    const hoje = getDataBrasilia();
    const futuras = datesInRecent
      .map(d => { const [dia,mes,ano] = d.split("/"); return { d, dt: new Date(`${ano}-${mes}-${dia}`) }; })
      .filter(x => !isNaN(x.dt.getTime()) && x.dt >= hoje)
      .sort((a,b) => b.dt - a.dt);
    if (futuras.length > 0) return futuras[0].d;
  }
  // fallback: mais recente no histórico que seja futura
  const hoje = getDataBrasilia();
  const futuras = explicitDates
    .map(d => { const [dia,mes,ano] = d.split("/"); return { d, dt: new Date(`${ano}-${mes}-${dia}`) }; })
    .filter(x => {
      // ignora datas inválidas como 25/30
      return !isNaN(x.dt.getTime()) && x.dt >= hoje;
    })
    .sort((a,b) => b.dt - a.dt);
  return futuras.length > 0 ? futuras[0].d : null;
}
let dataPrincipal = getPrimaryDate(explicitDates, combinedMessage, history);

// Se cliente já tem reserva confirmada e nenhuma data foi extraída,
// usar a data da reserva para consultar briefing/programação automaticamente.
if (!dataPrincipal && jaTemReserva) {
  const dataReservaCliente = await getDataReservaCliente(userId);
  if (dataReservaCliente) {
    dataPrincipal = dataReservaCliente;
    console.log(`Sem data na msg — usando data da reserva confirmada (${dataPrincipal}) para ${userId}`);
  }
}

const dataISOConsulta = dataPrincipal ? convertDateToISO(dataPrincipal) : null;

const regrasDiaConsulta = dataISOConsulta
  ? await getRegraDia(dataISOConsulta)
  : null;
console.log(`Briefing para ${dataISOConsulta}:`, regrasDiaConsulta);
// busca programação musical sempre que houver data mencionada
let programacaoConsulta = null;
if (dataPrincipal) {
  programacaoConsulta = await buscarProgramacaoPorData(dataISOConsulta);
  console.log(`Programação conteúdo:`, programacaoConsulta);
  console.log(`Programação para ${dataISOConsulta}: ${programacaoConsulta ? `encontrada${programacaoConsulta.especial ? " (especial)" : ""}` : "não encontrada"}`);
}

// não injeta esgotado se cliente já tem reserva
if (jaTemReserva && disponibilidadeInfo.includes("ESGOTADA")) {
  disponibilidadeInfo = disponibilidadeInfo.replace(/.*ESGOTADA.*\n/g, "");
}

let systemPrompt = getSystemPrompt(
  disponibilidadeInfo || null,
  regrasDiaConsulta
);

// escalação automática se briefing contém "escalar" — silenciosa, sem chamar Claude e sem enviar mensagem ao cliente
if (regrasDiaConsulta?.briefing && regrasDiaConsulta.briefing.toLowerCase().includes("escalar")) {
  const usernameEsc = await redisGet(`ig_username:${userId}`);
  await notifyOwner(`⚠️ Escalonamento automático por briefing do dia\nCliente: ${userId}${usernameEsc ? ` (@${usernameEsc})` : ""}\nBriefing: ${regrasDiaConsulta.briefing}\nUse: /reativar ${userId}`);
  await marcarConversaEscalada(userId, "Briefing do dia requer atenção humana");
  await clearPendingMessages(userId);
  await setDebounceToken(userId, `cancelled_${Date.now()}`);
  await cancelarFollowUp(userId);
  return;
}

if (regrasDiaConsulta?.briefing || programacaoConsulta) {
  systemPrompt += `\n\nATENÇÃO CRÍTICA — INFORMAÇÕES CONFIRMADAS PARA A DATA MENCIONADA:\n`;
  if (regrasDiaConsulta?.briefing) {
    systemPrompt += `BRIEFING DO DIA: ${regrasDiaConsulta.briefing}\n`;
  }
  if (programacaoConsulta) {
    systemPrompt += `PROGRAMAÇÃO CONFIRMADA:\n${programacaoConsulta.linhas}\n`;
    if (programacaoConsulta.especial) {
      if (programacaoConsulta.mensagemExata) {
        systemPrompt += `\nMENSAGEM EXATA DA PROGRAMAÇÃO: ${programacaoConsulta.mensagemExata}\n`;
      }
      if (programacaoConsulta.instrucoes) {
        systemPrompt += `INSTRUÇÕES ESPECIAIS DO DIA: ${programacaoConsulta.instrucoes}\n`;
      }
      systemPrompt += `PRIORIDADE: a MENSAGEM EXATA DA PROGRAMAÇÃO sobrepõe qualquer briefing apenas para perguntas sobre programação/evento/show/atração. As regras fixas de reserva por dia da semana (mensagem exata de sábado/sexta/domingo, limites de lugares, horários de reserva) continuam valendo normalmente.\n`;
    }
  }
  systemPrompt += `INSTRUÇÃO FINAL OBRIGATÓRIA: Responda AGORA com os dados acima. "A confirmar" significa atração ainda não divulgada — informe normalmente como "atração a confirmar". NUNCA diga que não tem programação. NUNCA redirecione para o Instagram se este bloco existir. NUNCA diga que vai checar ou verificar a programação. Se em mensagens anteriores você disse que não tinha a programação, IGNORE — agora você TEM os dados e DEVE usá-los.\n`;
}

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
    systemPrompt += `\nEste cliente já possui uma reserva confirmada anteriormente. Atenda normalmente — NÃO peça nome, telefone ou dados de reserva novamente. NÃO inicie novo fluxo de reserva. Se o cliente quiser alterar algo, apenas confirme o que ele quer mudar e anote na conversa.\n`;
  }

  // se histórico vazio e existe última resposta do bot, injeta como contexto mínimo
  if (history.length <= 1 && ultimaRespostaBot) {
    systemPrompt += `\nCONTEXTO DA ÚLTIMA INTERAÇÃO COM ESTE CLIENTE: a última mensagem enviada pelo bot foi: "${ultimaRespostaBot}". Use isso para dar continuidade natural à conversa, sem tratar como primeiro contato.\n`;
  }

  // injeta resumo da conversa se existir (gerado quando atendente interveio)
  const resumoConversa = await redisGet(`resumo_conversa:${userId}`);
  if (resumoConversa) {
    systemPrompt += `\nRESUMO DO QUE FOI COMBINADO COM ESTE CLIENTE:\n${resumoConversa}\nATENÇÃO: respeite o que foi combinado acima. Se o atendente prometeu algo, isso vale.\n`;
  }

  // retry na chamada ao Claude (3 tentativas com 10s de intervalo)
  let claudeData;
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
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
        if (tentativa === 3) {
          await notifyOwner(
            `⚠️ Erro na API do Claude!\nCliente ID: ${userId}\nErro: ${claudeData.error.type} — ${claudeData.error.message}\nVerifique os créditos em console.anthropic.com`
          );
          return;
        }
        await sleep(10000);
        continue;
      }
      break; // sucesso
    } catch (err) {
      console.error(`Exceção ao chamar a API Claude (tentativa ${tentativa}):`, err);
      if (tentativa === 3) {
        await notifyOwner(`⚠️ Erro ao chamar a API Claude.\nCliente ID: ${userId}\nErro: ${err.message || err}`);
        return;
      }
      await sleep(10000);
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
    const usernameEscalado = await redisGet(`ig_username:${userId}`);
    await notifyOwner(`⚠️ Escalonar conversa com ${userId}${usernameEscalado ? ` (@${usernameEscalado})` : ""}\nMotivo: ${motivoEscalada}\nUse: /reativar ${userId}`);
    await marcarConversaEscalada(userId, motivoEscalada);
    await clearPendingMessages(userId);
    await setDebounceToken(userId, `cancelled_${Date.now()}`);
    await cancelarFollowUp(userId);
    console.log(`Conversa ${userId} marcada como escalada.`);
    reply = reply.replace(/\[ESCALAR:\s*motivo=.*?\]/i, "").trim();
  }

  console.log("Resposta Claude:", reply);

  // O processamento de [RESERVA:] e [ESCALAR:] ocorre INDEPENDENTE de cancelamento de token —
  // a gravação no Notion precisa ser garantida mesmo se uma nova mensagem chegar antes do envio.
  history.push({ role: "assistant", content: reply });
  await saveHistory(userId, history);

  const reservation = extractReservation(reply);
  if (reservation) {
  const dispFinal = await verificarDisponibilidade(reservation.data);

  if (!dispFinal.disponivel) {
    const msgEsgotado =
      "Poxa, enquanto a gente confirmava os dados, as reservas para esse dia esgotaram 😕\n" +
      "Mas a casa funciona por ordem de chegada também, então vocês ainda podem vir curtir com a gente.";

    await notifyOwner(
      `⚠️ Reserva bloqueada por falta de disponibilidade\n` +
      `Cliente: ${userId}\n` +
      `Data: ${reservation.data}\n` +
      `Nome: ${reservation.aniversariante}\n` +
      `Lugares: ${reservation.lugares} | Total: ${reservation.total_esperado}`
    );

    await redisSet(`echo_bot:${userId}`, "1", 180);
    await sendInstagramMessage(userId, msgEsgotado);
    await salvarUltimaRespostaBot(userId, msgEsgotado);

    await clearPendingMessages(userId);
    await redisDel(`aguardando_contato:${userId}`);
    await redisDel(`contato_detectado:${userId}`);
    await cancelarFollowUp(userId);

    return;
  }

  if (dispFinal.tipo === "descoberto") {
    const obs = (reservation.observacao || "").toLowerCase();

    const aceitouExterna =
      obs.includes("externa") ||
      obs.includes("descoberta") ||
      obs.includes("aceitou área externa") ||
      obs.includes("aceitou area externa");

    if (!aceitouExterna) {
      const msgExterna =
        "Temos disponibilidade para esse dia, mas agora somente na área externa/descoberta.\n" +
        "Podemos seguir com a reserva assim?";

      
      await redisSet(`echo_bot:${userId}`, "1", 180);
      await sendInstagramMessage(userId, msgExterna);
      await salvarUltimaRespostaBot(userId, msgExterna);

      await clearPendingMessages(userId);
      await cancelarFollowUp(userId);

      return;
    }

    reservation.observacao = reservation.observacao
      ? `${reservation.observacao} | Área externa (descoberta)`
      : "Área externa (descoberta)";
  }

  // verifica disponibilidade do local solicitado (Fundos/Corredor/Frente)
  if (reservation.local && reservation.local.trim() && reservation.local !== "Sem preferência") {
    const localSolicitado = reservation.local;
    const dispLocal = await verificarDisponibilidadeLocal(reservation.data, localSolicitado);
    if (!dispLocal.disponivel) {
      console.log(`Local ${localSolicitado} esgotado para ${reservation.data} — alterando para Sem preferência`);
      reservation.local = "Sem preferência";
      reservation.observacao = reservation.observacao
        ? `${reservation.observacao} | Cliente pediu ${localSolicitado} (esgotado)`
        : `Cliente pediu ${localSolicitado} (esgotado)`;

      const msgLocalIndisponivel =
        `Conseguimos confirmar a reserva, mas não foi possível garantir o local ${localSolicitado} que você pediu — ele já está com a lotação fechada pra essa data 🥲 Vamos fazer o possível pra te acomodar bem no dia 😊`;

      await redisSet(`echo_bot:${userId}`, "1", 180);
      await sendInstagramMessage(userId, msgLocalIndisponivel);
      await salvarUltimaRespostaBot(userId, msgLocalIndisponivel);
    }
  }

  // se o cliente já tem reserva confirmada, NÃO cria nova entrada no Notion — apenas atualiza o local
  const jaConfirmadaAntes = await redisGet(`reserva_confirmada:${userId}`);
  if (jaConfirmadaAntes) {
    console.log(`Reserva já confirmada para ${userId} — ignorando segundo bloco [RESERVA:]`);
    if (reservation.local && reservation.local.trim() && reservation.local !== "Sem preferência") {
      const ok = await atualizarLocalReservaNoNotion(userId, reservation.local);
      if (!ok) console.log(`Não foi possível atualizar local da reserva existente para ${userId}`);
    }
    await clearPendingMessages(userId);
    await redisDel(`aguardando_contato:${userId}`);
    await redisDel(`contato_detectado:${userId}`);
    await cancelarFollowUp(userId);
  } else {
  let salvou = false;
  try {
    salvou = await salvarReservaNaNotion(reservation, userId);
  } catch (err) {
    console.error(`Falha ao gravar reserva de ${userId}:`, err);
    await notifyOwner(
      `⚠️ Reserva NÃO gravada no Notion!\n` +
      `👤 Cliente: ${userId}\n` +
      `📋 Aniversariante: ${reservation.aniversariante || "—"}\n` +
      `📅 Data: ${reservation.data || "—"}${reservation.dia ? ` (${reservation.dia})` : ""}\n` +
      `👥 Pessoas: ${reservation.total_esperado || "—"}\n` +
      `📞 Contato: ${reservation.contato || "—"}\n` +
      `📍 Local: ${reservation.local || "—"}\n\n` +
      `Grave manualmente ou use /reservar @username`
    );
  }

  if (salvou) {
    await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
    if (reservation.data) await redisSet(`reserva_data:${userId}`, reservation.data, 86400 * 30);
    await clearPendingMessages(userId);
    await redisDel(`aguardando_contato:${userId}`);
    await redisDel(`contato_detectado:${userId}`);
    await cancelarFollowUp(userId);
    console.log(`Reserva concluída e estados limpos para ${userId}`);
    // CRM: atualiza reserva do cliente
    (async () => {
      try {
        const username = await redisGet(`ig_username:${userId}`);
        await criarOuAtualizarCliente(userId, {
          nome: reservation.aniversariante,
          telefone: reservation.contato,
          username: username || "",
          atualizarReserva: true
        });
      } catch (e) { console.error("Erro CRM reserva:", e); }
    })();
  } else {
    console.log(`⚠️ Falha ao salvar reserva para ${userId} — owner notificado`);
  }
  }
}

  const escalation = extractEscalation(reply);

if (escalation) {
  await notifyOwner(
    `⚠️ Escalonar conversa com ${userId}\nMotivo: ${escalation.motivo || "Sem motivo"}`
  );

  await marcarConversaEscalada(userId, escalation.motivo || "");
  await clearPendingMessages(userId);
  await setDebounceToken(userId, `cancelled_${Date.now()}`);
  await cancelarFollowUp(userId);

  console.log(`Conversa ${userId} marcada como escalada.`);

  return; // 🔥 NÃO RESPONDE AO CLIENTE
}

  const cleanReply = reply
    .replace(/\[(?:CONSULTAR|RESERVA|ESCALAR|BRIEFING)[^\]]*\]/gs, "")
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

  // Gating de envio: reserva já foi gravada acima; só bloqueia a resposta ao cliente.
  const pausedFinal = await isPaused(userId);
  if (pausedFinal) {
    console.log(`Conversa com ${userId} pausada após Claude — cancelando envio (reserva já tratada acima)`);
    return;
  }
  const finalToken = await getDebounceToken(userId);
  if (finalToken !== myToken) {
    console.log(`Token cancelado para ${userId} durante chamada ao Claude — cancelando envio (reserva já tratada acima)`);
    return;
  }

  await markLastReply(userId, cleanReply);
  await redisSet(`echo_bot:${userId}`, "1", 180);
  await sendInstagramMessage(userId, cleanReply);
  await salvarUltimaRespostaBot(userId, cleanReply);

  const isConfirmacao = !!reservation;
  const isEscalacao = !!escalation;

  const jaTemReservaFinal = !!(await redisGet(`reserva_confirmada:${userId}`));
  if (!isConfirmacao && !isEscalacao && !jaTemReservaFinal && respostaContemInfoReserva(cleanReply)) {
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
    if (chatId !== TELEGRAM_CHAT_ID) return;

    // verifica se está aguardando resposta do formulário /dia
    const aguardandoDia = await redisGet("telegram:aguardando_dia");
    if (aguardandoDia && !text.startsWith("/")) {
      await redisDel("telegram:aguardando_dia");
      await processarRespostaDia(aguardandoDia, text);
      return;
    }

    // verifica se está aguardando dado faltante da /reservar interativa
    const aguardandoReserva = await redisGet("telegram:aguardando_reserva");
    if (aguardandoReserva && !text.startsWith("/")) {
      await processarRespostaReserva(aguardandoReserva, text);
      return;
    }

    if (text.startsWith("/")) {
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
  const echoText = messaging?.message?.text;

  if (echoDoBot) {
    await redisDel(`echo_bot:${recipientId}`);
    console.log(`Echo do bot ignorado para ${recipientId}`);
    return;
  }

  if (!echoText || echoText.trim() === "") {
    console.log(`Echo sem texto ignorado para ${recipientId}`);
    return;
  }

  // Deduplicação: ignora echo duplicado do Instagram (mesmo mid)
  const echoMid = messaging?.message?.mid;
  if (echoMid) {
    if (await wasMessageProcessed(echoMid)) {
      console.log(`Echo duplicado ignorado para ${recipientId}: ${echoMid}`);
      return;
    }
    await markMessageProcessed(echoMid);
  }

  // Debounce: ignora intervenções subsequentes do mesmo atendente nos próximos 5s
  const intervencaoRecente = await redisGet(`intervencao:${recipientId}`);
  if (intervencaoRecente) {
    console.log(`Intervenção humana duplicada ignorada para ${recipientId} (debounce 5s)`);
    return;
  }
  await redisSet(`intervencao:${recipientId}`, "1", 5);

  // Intervenção humana real
  console.log(`Intervenção humana REAL detectada para ${recipientId}`);
  const usernameIntervencao = await redisGet(`ig_username:${recipientId}`);

  if (echoText) {
    const hist = await getHistory(recipientId);
    hist.push({ role: "assistant", content: `[atendente] ${echoText}` });
    if (hist.length > 40) hist.splice(0, 2);
    await saveHistory(recipientId, hist);
    console.log(`Mensagem do atendente salva no histórico de ${recipientId}`);
  }

  // registra timestamp da última intervenção humana
  await redisSet(`ultima_intervencao:${recipientId}`, Date.now().toString(), 600);

  // busca @ do cliente
  buscarUsernameInstagram(recipientId).catch(() => {});

  await pauseConversation(recipientId);
  await clearPendingMessages(recipientId);
  await marcarIntervencaoHumana(recipientId, echoText);
  await setDebounceToken(recipientId, `cancelled_${Date.now()}`);
  await cancelarFollowUp(recipientId);

  // CRM: marca atendido por humano + gera resumo
  (async () => {
    try {
      const username = await redisGet(`ig_username:${recipientId}`);
      await criarOuAtualizarCliente(recipientId, {
        username: username || "",
        origem: "Orgânico",
        motivo: "Informações",
        observacao: "Primeiro contato atendido manualmente"
      });
      await marcarClienteAtendidoPorHumano(recipientId);
      const histAtual = await getHistory(recipientId);
      if (histAtual.length >= 3) {
        const resumo = await gerarResumoConversa(histAtual);
        if (resumo) {
          await redisSet(`resumo_conversa:${recipientId}`, resumo, 86400 * 30);
          console.log(`Resumo salvo para ${recipientId}: ${resumo}`);
        }
      }
      await salvarHistoricoCompleto(recipientId, `[atendente] ${echoText}`, "assistant");
    } catch (e) { console.error("Erro CRM intervenção:", e); }
  })();

  return;
}

    const senderId = messaging?.sender?.id;
    if (!senderId) return;

    if (await isConversaEscalada(senderId)) {
      console.log(`Conversa com ${senderId} está escalada — ignorando mensagem`);
      const msgEscaladaTexto = messaging?.message?.text;
      if (msgEscaladaTexto) await addToHistory(senderId, "user", msgEscaladaTexto);
      return;
    }

    if (await isGloballyPaused()) {
      const msgTextGlobal = messaging?.message?.text;
      if (msgTextGlobal) {
        await addPendingMessage(senderId, msgTextGlobal);
        console.log(`Bot pausado globalmente — mensagem de ${senderId} adicionada à fila`);
      } else {
        console.log(`Bot pausado globalmente — mensagem não-texto de ${senderId} ignorada`);
      }
      return;
    }

   if (await isPaused(senderId)) {
  const ultimaIntervencao = await redisGet(`ultima_intervencao:${senderId}`);

  if (!ultimaIntervencao || Date.now() - parseInt(ultimaIntervencao) > 2 * 60 * 60 * 1000) {
    await redisDel(`paused:${senderId}`);
    console.log(`Conversa com ${senderId} auto-reativada após pausa antiga`);
  } else {
    console.log(`Conversa com ${senderId} pausada — ignorando`);
    const msgPausadaTexto = messaging?.message?.text;
    if (msgPausadaTexto) await addToHistory(senderId, "user", msgPausadaTexto);
    return;
  }
}

    const messageId = messaging?.message?.mid;
    if (messageId) {
      // lock atômico NX: só processa se conseguir setar (evita race condition)
      const lockUrl = `${UPSTASH_URL}/set/${encodeURIComponent("msg_processed:" + messageId)}/1?NX&EX=86400`;
      const lockRes = await fetch(lockUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
      });
      const lockData = await lockRes.json();
      if (lockData.result !== "OK") {
        console.log(`Mensagem duplicada ignorada (NX): ${messageId}`);
        return;
      }
    }

    let message = messaging?.message?.text || "";

    // busca e cacheia o @ do cliente na primeira mensagem (para ter disponível na reserva)
    buscarUsernameInstagram(senderId).catch(() => {});

    // CRM: cria ou atualiza cliente no Notion
    (async () => {
      try {
        const username = await redisGet(`ig_username:${senderId}`);
        const motivo = await detectarMotivoContato(message);
        const isReferral = !!(messaging?.referral || messaging?.message?.referral);
        await criarOuAtualizarCliente(senderId, {
          username: username || "",
          origem: isReferral ? "Anúncio" : "Orgânico",
          motivo
        });
        await salvarHistoricoCompleto(senderId, message, "user");
      } catch (e) { console.error("Erro CRM:", e); }
    })();

    // PONTO 7: só grava contato se reserva ainda não estiver confirmada
    if (message && isOnlyPhoneNumber(message)) {
      if (!(await redisGet(`reserva_confirmada:${senderId}`))) {
        console.log(`Telefone detectado automaticamente de ${senderId}: ${message}`);
        await redisSet(`contato_detectado:${senderId}`, message, 86400);
      }
    }

// atualiza CRM com telefone mesmo fora de contexto de reserva
    if (message && isOnlyPhoneNumber(message)) {
      const usernameCRM = await redisGet(`ig_username:${senderId}`);
      criarOuAtualizarCliente(senderId, {
        telefone: message.replace(/\D/g, ""),
        username: usernameCRM || ""
      }).catch(err => console.error("Erro CRM telefone:", err));
    }
    
  if (await redisGet(`reserva_confirmada:${senderId}`)) {
  console.log(`Cliente ${senderId} já tem reserva — mantendo atendimento normal`);
}

const aguardandoContato = await redisGet(`aguardando_contato:${senderId}`);
const contatoDetectado = await redisGet(`contato_detectado:${senderId}`);

// story mention: ignorar silenciosamente (será repostado pelo dono)
const isStoryMention = messaging?.message?.attachments?.some(a => a.type === "story_mention");
if (isStoryMention) {
  console.log(`Story mention ignorado de ${senderId}`);
  return;
}

// lead vindo de anúncio: responder antes do bloqueio de mídia/card

const hasMedia = !message && (
  messaging?.message?.sticker_id ||
  messaging?.message?.attachments?.some(a => a.type !== "fallback")
);

if (hasMedia && !isOnlyPhoneNumber(message)) {
  if (aguardandoContato || contatoDetectado) {
    console.log(`Mídia/card recebido de ${senderId} com contexto de contato já detectado — ignorando bloqueio de mídia.`);
    return;
  }
  // se chegou de anúncio (referral), não enviar a mensagem de "apenas texto" — ignorar silenciosamente
  const referralMidia = messaging?.referral || messaging?.message?.referral;
  if (referralMidia) {
    console.log(`Mídia recebida com referral de anúncio para ${senderId} — ignorando silenciosamente`);
    return;
  }
  // Mídia sem texto — escalar silenciosamente sem responder ao cliente
  await escalarConversa(senderId, "Cliente enviou mídia sem texto");
  return;
}

    // anúncio (referral): cliente clicou num ad sem enviar texto — responder com saudação
    if (!message) {
      const referral = messaging?.referral || messaging?.message?.referral;
      if (referral && await isHorarioComercial()) {
        console.log(`Referral/anúncio detectado de ${senderId}`);
        const saudacao = "Oi! Seja bem-vindo ao Candiá 🎉 Como posso ajudar?";
        await redisSet(`echo_bot:${senderId}`, "1", 30);
        await sendInstagramMessage(senderId, saudacao);
        await salvarUltimaRespostaBot(senderId, saudacao);
      }
      return;
    }

// gatilho "humano" — escala para atendimento humano
if (message && message.trim().toLowerCase() === "humano") {
  const username = await redisGet(`ig_username:${senderId}`);
  await notifyOwner(`⚠️ Cliente solicitou atendimento humano\nID: ${senderId}\n@${username || "sem_username"}\nUse: /reativar ${senderId}`);
  await marcarConversaEscalada(senderId, "Cliente solicitou atendimento humano");
  await redisSet(`echo_bot:${senderId}`, "1", 30);
  await sendInstagramMessage(senderId, 'Certo! Em breve alguém da equipe vai te atender por aqui 😊');
  return;
}

// só processa cancelamento se cliente já tem reserva confirmada — evita falsos positivos
const temReservaParaCancelar = await redisGet(`reserva_confirmada:${senderId}`);
if (detectCancelamento(message) && temReservaParaCancelar) {
  console.log(`Cancelamento detectado de ${senderId} — escalando silenciosamente sem responder`);
  await escalarConversa(senderId, "Cliente quer cancelar reserva");
  return;
}

    // mensagens de atraso/chegada: ignorar sempre, você responde pessoalmente
    if (detectAtraso(message)) {
      console.log(`Mensagem de atraso/chegada ignorada de ${senderId}`);
      return;
    }

    await addPendingMessage(senderId, message);
    console.log(`Mensagem de ${senderId} adicionada à fila: ${message}`);

    // Se conversa foi encerrada por humano e pausa expirou: cliente reabre com nova mensagem

    if (!(await isHorarioComercial())) {
      console.log(`Fora do horário comercial — mensagem de ${senderId} aguardará até o próximo horário de atendimento`);
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

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarLimpezaDiaria();
  agendarRotinasDiarias();
  agendarVerificacaoHorario();
 // notifica apenas uma vez por dia
  const ultimoOnline = await redisGet("bot:ultimo_online");
  const hoje = getTodayISO();
  if (ultimoOnline !== hoje) {
    await redisSet("bot:ultimo_online", hoje, 86400);
    notifyOwner("🟢 Bot Candiá iniciado e online!").catch(() => {});
  }
  // processa mensagens acumuladas durante downtime/restart
  if (await isHorarioComercial()) {
    console.log("Startup dentro do horário — processando fila acumulada");
    processarFilaAcumulada().catch(err => console.error("Erro na fila acumulada no startup:", err));
  }
});
