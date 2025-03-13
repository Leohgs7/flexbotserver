const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();
const apiKey = process.env.API_KEY;
const apiEndpoint = process.env.API_ENDPOINT;

const app = express();
const port = 3001;

// Middleware para permitir requisições do frontend
app.use(cors({
    origin: 'https://flexbotserver.onrender.com',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Endpoint para testar a conexão
app.post('/api/test-connection', async (req, res) => {
    const { user, host, database, password, port } = req.body;

    const tempClient = new Client({
        user,
        host,
        database,
        password,
        port,
    });

    try {
        await tempClient.connect();
        await tempClient.end();
        res.json({ success: true, message: 'Conexão bem-sucedida!' });
    } catch (error) {
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

app.post('/api/chatbot', async (req, res) => {
    const { message, dbData, FlexDocData, Flexsim_Commands } = req.body;

    try {
        const response = await fetch(`${apiEndpoint}?key=${apiKey}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [
                    {
                        parts: [
                            { text: 'Papel e Especialização: Você é um assistente virtual chamada Flex especializado em análise e interpretação de dados de simulação do FlexSim. Seu papel é o de um consultor expert em FlexSim, com profundo conhecimento da ferramenta e suas nuances.' },
                            { text: `Conhecimento Base: Você tem acesso a duas fontes de conhecimento essenciais, esses dados devem ser acessados quando o usuario realizar alguma pergunta tecnica do flexsim:
                            1. **Documentação Oficial FlexSim (FlexDocData):** ${JSON.stringify(FlexDocData)}
                            Utilize esta documentação para entender detalhes técnicos de funcionalidades, parâmetros e melhores práticas do FlexSim.`},
                            { text: `Documento de ajuda do Flexsim (Flexsim_Commands): ${JSON.stringify(Flexsim_Commands)}
                                - Este documento contem informações sobre todas as funções flexscript que podem ser usadas dentro do flexsim, explica como funciona e para que serve.`},
                            { text: `**Instruções de Análise:**
                                2. **Dados da Simulação (dbData):** ${JSON.stringify(dbData)}
                                - Caso seja perguntado algo sobre o desempenho ou funcionamento do modelo de simulação deve-se utilizar esses dados.
                                - Analise cuidadosamente esses dados da simulação, buscando padrões, gargalos, oportunidades de melhoria e outros insights relevantes.
                                - Considere todas as métricas disponíveis.`},
                            { text: `**Mensagem do Usuário:** ${message}` }
                        ]
                    }
                ]
            })
        });

        const data = await response.json();
        res.json({ success: true, response: data.candidates[0].content.parts[0].text });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor backend rodando em http://localhost:${port}`);
});
