// backend.js (modificado para usar gemini-embedding-001 nativamente)

const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();

// Dependências da IA e do Supabase
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Inicializa o cliente do Supabase
const supabaseClient = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Inicializa o cliente do Gemini
const genAI = new GoogleGenerativeAI(process.env.API_KEY);

const masterPromptTemplate = `
Você é um assistente virtual chamada Flexbot, especialista em FlexSim.

Use o seguinte CONTEXTO TÉCNICO para responder a pergunta do usuário. Este contexto foi extraído da documentação oficial e de guias de comando. Se a resposta não estiver no contexto, tente ajudar com seus conhecimentos mas informe que a resposta pode conter erros dado que não foi encontrado no contexto.

CONTEXTO TÉCNICO:
---
{retrieved_knowledge}
---

Se a pergunta for sobre desempenho ou funcionamento do modelo, analise os DADOS DA SIMULAÇÃO abaixo:

DADOS DA SIMULAÇÃO: {db_data}

PERGUNTA DO USUÁRIO: "{input}"
`;

// -------- Rate Limiter com configuração específica para embeddings --------
const nowMs = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (ms) => Math.floor(ms * (0.5 + Math.random()));

class RateLimiter {
  constructor({ maxPerMinute, maxPerDay }) {
    this.maxPerMinute = Math.max(1, maxPerMinute || 12);
    this.maxPerDay = Math.max(1, maxPerDay || 900);
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

// Retry com backoff exponencial
async function withBackoff(task, { tries = 3, baseMs = 1500 } = {}) {
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

// Rate limiters específicos
const GEMINI_RPM = parseInt(process.env.GEMINI_RPM || "12", 10);
const GEMINI_RPD = parseInt(process.env.GEMINI_RPD || "900", 10);
const EMBED_RPM = parseInt(process.env.EMBED_RPM || "10", 10); // Mais conservador para embeddings

const genLimiter = new RateLimiter({ maxPerMinute: GEMINI_RPM, maxPerDay: GEMINI_RPD });
const embedLimiter = new RateLimiter({ maxPerMinute: EMBED_RPM, maxPerDay: GEMINI_RPD });

// -------- Funções de embedding nativas --------

// Função para gerar embeddings usando gemini-embedding-001
async function generateEmbedding(text) {
  return embedLimiter.schedule(() =>
    withBackoff(async () => {
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
        const result = await model.embedContent(text);
        return result.embedding.values;
      } catch (error) {
        console.error('Erro ao gerar embedding:', error);
        throw error;
      }
    })
  );
}

// Função para busca de similaridade usando embeddings
async function performSemanticSearch(query, k = 4) {
  try {
    // Gera embedding da query
    const queryEmbedding = await generateEmbedding(query);
    
    // Busca documentos similares no Supabase usando RPC
    const { data, error } = await supabaseClient.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.7,
      match_count: k
    });

    if (error) {
      console.error('Erro na busca semântica:', error);
      throw error;
    }

    return data || [];
  } catch (error) {
    console.error('Erro no semantic search:', error);
    throw error;
  }
}

// Função para geração de texto com rate limiting
async function generateWithGemini(finalPrompt) {
  return genLimiter.schedule(() =>
    withBackoff(async () => {
      const model = genAI.getGenerativeModel({ model: process.env.MODEL || 'gemini-2.5-flash-lite' });
      const result = await model.generateContent(finalPrompt);
      const response = await result.response;
      return response.text();
    })
  );
}

// --- ENDPOINTS DA API ---

// Teste de conexão com o banco do usuário
app.post('/api/test-connection', async (req, res) => {
  const { user, host, database, password, port } = req.body;
  const tempClient = new Client({ 
    user, host, database, password, port, 
    ssl: { rejectUnauthorized: false } 
  });
  
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
    user, host, database, password, port,
    ssl: { rejectUnauthorized: false }
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

// Chat único com embeddings nativos
app.post('/api/chatbot', async (req, res) => {
  const { message, dbData } = req.body;
  
  try {
    // RAG usando embeddings nativos
    const retrievedDocs = await performSemanticSearch(message, 4);
    const retrievedKnowledge = retrievedDocs
      .map(doc => doc.content || doc.page_content)
      .join('\n\n');

    // Prompt final
    const finalPrompt = masterPromptTemplate
      .replace('{retrieved_knowledge}', retrievedKnowledge)
      .replace('{db_data}', JSON.stringify(dbData, null, 2))
      .replace('{input}', message);

    const text = await generateWithGemini(finalPrompt);
    res.json({ success: true, response: text });
  } catch (error) {
    console.error("Erro no endpoint do chatbot:", error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      details: 'Verifique se os rate limits estão sendo respeitados'
    });
  }
});

// Chat em lote com embeddings otimizados
app.post('/api/chatbot/batch', async (req, res) => {
  const { messages, dbData } = req.body;
  
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ 
      success: false, 
      message: 'Envie "messages" como array não vazio.' 
    });
  }

  try {
    const results = [];
    
    for (const msg of messages) {
      try {
        // RAG para cada mensagem
        const retrievedDocs = await performSemanticSearch(msg, 4);
        const retrievedKnowledge = retrievedDocs
          .map(doc => doc.content || doc.page_content)
          .join('\n\n');

        const finalPrompt = masterPromptTemplate
          .replace('{retrieved_knowledge}', retrievedKnowledge)
          .replace('{db_data}', JSON.stringify(dbData, null, 2))
          .replace('{input}', msg);

        const text = await generateWithGemini(finalPrompt);
        results.push({ input: msg, response: text, success: true });
        
      } catch (error) {
        console.error(`Erro processando mensagem "${msg}":`, error);
        results.push({ 
          input: msg, 
          response: null, 
          success: false, 
          error: error.message 
        });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error("Erro no endpoint de batch:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint para testar embeddings
app.post('/api/test-embedding', async (req, res) => {
  const { text } = req.body;
  
  try {
    const embedding = await generateEmbedding(text);
    res.json({ 
      success: true, 
      embedding: embedding.slice(0, 10), // Apenas os primeiros 10 valores para teste
      dimensions: embedding.length 
    });
  } catch (error) {
    console.error("Erro no teste de embedding:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor backend rodando na porta ${port}`);
  console.log(`Usando gemini-embedding-001 com rate limiting rigoroso`);
  console.log(`Rate limits: ${EMBED_RPM} RPM para embeddings, ${GEMINI_RPM} RPM para geração`);
});
