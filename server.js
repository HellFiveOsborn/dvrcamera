require('dotenv').config(); // load environment variables from .env file
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const config = require('./config');
const DVRManagerLowLatency = require('./dvr-manager-lowlatency');
const AuthManager = require('./auth-manager');
const RTSPWebSocketProxy = require('./rtsp-websocket-proxy');

// Criar diretório de gravações se não existir
const recordingsDir = path.resolve(config.paths.recordings);
if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
    console.log('[Server] Diretório de gravações criado:', recordingsDir);
}

// Inicializar Express
const app = express();
const server = http.createServer(app);

// Inicializar Auth Manager
const authManager = new AuthManager();

// Configurar sessões
app.use(session({
    store: new SQLiteStore({
        db: 'sessions.db',
        dir: './',
        table: 'sessions',
        ttl: parseInt(process.env.SESSION_MAX_AGE) || 2592000000 // 30 dias
    }),
    secret: process.env.SESSION_SECRET || 'default-secret-change-this',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false, // Mudar para true em produção com HTTPS
        httpOnly: true,
        maxAge: parseInt(process.env.SESSION_MAX_AGE) || 2592000000 // 30 dias
    }
}));

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (config.server.cors) {
    app.use(cors({
        credentials: true,
        origin: true
    }));
}

// Middleware de autenticação
function requireAuth(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    
    // Se for uma requisição AJAX, retornar 401
    if (req.xhr || req.headers.accept?.indexOf('json') > -1) {
        return res.status(401).json({ error: 'Não autenticado' });
    }
    
    // Caso contrário, redirecionar para login
    res.redirect('/login.html?redirect=' + encodeURIComponent(req.originalUrl));
}

// Rotas públicas (sem autenticação)
app.use('/login.html', express.static(path.join(config.paths.public, 'login.html')));

// Rotas de autenticação
app.post('/api/auth/login', async (req, res) => {
    const { username, password, remember } = req.body;
    
    try {
        const user = await authManager.validateUser(username, password);
        
        if (user) {
            // Criar sessão
            req.session.userId = user.id;
            req.session.username = user.username;
            req.session.loginTime = new Date();
            
            // Se "lembrar de mim", estender a sessão
            if (remember) {
                req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000; // 30 dias
            } else {
                req.session.cookie.maxAge = 24 * 60 * 60 * 1000; // 24 horas
            }
            
            // Log de acesso
            const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
            const userAgent = req.headers['user-agent'];
            await authManager.logAccess(user.id, 'login', ip, userAgent);
            
            res.json({
                success: true,
                user: {
                    id: user.id,
                    username: user.username,
                    email: user.email
                }
            });
        } else {
            res.status(401).json({
                success: false,
                message: 'Usuário ou senha incorretos'
            });
        }
    } catch (error) {
        console.error('[Auth] Erro no login:', error);
        res.status(500).json({
            success: false,
            message: 'Erro no servidor'
        });
    }
});

app.post('/api/auth/logout', (req, res) => {
    if (req.session.userId) {
        const userId = req.session.userId;
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
        const userAgent = req.headers['user-agent'];
        
        // Log de acesso
        authManager.logAccess(userId, 'logout', ip, userAgent);
        
        req.session.destroy((err) => {
            if (err) {
                console.error('[Auth] Erro ao destruir sessão:', err);
            }
        });
    }
    
    res.json({ success: true });
});

app.get('/api/auth/check', (req, res) => {
    if (req.session && req.session.userId) {
        res.json({
            authenticated: true,
            user: {
                id: req.session.userId,
                username: req.session.username
            }
        });
    } else {
        res.json({ authenticated: false });
    }
});

app.get('/api/auth/session', requireAuth, async (req, res) => {
    try {
        const user = await authManager.getUserById(req.session.userId);
        res.json({
            user: user,
            loginTime: req.session.loginTime,
            sessionExpiry: new Date(Date.now() + req.session.cookie.maxAge)
        });
    } catch (error) {
        res.status(500).json({ error: 'Erro ao obter informações da sessão' });
    }
});

// Aplicar autenticação para arquivos estáticos protegidos
app.use('/recordings', requireAuth, express.static(recordingsDir));
app.use('/dvr.html', requireAuth, express.static(path.join(config.paths.public, 'dvr.html')));
app.use('/dvr-websocket.html', requireAuth, express.static(path.join(config.paths.public, 'dvr-websocket.html')));

// Servir outros arquivos públicos (CSS, JS, etc)
app.use(express.static(path.resolve(config.paths.public)));

// Inicializar DVR Manager com baixa latência
const dvrManager = new DVRManagerLowLatency(config.camera.rtspUrl, recordingsDir, 10); // DVR com 10s, Live com 1s

// Inicializar WebSocket Proxy para ultra baixa latência
const wsProxy = new RTSPWebSocketProxy(config.camera.rtspUrl, 8081);

// Rotas da API (protegidas)
app.get('/api/status', requireAuth, (req, res) => {
    const status = dvrManager.getStatus();
    res.json({
        dvr: status,
        config: {
            rtspUrl: config.camera.rtspUrl.replace(/:[^:@]+@/, ':****@'),
            segmentDuration: 10,
            maxDuration: '48 horas',
            server: {
                port: config.server.port,
                cors: config.server.cors
            }
        }
    });
});

app.get('/api/dvr/info', requireAuth, (req, res) => {
    const info = dvrManager.getDVRInfo();
    res.json(info);
});

app.get('/api/health', requireAuth, (req, res) => {
    const status = dvrManager.getStatus();
    const isHealthy = status.isRunning;
    
    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        services: {
            dvr: status.isRunning ? 'up' : 'down'
        },
        dvrInfo: status.dvrInfo,
        timestamp: new Date().toISOString()
    });
});

