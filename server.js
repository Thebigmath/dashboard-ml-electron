const express = require('express');
const path = require('path');
const fs = require('fs');

const STORAGE = process.env.STORAGE_PATH || path.join(__dirname, 'storage');

const app = express();
let httpServer = null;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rotas API e Auth (sem autenticação)
app.use('/api', require('./routes/api'));
app.use('/auth', require('./routes/auth'));

// Dashboard principal (sem login)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/envio_full', (req, res) => res.sendFile(path.join(__dirname, 'public/envio_full.html')));
app.get('/valor_estoque', (req, res) => res.sendFile(path.join(__dirname, 'public/valor_estoque.html')));

// Arquivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

module.exports = {
    start: (port, cb) => {
        httpServer = app.listen(port, '127.0.0.1', cb);
    },
    stop: () => {
        if (httpServer) httpServer.close();
    }
};
