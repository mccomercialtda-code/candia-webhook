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
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IG_ACCOUNT_ID = "17841401897917144";
const DEBOUNCE_MS = 90000; // 1.5 min
const FOLLOWUP_MS = 6 * 60 * 60 * 1000; // 6 horas

// Horário de funcionamento do bot (Brasília)
const BOT_HORA_INICIO = 8;
const BOT_HORA_FIM = 23;

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

async function buscarProgramacaoPorData(dataISO) {
  try {
    console.log(`🔎 Buscando programação para: ${dataISO}`);

    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_PROGRAMACAO_DB_ID}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${NOTION_TOKEN}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28"
      },
      body: JSON.stringify({
        filter: {
          property: "Data",
          date: { equals: dataISO }
        },
        sorts: [{ property: "Horario", direction: "ascending" }]
      })
    });

    const data = await res.json();

    console.log("📦 Resposta bruta do Notion:", JSON.stringify(data, null, 2));

    if (!res.ok) {
      console.error("❌ Erro na API do Notion:", data);
      return [];
    }

    console.log(`🎶 Total de resultados: ${data.results?.length || 0}`);

    // DEBUG EXTRA: ver datas retornadas
    data.results?.forEach((item, i) => {
      const dataNotion = item.properties?.Data?.date?.start;
      console.log(`➡️ Item ${i + 1} data no Notion:`, dataNotion);
    });

    return data.results || [];

  } catch (err) {
    console.error("🔥 Erro ao buscar programação:", err);
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

function getSystemPrompt(disponibilidade, regrasDia = null, programacao = null) {
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

  const regrasEspeciaisInfo = regrasDia?.briefing
    ? `\nINFORMAÇÕES ESPECIAIS PARA A DATA CONSULTADA\n${regrasDia.briefing}\nUse estas informações ao responder perguntas sobre este dia. Elas têm prioridade sobre as regras padrão.\n`
    : "";

  const programacaoInfo = programacao && programacao.length > 0 ? (() => {
    const linhas = programacao.map(p => {
      const artista = p.properties?.Artista?.title?.[0]?.text?.content || "A confirmar";
      // Horario pode ser rich_text ou date dependendo do tipo no Notion
      const horarioProp = p.properties?.Horario;
      const horario = (
        horarioProp?.rich_text?.[0]?.text?.content ||
        horarioProp?.date?.start ||
        ""
      ).trim();
      const estilo = (p.properties?.Estilo?.rich_text?.[0]?.text?.content || "").trim();
      const igRaw = (p.properties?.Instagram?.rich_text?.[0]?.text?.content || "").trim();
      const instagram = igRaw ? (igRaw.startsWith("@") ? igRaw : `@${igRaw}`) : "";
      // formata: @instagram — horario — estilo
      const partes = [];
      partes.push(instagram || artista);
      if (horario) partes.push(horario);
      if (estilo) partes.push(estilo);
      return `• ${partes.join(" — ")}`;
    });
    return `\nPROGRAMAÇÃO DO DIA\nUse exatamente estes dados ao responder — inclua @ do artista, horário e estilo:\n${linhas.join("\n")}\n`;
  })() : "";

  return `Você é o assistente virtual do Candiá Bar, um bar em Belo Horizonte famoso pelo samba ao vivo. Atende clientes pelo Instagram Direct.

DATA E HORA ATUAL
Hoje é ${dataHoje}, ${horaAgora} (horário de Brasília). Use isso para interpretar "hoje", "amanhã", "essa sexta", "esta semana" etc.
${dispInfo}${regrasEspeciaisInfo}${programacaoInfo}

IDENTIDADE E TOM

* Simpático, leve, acolhedor e com cara de conversa real — nunca robótico
* Falar como alguém do bar, não como sistema
* Primeira pessoa do plural: "a gente", "conseguimos", "seguramos", "aguardamos"
* Emojis com moderação
* Texto simples, sem markdown
* Nunca mencionar "dono" ou "proprietário"
* Atendimento apenas via Instagram ou presencial

SAUDAÇÃO

* Se o cliente disser “tudo bem?”, responder:
  “Tudo bem, e você? 😊”
  ou
  “Tudo bem por aqui, e por aí? 😊”
* Sempre já puxar o assunto na sequência
* Nunca usar “tudo bem sim, obrigado”

REGRA GERAL

* Responder apenas o que foi perguntado
* Nunca sugerir nada que o cliente não pediu
* Respostas curtas e naturais
* Soar humano, não institucional
* Nunca mencionar o dia da semana ao responder sobre datas — se o cliente perguntar sobre o dia 30/04, não dizer "dia 30 é quinta-feira". Responder direto ao assunto

CONTEXTO DO CLIENTE (OBRIGATÓRIO)

* Sempre considerar o que o cliente já informou
* Nunca repetir perguntas já respondidas
* Perguntar apenas o que ainda estiver faltando

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

FUNCIONAMENTO

* Fechado segunda
* Terça a quinta: 17h às 00h
* Sexta: 11h às 01h
* Sábado: 12h às 00h
* Domingo: 12h às 21h

MÚSICA AO VIVO

* Sexta, sábado e domingo: samba
* Se houver programação consultada abaixo (PROGRAMAÇÃO DO DIA), use essas informações para responder sobre quem toca, horário e estilo
* Se não houver programação consultada, direcionar para os destaques do @ocandiabar no Instagram, tópico "agenda"
* Nunca inventar nomes de artistas ou horários que não estejam na programação consultada

COUVERT

* Terça a quinta: R$12
* Sexta a domingo: R$10
* Só mencionar se perguntarem

ENTRADA / COUVERT

* Entrada e couvert são a mesma coisa
* Sempre dizer que há couvert
* Nunca dizer “não tem entrada”

PROMOÇÃO GRUPO / CORTESIA ANIVERSARIANTE / BENFÍCIO ANIVERSARIANTE

* Necessário fazer reserva e levar mais de 10 pessoas → Ganha 2 litros de chope
* Sempre tratar isso como benefício principal
* Nunca dizer que não tem benefício/cortesia/promoção

FEIJOADA

- Servida aos finaise de semana
- Aos sábados tem valor promocional de R$20,00 e acompanha um copo de pilsen 300ml - até as 14hs (depois deste horário preço normal do cardápio)
- Só mencionar se o cliente perguntar
- Nunca oferecer espontaneamente

DISPONIBILIDADE

* "coberto" é interno → nunca mencionar
* Só mencionar área externa se for a única opção
* Nunca falar “área interna”

ESGOTADO / SEM RESERVAS DISPONÍVEIS

Se as reservas estiverem esgotadas, nunca dizer que o cliente não pode vir.

Responder de forma leve:
"Hoje infelizmente as reservas já estão esgotadas 😕 Ainda temos algumas mesas disponiveis por ordem de chegada, mas como a galera aqui fica mais em pé mesmo pode chegar que sempre cabe todo mundo 💙"

Nunca usar frases como:
- "não conseguimos encaixar mais ninguém"
- "não tem como"
- "não dá para receber vocês"

RESERVAS

* Uma mesa por reserva
* Sem reserva → ordem de chegada
* Sempre informar horário limite

BOLO / TORTA / DOCE

Se o cliente perguntar se pode levar bolo, torta ou doce:
"Pode trazer sim 😉 Só não conseguimos garantir espaço na geladeira — guardamos por ordem de chegada. Se quando você chegar não houver espaço, você pode deixar na sua mesa mesmo. 😉 Só um detalhe: pratinhos e talheres a gente não tem, só guardanapos - então vale trazer o de vocês!."

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

- Terça a Quinta reservas seguradas até 19h (se cliente insistir, conseguimos segurar ate as 19:30hs)
- Sexta: reservas seguradas até 19h (tolerância de 15 minutos)
- Sábado: reservas seguradas até 15h (tolerância de 15 minutos)
- Domingo: reservas seguradas até 14h (tolerância de 15 minutos)
- Após esse horário: entrada por ordem de chegada

REGRAS IMPORTANTES:

- Nunca inventar horários diferentes
- Nunca misturar horários de dias diferentes
- Só falar o horário depois que a data estiver definida

SÁBADO (OBRIGATÓRIO)

1. Confirmar data e pessoas
2. Explicar formato
3. Perguntar se pode seguir

* Mesa até 8 lugares
* Restante fica em volta curtindo o samba
* Sempre vender como experiência positiva
* Nunca falar área interna

FLUXO DE RESERVA

1. Perguntar data + pessoas
2. Confirmar data exata
3. Explicar regras do dia
4. Perguntar se pode seguir
5. Pedir dados
6. Confirmar

* Nunca pular etapas
* Nunca misturar passos

MÚSICOS
Se alguém quiser tocar:

Primeira resposta:
“Que massa receber seu material! A gente ama conhecer músicos de BH 🎶
No momento estamos com a agenda fechada com a galera que já toca por aqui, mas vamos guardar seu material com carinho.
Se surgir uma oportunidade, a gente chama você 😊”

Se insistir:
“Entendemos demais a vontade de mostrar seu som 🙏🏾
Mas por enquanto realmente não temos abertura na agenda.
Vamos deixar seu material registrado por aqui e, pintando oportunidade, te chamamos 😊”

* Não escalar
* Não gerar follow-up
* Não prolongar conversa

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

ENCERRAMENTO

* Se o cliente encerrar: responder uma vez
* Ex: “A gente te espera lá! 🎉”
* Depois não responder mais

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
    t.includes("meu uber") ||
    t.includes("uber atrasou") ||
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

  const diaNumRegex = /\b(segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)\s+dia\s+(\d{1,2})\b/gi;
  let match;
  while ((match = diaNumRegex.exec(text)) !== null) {
    const diaNum = parseInt(match[2]);
    const mesAtual = now.getMonth() + 1;
    const anoAtual = now.getFullYear();
    results.push(`${String(diaNum).padStart(2,"0")}/${String(mesAtual).padStart(2,"0")}/${anoAtual}`);
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

  // extrai "esse sábado", "essa sexta", "próximo domingo" etc sem número
  const diaSemanaRegex = /(esse|essa|próximo|proxima|próxima|proxima)\s+(segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)/gi;
  while ((match = diaSemanaRegex.exec(text)) !== null) {
    const data = proximoDiaSemana(match[2]);
    if (data) results.push(data);
  }

  // extrai dia da semana sozinho (sem prefixo) em qualquer posição do texto
  const diaIsoladoRegex = /(^|\s)(segunda|terça|terca|quarta|quinta|sexta|sábado|sabado|domingo)($|\s|[!?,.])/gi;
  while ((match = diaIsoladoRegex.exec(text)) !== null) {
    const data = proximoDiaSemana(match[2]);
    if (data) results.push(data);
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
  // pausa temporária por 2 horas após intervenção humana
  const ttl = 60 * 60 * 2; // 2h em segundos

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

  if (cmd.startsWith("/reativar")) {
    const parts = raw.split(" ");
    if (parts.length > 1) {
      let userId = parts[1].trim();

      // suporte a /reativar @username
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
          await notifyOwner(`⚠️ Usuário @${username} não encontrado no cache. Use o ID numérico.`);
          return;
        }
        userId = found;
      }

      await limparConversaEscalada(userId);
      await redisDel(`paused:${userId}`);
      const username = await redisGet(`ig_username:${userId}`);
      await notifyOwner(`▶️ Conversa ${userId}${username ? ` (@${username})` : ""} reativada!`);
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
        : `▶️ Bot está ATIVO. Horário: ${BOT_HORA_INICIO}h às ${BOT_HORA_FIM}h. Agora: ${comercial ? "dentro do horário ✅" : "fora do horário 🌙"}${forceOutside ? " | modo forçado fora do horário ligado 🔓" : ""}`
    );
    return;
  }

  if (cmd.startsWith("/limpar ")) {
    const dataISO = parseDateFromCommand(cmd.slice(8));
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /limpar 11/04"); return; }
    await clearOverride(dataISO);
    await redisDel(`regra_dia:${dataISO}`);
    await notifyOwner(`✅ Override e regras especiais removidos para ${formatDateBR(dataISO)}.`);
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

  if (cmd.startsWith("/dia ")) {
    const dataISO = parseDateFromCommand(raw.slice(5).trim());
    if (!dataISO) { await notifyOwner("⚠️ Data inválida. Use: /dia 18/04"); return; }

    // verifica se já tem regras salvas
    const regraAtual = await getRegraDia(dataISO);
    let msgAtual = "";
    if (regraAtual?.briefing) {
      msgAtual = `\n\n⚙️ Briefing atual:\n"${regraAtual.briefing}"`;
    }

    await redisSet("telegram:aguardando_dia", dataISO, 300);
    await notifyOwner(
      `📅 Briefing para ${formatDateBR(dataISO)}${msgAtual}\n\n` +
      `Responda com texto livre descrevendo o que for diferente neste dia.\n` +
      `Exemplo: "Aniversário do bar. Programação especial a partir das 15h. Reservas seguradas até as 17h. Limite de 15 reservas. Samba das 18h às 22h."`
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
          system: `Você vai extrair dados de uma reserva a partir do histórico de conversa de um cliente do Candiá Bar.

Seu objetivo é identificar se já existem dados suficientes para registrar a reserva no sistema.

Considere como suficientes os seguintes campos:
- data
- aniversariante
- contato
- total_esperado

Campos desejáveis, mas que podem ser inferidos se necessário:
- dia
- lugares
- observacao

REGRAS IMPORTANTES:

1. Aceite datas em formatos como:
- DD/MM/AAAA
- DD/MM/AA
- DD-MM-AAAA
- DD-MM-AA

Se a data vier com ano de 2 dígitos, converta para 4 dígitos assumindo 20XX.
Exemplo:
15/05/26 -> 15/05/2026

2. Se o dia da semana não estiver escrito, calcule a partir da data e retorne em maiúsculas.
Exemplo:
15/05/2026 -> SEXTA

3. Se houver apenas um número de pessoas no texto, use esse valor tanto para:
- lugares
- total_esperado

Exemplo:
“20 convidados” -> lugares=20 e total_esperado=20

4. Interprete expressões equivalentes como quantidade de pessoas:
- convidados
- pessoas
- previsão de convidados
- total de pessoas

5. Interprete telefone mesmo que venha com espaços, parênteses ou hífen.
Retorne apenas números.
Exemplo:
31 98471-7364 -> 31984717364

6. “Nome completo” ou nome informado junto com outros dados deve ser tratado como aniversariante.

7. Se observação não existir de forma clara, retorne observacao como string vazia.

8. Só retorne encontrou=false se realmente faltarem dados essenciais para registrar a reserva.
Se houver data + nome + telefone + quantidade de pessoas, considere que encontrou=true.

9. Responda apenas em JSON válido, sem explicações, sem markdown.

Formato da resposta:
{"encontrou":true,"data":"DD/MM/AAAA","dia":"DIASEMANA","aniversariante":"NOME","contato":"SOMENTE NUMEROS","lugares":NUMERO,"total_esperado":NUMERO,"observacao":""}

Se realmente não houver dados suficientes, responda:
{"encontrou":false}`,
          messages: [
            { role: "user", content: "Histórico da conversa:\n" + hist.map(h => h.role + ": " + h.content).join("\n") }
          ]
        })
      });

      const claudeData = await claudeRes.json();
      const rawText = claudeData.content?.[0]?.text || "";
      const clean = rawText.replace(/```json|```/g, "").trim();
      const dados = JSON.parse(clean);

      if (!dados.encontrou) {
        await notifyOwner(`⚠️ Não encontrei dados suficientes de reserva no histórico de ${userId}${igUsername ? ` (@${igUsername})` : ""}.
Verifique a conversa manualmente.`);
        return;
      }

      const salvou = await salvarReservaNaNotion(dados, userId);
      if (salvou) {
        await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
        await notifyOwner(
          `✅ Reserva gravada no Notion!
` +
          `Cliente: ${userId}${igUsername ? ` (@${igUsername})` : ""}
` +
          `Nome: ${dados.aniversariante}
` +
          `Data: ${dados.data} (${dados.dia})
` +
          `Lugares: ${dados.lugares} | Total: ${dados.total_esperado}
` +
          `Contato: ${dados.contato}
` +
          `Obs: ${dados.observacao || "—"}`
        );
      }
    } catch (err) {
      await notifyOwner(`⚠️ Erro ao extrair dados de reserva: ${err.message}`);
    }
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

/dia DD/MM — Configura regras especiais para uma data
Ex: /dia 18/04

/pausar — Pausa o bot globalmente
/reativar — Reativa o bot
/reativar @username — Reativa pelo @ do Instagram
/reservar @username — Grava reserva a partir do histórico
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

const jaTemReserva = await redisGet(`reserva_confirmada:${userId}`);

const textoLower = combinedMessage.toLowerCase();

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
    querAlterarReserva;

  let disponibilidadeInfo = "";
  if ((!jaTemReserva || querAlterarReserva) && textoTemContextoReserva) {
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
  }

  history.push({ role: "user", content: combinedMessage });
  if (history.length > 20) history.splice(0, 2);

  paused = await isPaused(userId);
  if (paused) {
    console.log(`Conversa com ${userId} pausada antes do Claude — cancelando`);
    return;
  }

  // busca regras especiais do dia atual
function getPrimaryDate(explicitDates) {
  if (!explicitDates || explicitDates.length === 0) return null;
  return explicitDates[0];
}

const dataPrincipal = getPrimaryDate(explicitDates);
const dataISOConsulta = dataPrincipal ? convertDateToISO(dataPrincipal) : null;

const regrasDiaConsulta = dataISOConsulta
  ? await getRegraDia(dataISOConsulta)
  : null;

// busca programação musical para datas mencionadas
let programacaoConsulta = [];
if (dataPrincipal) {
  programacaoConsulta = await buscarProgramacaoPorData(dataISOConsulta);
}

let systemPrompt = getSystemPrompt(
  disponibilidadeInfo || null,
  regrasDiaConsulta,
  programacaoConsulta.length > 0 ? programacaoConsulta : null
);

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

      await notifyOwner(
        `⚠️ Reserva aguardando aceite de área externa\n` +
        `Cliente: ${userId}\n` +
        `Data: ${reservation.data}\n` +
        `Nome: ${reservation.aniversariante}\n` +
        `Lugares: ${reservation.lugares} | Total: ${reservation.total_esperado}`
      );

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

  const salvou = await salvarReservaNaNotion(reservation, userId);

  if (salvou) {
    await redisSet(`reserva_confirmada:${userId}`, "1", 86400 * 30);
    await clearPendingMessages(userId);
    await redisDel(`aguardando_contato:${userId}`);
    await redisDel(`contato_detectado:${userId}`);
    await cancelarFollowUp(userId);
    console.log(`Reserva concluída e estados limpos para ${userId}`);
  } else {
    console.log(`⚠️ Falha ao salvar reserva para ${userId} — owner notificado`);
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

  // Intervenção humana real
  console.log(`Intervenção humana REAL detectada para ${recipientId}`);
  const usernameIntervencao = await redisGet(`ig_username:${recipientId}`);

  if (echoText) {
    const hist = await getHistory(recipientId);
    hist.push({ role: "assistant", content: `[atendente] ${echoText}` });
    if (hist.length > 20) hist.splice(0, 2);
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

   if (await isPaused(senderId)) {
  const ultimaIntervencao = await redisGet(`ultima_intervencao:${senderId}`);

  if (!ultimaIntervencao || Date.now() - parseInt(ultimaIntervencao) > 2 * 60 * 60 * 1000) {
    await redisDel(`paused:${senderId}`);
    console.log(`Conversa com ${senderId} auto-reativada após pausa antiga`);
  } else {
    console.log(`Conversa com ${senderId} pausada — ignorando`);
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
  } else {
    if (await isHorarioComercial()) {
      await sendInstagramMessage(
        senderId,
        "Oi! Por aqui atendemos apenas por mensagem de texto. Pode me escrever o que precisar que respondo rapidinho!"
      );
    }
    return;
  }
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

if (detectCancelamento(message)) {
  console.log(`Cancelamento detectado de ${senderId}`);

  const username = await redisGet(`ig_username:${senderId}`);

  await notifyOwner(
    `⚠️ Cliente quer cancelar reserva\nID: ${senderId}\n@${username || "sem_username"}`
  );

  // evita echo
  await redisSet(`echo_bot:${senderId}`, "1", 30);

  await sendInstagramMessage(
    senderId,
    "Olá, tudo bem? Poxa que pena 🥹 Esperamos você em outra oportunidade. Obrigado por avisar!"
  );

  return; // 🔥 IMPORTANTE: para aqui
}

    // mensagens de atraso/chegada: ignorar sempre, você responde pessoalmente
    if (detectAtraso(message)) {
      console.log(`Mensagem de atraso/chegada ignorada de ${senderId}`);
      return;
    }

    await addPendingMessage(senderId, message);
    console.log(`Mensagem de ${senderId} adicionada à fila: ${message}`);

    if (await isPaused(senderId)) {
  const ultimaIntervencao = await redisGet(`ultima_intervencao:${senderId}`);

  if (!ultimaIntervencao || Date.now() - parseInt(ultimaIntervencao) > 2 * 60 * 60 * 1000) {
    await redisDel(`paused:${senderId}`);
    console.log(`Conversa com ${senderId} auto-reativada após pausa antiga`);
  } else {
    console.log(`Conversa com ${senderId} pausada — ignorando`);
    return;
  }
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

app.listen(PORT, async () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  agendarLimpezaDiaria();
  agendarRotinasDiarias();
  agendarVerificacaoHorario();
  notifyOwner("🟢 Bot Candiá iniciado e online!").catch(() => {});
  // processa mensagens acumuladas durante downtime/restart
  if (await isHorarioComercial()) {
    console.log("Startup dentro do horário — processando fila acumulada");
    processarFilaAcumulada().catch(err => console.error("Erro na fila acumulada no startup:", err));
  }
});
