// backend.js (com rate limiting e batch para Gemini 2.5 Flash Lite)

const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { SupabaseVectorStore } = require("@langchain/community/vectorstores/supabase");

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = 3001;
app.use(cors());
app.use(express.json());

// Supabase
const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Prompt mestre
const masterPromptTemplate = `
Você é um assistente virtual chamada Flexbot, especialista em FlexSim.

Use o seguinte CONTEXTO TÉCNICO para responder a pergunta do usuário. Este contexto foi extraído da documentação oficial e de guias de comando. Se a resposta não estiver no contexto, tente ajudar com seus conhecimentos mas informe que a resposta pode conter erros dado que náo foi encontrado no contexto.

CONTEXTO TÉCNICO:
---
{retrieved_knowledge}
---

Se a pergunta for sobre desempenho ou funcionamento do modelo, analise os DADOS DA SIMULAÇÃO abaixo:

DADOS DA SIMULAÇÃO: {db_data}

PERGUNTA DO USUÁRIO: "{input}"
`;

// -------- Rate limiting utilitário (sem dependências) --------
const nowMs = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.5 + Math.random())); // 50–150%

class RateLimiter {
  constructor({ maxPerMinute, maxPerDay }) {
    this.maxPerMinute = Math.max(1, maxPerMinute || 12); // margem abaixo do limite do tier gratuito
    this.maxPerDay = Math.max(1, maxPerDay || 900);       // idem cota diária
    this.minIntervalMs = Math.ceil(60000 / this.maxPerMinute);
    this.queue = [];
    this.running = false;
    this.lastRunAt = 0;
    this.dayCount = 0;
    this.dayResetAt = this._nextMidnight();
  }

  _nextMidnight() {
    const d = new Date();
    d.setHours(24, 0, 0, 0);
    return d.getTime();
  }

  _resetDailyIfNeeded() {
    if (nowMs() >= this.dayResetAt) {
      this.dayCount = 0;
      this.dayResetAt = this._nextMidnight();
    }
  }

