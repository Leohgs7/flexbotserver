// backend.js (versão corrigida com nomes de modelo válidos)

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

// -------- Rate Limiter --------
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

// Rate limiters e configurações
const GEMINI_RPM = parseInt(process.env.GEMINI_RPM || "8", 10);  // Mais conservador
const GEMINI_RPD = parseInt(process.env.GEMINI_RPD || "800", 10);
const EMBED_RPM = parseInt(process.env.EMBED_RPM || "6", 10);    // Muito conservador
const EMBED_DIMENSIONS = parseInt(process.env.EMBED_DIMENSIONS || "768", 10);

// Mapear nomes de modelo válidos
const VALID_MODELS = {
  'gemini-2.5-flash-lite': 'gemini-2.5-flash',
  'gemini-2.5-flash': 'gemini-2.5-flash', 
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-1.5-flash': 'gemini-1.5-flash',
  'gemini-1.5-pro': 'gemini-1.5-pro'
};

const genLimiter = new RateLimiter({ maxPerMinute: GEMINI_RPM, maxPerDay: GEMINI_RPD });
const embedLimiter = new RateLimiter({ maxPerMinute: EMBED_RPM, maxPerDay: GEMINI_RPD });

// -------- Funções de embedding --------

// Função para gerar embeddings com dimensionalidade específica
async function generateEmbedding(text) {
  return embedLimiter.schedule(() =>
    withBackoff(async () => {
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
        const result = await model.embedContent(text);
        let embedding = result.embedding.values;
        
        // Truncar para 768 dimensões para compatibilidade
        if (embedding.length > EMBED_DIMENSIONS) {
          console.log(`Truncando embedding de ${embedding.length} para ${EMBED_DIMENSIONS} dimensões`);
          embedding = embedding.slice(0, EMBED_DIMENSIONS);
        }
        
        // Padding se necessário
        while (embedding.length < EMBED_DIMENSIONS) {
          embedding.push(0);
        }
        
        console.log(`Embedding processado com ${embedding.length} dimensões`);
        return embedding;
        
      } catch (error) {
        console.error('Erro ao gerar embedding:', error);
        throw error;
      }
    })
  );
}

// Função de busca semântica
async function performSemanticSearch(query, k = 4) {
  try {
    console.log(`Buscando por: "${query}"`);
    
    // Gera embedding da query
    const queryEmbedding = await generateEmbedding(query);
    console.log(`Embedding gerado com ${queryEmbedding.length} dimensões`);
    
    // Busca usando RPC com dimensão correta
    const { data, error } = await supabaseClient.rpc('match_documents', {
      query_embedding: queryEmbedding,
      match_threshold: 0.3,
      match_count: k
    });

    if (error) {
      console.error('Erro na busca semântica:', error);
      return await fallbackTextSearch(query, k);
    }

    if (!data || data.length === 0) {
      console.log('Nenhum documento encontrado via RPC, usando fallback');
      return await fallbackTextSearch(query, k);
    }

    console.log(`Encontrados ${data.length} documentos via busca vetorial`);
    return data.map(doc => ({
      content: doc.content || '',
      metadata: doc.metadata || {},
      similarity: doc.similarity || 0.5
    }));

  } catch (error) {
    console.error('Erro no semantic search:', error);
    return await fallbackTextSearch(query, k);
  }
}

