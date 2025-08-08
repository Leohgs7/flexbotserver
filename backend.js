const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();
const fetch = require('node-fetch');
const apiKey = process.env.API_KEY;
const apiEndpoint = process.env.API_ENDPOINT;

// Importações do LangChain e do Google GenAI
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MemoryVectorStore } = require("langchain/vectorstores/memory");
const { GoogleGenerativeAIEmbeddings } = require("@langchain/google-genai");
const { TaskType } = require("@google/generative-ai");
const { RecursiveCharacterTextSplitter } = require("langchain/text_splitter");

const app = express();
const port = 3001;

// Variável global para armazenar nosso índice de conhecimento (Vector Store)
let vectorStore; 

// Middleware
app.use(cors());
app.use(express.json());

// --- ENDPOINTS ORIGINAIS (SEM ALTERAÇÕES) ---

// Endpoint para testar a conexão com o banco de dados
app.post('/api/test-connection', async (req, res) => {
    const { user, host, database, password, port } = req.body;

    console.log('Credenciais recebidas:', { user, host, database, port }); // Log das credenciais

    const tempClient = new Client({
        user,
        host,
        database,
        password,
        port,
        ssl: {
        rejectUnauthorized: false, // Ignora a validação do certificado SSL
    },
    });

    try {
        console.log('Tentando conectar ao banco de dados...'); // Log de tentativa de conexão
        await tempClient.connect();
        console.log('Conexão bem-sucedida!'); // Log de sucesso
        await tempClient.end();
        res.json({ success: true, message: 'Conexão bem-sucedida!' });
    } catch (error) {
        console.error('Erro ao conectar ao banco de dados:', error); // Log de erro
        res.status(500).json({ success: false, message: error.message });
    }
});

// Endpoint para consultar tabelas
app.post('/api/query', async (req, res) => {
    const { user, host, database, password, port, tables } = req.body;

    const tempClient = new Client({
        user,
        host,
        database,
        password,
        port,
        ssl: {
        rejectUnauthorized: false, // Ignora a validação do certificado SSL
    },
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


// --- ENDPOINT DO CHATBOT COM LÓGICA RAG ---

app.post('/api/chatbot', async (req, res) => {
    const { message, dbData } = req.body;

    if (!vectorStore) {
        return res.status(500).json({ success: false, message: "O sistema RAG ainda não foi inicializado. Aguarde um momento e tente novamente." });
    }

    try {
        // 1. ETAPA DE RECUPERAÇÃO (RETRIEVAL)
        const relevantDocs = await vectorStore.similaritySearch(message, 5); // Busca os 5 chunks mais relevantes
        const context = relevantDocs.map(doc => doc.pageContent).join('\n\n');

        // 2. ETAPA DE GERAÇÃO AUMENTADA (AUGMENTED GENERATION)
        const prompt = `
            Você é um assistente virtual chamado Flex, especialista em FlexSim.
            
            Use o seguinte CONTEXTO TÉCNICO para responder a pergunta do usuário. Este contexto foi extraído da documentação oficial e de guias de comando. Se a resposta não estiver no contexto, diga que não encontrou a informação na sua base de conhecimento.
            
            CONTEXTO TÉCNICO:
            ---
            ${context}
            ---
            
            Se a pergunta for sobre desempenho ou funcionamento do modelo, analise os DADOS DA SIMULAÇÃO abaixo:
            DADOS DA SIMULAÇÃO: ${JSON.stringify(dbData)}
            
            PERGUNTA DO USUÁRIO: "${message}"
        `;
        
        const genAI = new GoogleGenerativeAI(process.env.API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        res.json({ success: true, response: text });

    } catch (error) {
        console.error("Erro no endpoint do chatbot:", error);
        res.status(500).json({ success: false, message: error.message });
    }
});


// --- FUNÇÃO DE INICIALIZAÇÃO DO RAG ---

const initializeRag = async () => {
    console.log("Inicializando o sistema RAG de forma dinâmica...");

    try {
        // --- ETAPA 1: BUSCAR ARQUIVOS DINAMICAMENTE DO GITHUB ---

        const owner = 'Leohgs7';
        const repo = 'flexbotserver';
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/`;

        console.log("Consultando a API do GitHub para listar arquivos...");
        const repoContentsResponse = await fetch(apiUrl, {
            headers: {
                // O token aumenta a confiabilidade e evita limites de acesso da API
                'Authorization': `token ${process.env.GITHUB_TOKEN}`
            }
        });

        if (!repoContentsResponse.ok) {
            throw new Error(`Falha ao listar arquivos do repositório: ${repoContentsResponse.statusText}`);
        }

        const repoContents = await repoContentsResponse.json();

        // Filtra para pegar apenas os arquivos que terminam com .json
        const jsonFiles = repoContents.filter(file => file.type === 'file' && file.name.endsWith('.json'));

        if (jsonFiles.length === 0) {
            throw new Error("Nenhum arquivo .json encontrado no repositório.");
        }

        console.log(`Encontrados ${jsonFiles.length} arquivos JSON. Buscando conteúdo...`);
        
        // Busca o conteúdo de todos os arquivos JSON em paralelo para mais eficiência
        const allKnowledgePromises = jsonFiles.map(file =>
            fetch(file.download_url).then(res => {
                if (!res.ok) throw new Error(`Falha ao baixar ${file.name}`);
                return res.json();
            })
        );
        
        const allKnowledgeObjects = await Promise.all(allKnowledgePromises);
        console.log("Todos os arquivos JSON foram carregados com sucesso!");

        // --- ETAPA 2: PROCESSAR E INDEXAR O CONTEÚDO (LÓGICA EXISTENTE) ---

        // Combina todo o conhecimento em um único texto, convertendo cada objeto JSON em string
        const allKnowledge = allKnowledgeObjects.map(obj => JSON.stringify(obj)).join("\n\n");

        // O resto do processo é exatamente o mesmo de antes
        const textSplitter = new RecursiveCharacterTextSplitter({
            chunkSize: 1000,
            chunkOverlap: 100,
        });
        const docs = await textSplitter.createDocuments([allKnowledge]);

        const embeddings = new GoogleGenerativeAIEmbeddings({
            apiKey: process.env.API_KEY,
            modelName: "embedding-001",
            taskType: TaskType.RETRIEVAL_DOCUMENT
        });

        vectorStore = await MemoryVectorStore.fromDocuments(docs, embeddings);

        console.log("Sistema RAG inicializado e pronto para uso com a base de conhecimento dinâmica!");

    } catch (error) {
        console.error("ERRO CRÍTICO: Falha ao inicializar o sistema RAG:", error);
    }
};


// --- INICIALIZAÇÃO DO SERVIDOR ---

app.listen(port, () => {
    console.log(`Servidor backend rodando na porta ${port}`);
    // Inicia o processo de carregar e indexar o conhecimento
    initializeRag();
});
