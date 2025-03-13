const express = require('express');
const { Client } = require('pg');
const cors = require('cors');
require('dotenv').config();

const app = express();
const port = 3001;

// Middleware para permitir requisições do frontend
app.use(cors());
app.use(express.json());

app.post('/api/test-connection', async (req, res) => {
    const { user, host, database, password, port } = req.body;

    // Cria um novo cliente com as credenciais fornecidas
    const tempClient = new Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_DATABASE,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });

    try {
        await tempClient.connect(); // Tenta conectar
        await tempClient.end(); // Fecha a conexão
        res.json({ success: true, message: 'Conexão bem-sucedida!' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/query', async (req, res) => {
    const { user, host, database, password, port, tables } = req.body;

    // Cria um novo cliente com as credenciais fornecidas
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

// Iniciar o servidor
app.listen(port, () => {
    console.log(`Servidor backend rodando em http://localhost:${port}`);
});