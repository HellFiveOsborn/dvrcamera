const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

class RTSPWebSocketProxy {
    constructor(rtspUrl, port = 8081) {
        this.rtspUrl = rtspUrl;
        this.port = port;
        this.wss = null;
        this.ffmpegProcess = null;
        this.clients = new Set();
        this.running = false;
    }

    start() {
        // Criar servidor WebSocket
        this.wss = new WebSocket.Server({ port: this.port });
        this.running = true;
        console.log(`[WebSocket] Servidor iniciado na porta ${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('[WebSocket] Cliente conectado');
            this.clients.add(ws);

            // Iniciar stream se for o primeiro cliente
            if (this.clients.size === 1) {
                this.startFFmpegStream();
            }

            ws.on('close', () => {
                console.log('[WebSocket] Cliente desconectado');
                this.clients.delete(ws);

                // Parar stream se não houver mais clientes
                if (this.clients.size === 0) {
                    this.stopFFmpegStream();
                }
            });

            ws.on('error', (error) => {
                console.error('[WebSocket] Erro:', error);
                this.clients.delete(ws);
            });
        });
    }

    startFFmpegStream() {
        if (this.ffmpegProcess) return;

        console.log('[FFmpeg] Iniciando stream direto RTSP -> WebSocket');

        // FFmpeg para converter RTSP em MPEG1 Video (formato que funciona no browser)
        const args = [
            // Input
            '-rtsp_transport', 'tcp',
            '-i', this.rtspUrl,
            
            // Output - MPEG1 Video para JSMpeg
            '-f', 'mpegts',
            '-codec:v', 'mpeg1video',
            '-b:v', '1000k',
            '-r', '30',
            '-s', '640x480',
            '-bf', '0',
            
            // Áudio PCM
            '-codec:a', 'mp2',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '1',
            
            // Sem buffer, direto para stdout
            '-fflags', 'nobuffer',
            '-flags', 'low_delay',
            '-strict', 'experimental',
            '-max_delay', '0',
            '-max_interleave_delta', '0',
            
            // Output para pipe
            'pipe:1'
        ];

        this.ffmpegProcess = spawn('ffmpeg', args);

        // Enviar dados para todos os clientes WebSocket
        this.ffmpegProcess.stdout.on('data', (data) => {
            this.broadcast(data);
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.includes('error')) {
                console.error('[FFmpeg Error]:', message);
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[FFmpeg] Processo encerrado com código ${code}`);
            this.ffmpegProcess = null;
        });
    }

    stopFFmpegStream() {
        if (this.ffmpegProcess) {
            console.log('[FFmpeg] Parando stream');
            this.ffmpegProcess.kill('SIGTERM');
            this.ffmpegProcess = null;
        }
    }

    broadcast(data) {
        this.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(data, { binary: true });
            }
        });
    }
    
    isRunning() {
        return this.running;
    }
    
    getClientCount() {
        return this.clients.size;
    }

    stop() {
        this.running = false;
        this.stopFFmpegStream();
        if (this.wss) {
            this.wss.close();
        }
    }
}

module.exports = RTSPWebSocketProxy;