app.post('/api/dvr/restart', requireAuth, (req, res) => {
    dvrManager.stop();
    setTimeout(() => {
        dvrManager.start();
    }, 2000);
    
    res.json({ 
        message: 'DVR reiniciado',
        timestamp: new Date().toISOString()
    });
});

app.get('/api/dvr/segments', requireAuth, (req, res) => {
    try {
        const files = fs.readdirSync(recordingsDir);
        const segments = files
            .filter(f => f.startsWith('dvr_') && f.endsWith('.ts'))
            .sort((a, b) => {
                const numA = parseInt(a.match(/dvr_(\d+)/)[1]);
                const numB = parseInt(b.match(/dvr_(\d+)/)[1]);
                return numA - numB;
            })
            .map(file => {
                const stats = fs.statSync(path.join(recordingsDir, file));
                return {
                    filename: file,
                    size: stats.size,
                    created: stats.birthtime,
                    modified: stats.mtime
                };
            });
        
        res.json({
            total: segments.length,
            segments: segments
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Rota para verificar disponibilidade do WebSocket
app.get('/api/ws/status', requireAuth, (req, res) => {
    res.json({
        available: wsProxy.isRunning(),
        url: `ws://${req.hostname}:8081`,
        clients: wsProxy.getClientCount(),
        transport: 'mpeg1video',
        latency: '< 1 segundo'
    });
});

// Rota principal
app.get('/', (req, res) => {
    if (req.session && req.session.userId) {
        res.redirect('/dvr-websocket.html');
    } else {
        res.redirect('/login.html');
    }
});

// Iniciar serviços
function startServices() {
    console.log('');
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║     SISTEMA DVR - ESTILO YOUTUBE v3.0     ║');
    console.log('╚═══════════════════════════════════════════╝');
    console.log('');
    console.log('[Server] Sistema DVR com timeline navegável + Live Ultra Low Latency');
    console.log('┌─────────────────────────────────────────────');
    console.log(`│ RTSP URL: ${config.camera.rtspUrl.replace(/:[^:@]+@/, ':****@')}`);
    console.log(`│ Transport: ${config.camera.rtspTransport}`);
    console.log(`│ Porta: ${config.server.port}`);
    console.log(`│ Segmentos DVR: 10 segundos`);
    console.log(`│ Segmentos Live: 1 segundo (baixa latência)`);
    console.log(`│ Latência alvo: < 2 segundos`);
    console.log(`│ Buffer máximo: 48 horas`);
    console.log(`│ Diretório: ${recordingsDir}`);
    console.log('└─────────────────────────────────────────────');
    console.log('');
    
    // Iniciar DVR
    console.log('[Server] Iniciando sistema DVR...');
    dvrManager.start();
    
    // Iniciar WebSocket Proxy
    console.log('[Server] Iniciando WebSocket Proxy para ultra baixa latência...');
    wsProxy.start();
    
    // Iniciar servidor HTTP
    server.listen(config.server.port, () => {
        console.log('');
        console.log('╔═══════════════════════════════════════════╗');
        console.log('║      SISTEMA DVR INICIADO COM SUCESSO      ║');
        console.log('╚═══════════════════════════════════════════╝');
        console.log('');
        console.log(`📺 Interface DVR: http://localhost:${config.server.port}/dvr-websocket.html`);
        console.log(`📊 API Status: http://localhost:${config.server.port}/api/status`);
        console.log(`💚 Health Check: http://localhost:${config.server.port}/api/health`);
        console.log(`📹 DVR Info: http://localhost:${config.server.port}/api/dvr/info`);
        console.log(`🚀 WebSocket Stream: ws://localhost:8081`);
        console.log('');
        console.log('⚡ Performance:');
        console.log('  • WebSocket Stream: < 1 segundo de latência (ultra baixa)');
        console.log('  • HLS Stream: < 2 segundos de latência (fallback)');
        console.log('  • DVR: Buffer de 48 horas');
        console.log('  • Dual Mode: Live + DVR simultâneos');
        console.log('');
        console.log('🎮 Controles DVR:');
        console.log('  • Clique na timeline para navegar');
        console.log('  • Botão "AO VIVO" para voltar ao live');
        console.log('  • Botões de atalho para voltar no tempo');
        console.log('  • Buffer de até 48 horas disponível');
        console.log('');
        console.log('Pressione Ctrl+C para parar o sistema');
        console.log('');
    });
}

// Tratamento de encerramento gracioso
process.on('SIGINT', () => {
    console.log('\n');
    console.log('╔═══════════════════════════════════════════╗');
    console.log('║         ENCERRANDO SISTEMA DVR...          ║');
    console.log('╚═══════════════════════════════════════════╝');
    
    dvrManager.stop();
    wsProxy.stop();
    authManager.close();
    
    server.close(() => {
        console.log('[Server] Servidor HTTP encerrado');
        console.log('[Server] Sistema DVR encerrado com sucesso');
        console.log('');
        process.exit(0);
    });
    
    // Forçar saída após 5 segundos se não encerrar graciosamente
    setTimeout(() => {
        console.log('[Server] Forçando encerramento...');
        process.exit(1);
    }, 5000);
});

process.on('uncaughtException', (error) => {
    console.error('[Server] Erro não capturado:', error);
    if (config.logging.debug) {
        console.error(error.stack);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Server] Promise rejeitada não tratada:', reason);
    if (config.logging.debug) {
        console.error('Promise:', promise);
    }
});

// Iniciar tudo
startServices();