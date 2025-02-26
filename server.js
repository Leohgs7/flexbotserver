const express = require('express');
const { Client } = require('pg');
const cors = require('cors');

const app = express();
const port = 3000;

// Configuração do PostgreSQL
const client = new Client({
    user: 'postgres',
    host: 'localhost',
    database: 'LeoDB',
    password: 'postgres',
    port: 5432,
});

// Conectar ao banco de dados
client.connect()
    .then(() => console.log('Conectado ao PostgreSQL'))
    .catch(err => console.error('Erro ao conectar ao PostgreSQL:', err));

// Middleware para permitir requisições do frontend
app.use(cors());
app.use(express.json());

// Rota para consultar dados do banco de dados
app.get('/api/data', async (req, res) => {
    try {
        // Consulta todas as tabelas (substitua pelos nomes reais das tabelas)
        const tables = ['public.entrada', 'public.saida', 'public.estado'];
        const data = {};

        for (const table of tables) {
            const result = await client.query(`SELECT * FROM ${table}`);
            data[table] = result.rows;
        }

        res.json(data); // Retorna os dados como JSON
    } catch (error) {
        console.error('Erro ao consultar o banco de dados:', error);
        res.status(500).json({ error: 'Erro ao consultar o banco de dados' });
    }
});


// Rota para consultar dados do banco de dados
app.get('/api/commands', async (req, res) => {
    try {
        // Consulta todas as tabelas (substitua pelos nomes reais das tabelas)
        const tables = ['public.commands_base'];
        const data = {};

        for (const table of tables) {
            const result = await client.query(`SELECT * FROM ${table}`);
            data[table] = result.rows;
        }

        res.json(data); // Retorna os dados como JSON
    } catch (error) {
        console.error('Erro ao consultar o commands', error);
        res.status(500).json({ error: 'Erro ao consultar o Commands' });
    }
});


// Rota para consultar dados do banco de dados
app.get('/api/knowledge', async (req, res) => {
    try {
        // Consulta todas as tabelas (substitua pelos nomes reais das tabelas)
        const tables = ['public.knowledge_base'];
        const data = {};

        for (const table of tables) {
            const result = await client.query(`SELECT * FROM ${table}`);
            data[table] = result.rows;
        }

        res.json(data); // Retorna os dados como JSON
    } catch (error) {
        console.error('Erro ao consultar o knowledge:', error);
        res.status(500).json({ error: 'Erro ao consultar o knowledge' });
    }
});

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor backend rodando em http://localhost:${port}`);
});