// Fallback para busca textual
async function fallbackTextSearch(query, k = 4) {
  try {
    const { data, error } = await supabaseClient
      .from('documents')
      .select('*')
      .textSearch('content', query.replace(/['"]/g, ''))
      .limit(k);

    if (!error && data && data.length > 0) {
      console.log(`Fallback: encontrados ${data.length} documentos por busca textual`);
      return data.map(doc => ({
        content: doc.content || doc.page_content || '',
        metadata: doc.metadata || {},
        similarity: 0.4
      }));
    }

    // Se ainda não encontrar, pegar documentos aleatórios
    const { data: allDocs } = await supabaseClient
      .from('documents')
      .select('*')
      .limit(k);

    return (allDocs || []).map(doc => ({
      content: doc.content || doc.page_content || '',
      metadata: doc.metadata || {},
      similarity: 0.2
    }));

  } catch (error) {
    console.error('Erro no fallback:', error);
    return [];
  }
}

// Função para geração de texto com modelo válido
async function generateWithGemini(finalPrompt) {
  return genLimiter.schedule(() =>
    withBackoff(async () => {
      const configuredModel = process.env.MODEL || 'gemini-2.5-flash';
      const validModel = VALID_MODELS[configuredModel] || 'gemini-2.5-flash';
      
      console.log(`Usando modelo: ${validModel} (configurado: ${configuredModel})`);
      
      const model = genAI.getGenerativeModel({ model: validModel });
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

// Chat único
app.post('/api/chatbot', async (req, res) => {
  const { message, dbData } = req.body;
  
  try {
    console.log(`Processando mensagem: "${message}"`);
    
    // RAG usando busca vetorial
    const retrievedDocs = await performSemanticSearch(message, 4);
    const retrievedKnowledge = retrievedDocs
      .map(doc => doc.content)
      .filter(content => content && content.trim().length > 0)
      .join('\n\n');

    console.log(`Contexto recuperado: ${retrievedKnowledge.length} caracteres`);

    // Prompt final
    const finalPrompt = masterPromptTemplate
      .replace('{retrieved_knowledge}', retrievedKnowledge || 'Nenhum contexto específico encontrado.')
      .replace('{db_data}', JSON.stringify(dbData || {}, null, 2))
      .replace('{input}', message);

    const text = await generateWithGemini(finalPrompt);
    res.json({ success: true, response: text });
    
  } catch (error) {
    console.error("Erro no endpoint do chatbot:", error);
    res.status(500).json({ 
      success: false, 
      message: error.message,
      details: 'Erro no processamento da mensagem'
    });
  }
});

// Chat em lote
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
        const retrievedDocs = await performSemanticSearch(msg, 4);
        const retrievedKnowledge = retrievedDocs
          .map(doc => doc.content)
          .filter(content => content && content.trim().length > 0)
          .join('\n\n');

        const finalPrompt = masterPromptTemplate
          .replace('{retrieved_knowledge}', retrievedKnowledge || 'Nenhum contexto específico encontrado.')
          .replace('{db_data}', JSON.stringify(dbData || {}, null, 2))
          .replace('{input}', msg);

        const text = await generateWithGemini(finalPrompt);
        results.push({ input: msg, response: text, success: true });
        
      } catch (error) {
        console.error(`Erro processando mensagem "${msg}":`, error);
        results.push({ 
          input: msg, 
          response: `Erro ao processar: ${error.message}`, 
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
    const embedding = await generateEmbedding(text || "teste de embedding");
    res.json({ 
      success: true, 
      embedding: embedding.slice(0, 5),
      dimensions: embedding.length,
      expectedDimensions: EMBED_DIMENSIONS,
      message: `Embedding gerado com sucesso! ${embedding.length} dimensões`
    });
  } catch (error) {
    console.error("Erro no teste de embedding:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Endpoint para verificar estrutura da tabela documents
app.get('/api/check-documents', async (req, res) => {
  try {
    const { data, error } = await supabaseClient
      .from('documents')
      .select('*')
      .limit(1);
    
    if (error) {
      return res.json({ 
        success: false, 
        error: error.message,
        suggestion: 'Verifique se a tabela "documents" existe no Supabase'
      });
    }
    
    res.json({ 
      success: true, 
      sampleDocument: data[0] || null,
      documentCount: data.length,
      configuredDimensions: EMBED_DIMENSIONS,
      validModels: Object.keys(VALID_MODELS),
      currentModel: process.env.MODEL || 'gemini-2.5-flash',
      message: data.length > 0 ? 'Tabela encontrada com dados' : 'Tabela existe mas está vazia'
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
  console.log(`Servidor backend rodando na porta ${port}`);
  console.log(`Usando modelo: ${VALID_MODELS[process.env.MODEL || 'gemini-2.5-flash']}`);
  console.log(`Embeddings: gemini-embedding-001 com ${EMBED_DIMENSIONS} dimensões`);
  console.log(`Rate limits: ${EMBED_RPM} RPM embeddings, ${GEMINI_RPM} RPM geração`);
});
