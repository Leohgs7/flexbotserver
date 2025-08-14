// backend.js

const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();

// Dependências da IA e do Supabase
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { createClient } = require('@supabase/supabase-js');
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { SupabaseVectorStore } = require("@langchain/community/vectorstores/supabase");

// --- CONFIGURAÇÃO INICIAL ---
const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// Inicializa o cliente do Supabase uma única vez com as variáveis de ambiente
const supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// O "CÉREBRO" DA IA: O PROMPT MESTRE FINAL
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


// --- ENDPOINTS DA API ---

// Endpoint para testar a conexão com o banco de dados da simulação do usuário
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

// Endpoint principal do chatbot
app.post('/api/chatbot', async (req, res) => {
    const { message, dbData } = req.body;

    try {
        // --- ETAPA DE RAG (RETRIEVAL) ---
        // Conecta ao Vector Store no Supabase para fazer a busca de conhecimento técnico
        const embeddings = new GoogleGenerativeAIEmbeddings({ apiKey: process.env.API_KEY });
        const vectorStore = new SupabaseVectorStore(embeddings, {
            client: supabaseClient,
            tableName: 'documents',
            queryName: 'match_documents',
        });

        // Busca os documentos técnicos mais relevantes para a pergunta do usuário
        const retrievedDocs = await vectorStore.similaritySearch(message, 4); // Pega os 4 chunks mais relevantes
        const retrievedKnowledge = retrievedDocs.map(doc => doc.pageContent).join('\n\n');

        // --- ETAPA DE GERAÇÃO ---
        // Monta o prompt final com o contexto do RAG e os dados da simulação
        let finalPrompt = masterPromptTemplate
            .replace('{retrieved_knowledge}', retrievedKnowledge)
            .replace('{db_data}', JSON.stringify(dbData, null, 2)) // Formata o JSON para melhor leitura da IA
            .replace('{input}', message);
        
        // Chama a IA com o prompt enriquecido
        const genAI = new GoogleGenerativeAI(process.env.API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
        const result = await model.generateContent(finalPrompt);
        const response = await result.response;
        const text = response.text();

        res.json({ success: true, response: text });

    } catch (error) {
        console.error("Erro no endpoint do chatbot:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}. Conectado ao Supabase para RAG.`);
});