  async schedule(taskFn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ taskFn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        this._resetDailyIfNeeded();
        if (this.dayCount >= this.maxPerDay) {
          const waitMs = this.dayResetAt - nowMs();
          await sleep(Math.max(waitMs, 1000));
          continue;
        }

        const sinceLast = nowMs() - this.lastRunAt;
        if (sinceLast < this.minIntervalMs) {
          await sleep(this.minIntervalMs - sinceLast);
        }

        const { taskFn, resolve, reject } = this.queue.shift();
        try {
          this.lastRunAt = nowMs();
          this.dayCount += 1;
          const result = await taskFn();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// Retries com backoff exponencial quando 429/quota
async function withBackoff(task, { tries = 5, baseMs = 1500 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < tries) {
    try {
      return await task();
    } catch (err) {
      const msg = `${err?.message || err}`;
      const is429 = /429|Too Many Requests|quota|exceeded|rate/i.test(msg);
      attempt += 1;
      if (!is429 || attempt >= tries) {
        lastErr = err;
        break;
      }
      const wait = jitter(baseMs * Math.pow(2, attempt - 1));
      console.warn(`429/rate-limit: retry ${attempt}/${tries} em ${wait}ms...`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

// Configuráveis por env (deixe margem abaixo do limite do tier)
const GEMINI_RPM = parseInt(process.env.GEMINI_RPM || "12", 10);           // ex.: 12 < 15
const GEMINI_RPD = parseInt(process.env.GEMINI_RPD || "900", 10);          // ex.: 900 < 1000
const GEMINI_EMBED_RPM = parseInt(process.env.GEMINI_EMBED_RPM || "12", 10);

const genLimiter = new RateLimiter({ maxPerMinute: GEMINI_RPM, maxPerDay: GEMINI_RPD });
const embedLimiter = new RateLimiter({ maxPerMinute: GEMINI_EMBED_RPM, maxPerDay: GEMINI_RPD });

// -------- Funções de negócio --------
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

async function generateWithGemini(finalPrompt) {
  const model = genAI.getGenerativeModel({ model: process.env.MODEL });
  // Envolve a chamada com retry dentro do limiter
  return genLimiter.schedule(() =>
    withBackoff(async () => {
      const result = await model.generateContent(finalPrompt);
      const response = await result.response;
      return response.text();
    })
  );
}

async function similaritySearchLimited(vectorStore, query, k = 4) {
  return embedLimiter.schedule(() =>
    withBackoff(async () => {
      return vectorStore.similaritySearch(query, k);
    })
  );
}

// --- ENDPOINTS DA API ---

// Teste de conexão com o banco do usuário
app.post('/api/test-connection', async (req, res) => {
  const { user, host, database, password, port } = req.body;
  const tempClient = new Client({ user, host, database, password, port, ssl: { rejectUnauthorized: false } });
  try {
    await tempClient.connect();
    await tempClient.end();
    res.json({ success: true, message: 'Conexão bem-sucedida!' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Consulta tabelas do banco do usuário
app.post('/api/query', async (req, res) => {
  const { user, host, database, password, port, tables } = req.body;
  const tempClient = new Client({
    user,
    host,
    database,
    password,
    port,
    ssl: { rejectUnauthorized: false },
  });
  try {
    await tempClient.connect();
    const data = {};
    for (const table of tables) {
      const result = await tempClient.query(`SELECT * FROM ${table}`);
      data[table] = result.rows;
    }
    await tempClient.end();
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Chat único
app.post('/api/chatbot', async (req, res) => {
  const { message, dbData } = req.body;
  try {
    // RAG
    const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey: process.env.API_KEY });
    const vectorStore = new SupabaseVectorStore(embeddings, {
      client: supabaseClient,
      tableName: 'documents',
      queryName: 'match_documents',
    });

    const retrievedDocs = await similaritySearchLimited(vectorStore, message, 4);
    const retrievedKnowledge = retrievedDocs.map(doc => doc.pageContent).join('\n\n');

    // Prompt final
    const finalPrompt = masterPromptTemplate
      .replace('{retrieved_knowledge}', retrievedKnowledge)
      .replace('{db_data}', JSON.stringify(dbData, null, 2))
      .replace('{input}', message);

    const text = await generateWithGemini(finalPrompt);
    res.json({ success: true, response: text });
  } catch (error) {
    console.error("Erro no endpoint do chatbot:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Chat em lote
// payload: { messages: [ "pergunta 1", "pergunta 2", ... ], dbData: {...} }
app.post('/api/chatbot/batch', async (req, res) => {
  const { messages, dbData } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ success: false, message: 'Envie "messages" como array não vazio.' });
  }

  try {
    // RAG único por item (para máxima precisão contextual);
    // se quiser performance, também é possível fazer RAG uma vez e reutilizar.
    const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey: process.env.API_KEY });
    const vectorStore = new SupabaseVectorStore(embeddings, {
      client: supabaseClient,
      tableName: 'documents',
      queryName: 'match_documents',
    });

    const results = [];
    for (const msg of messages) {
      const retrievedDocs = await similaritySearchLimited(vectorStore, msg, 4);
      const retrievedKnowledge = retrievedDocs.map(doc => doc.pageContent).join('\n\n');

      const finalPrompt = masterPromptTemplate
        .replace('{retrieved_knowledge}', retrievedKnowledge)
        .replace('{db_data}', JSON.stringify(dbData, null, 2))
        .replace('{input}', msg);

      const text = await generateWithGemini(finalPrompt);
      results.push({ input: msg, response: text });
      // O espaçamento entre chamadas já é garantido pelo limiter
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error("Erro no endpoint de batch:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor backend rodando na porta ${port}. Conectado ao Supabase para RAG.`);
});
