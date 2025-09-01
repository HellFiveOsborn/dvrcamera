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
            // Input com tratamento de erros H264
            '-rtsp_transport', 'tcp',
            '-rtsp_flags', 'prefer_tcp',
            '-analyzeduration', '1000000',
            '-probesize', '1000000',
            '-err_detect', 'ignore_err',  // Ignorar erros de decodificação
            '-fflags', '+nobuffer+genpts+igndts+discardcorrupt',
            '-flags', 'low_delay',
            '-i', this.rtspUrl,
            
            // Mapear streams explicitamente
            '-map', '0:v:0',    // Primeiro stream de vídeo
            '-map', '0:a?',     // Áudio se disponível
            
            // Output - MPEG1 Video para JSMpeg
            '-f', 'mpegts',
            '-codec:v', 'mpeg1video',
            '-b:v', '800k',  // Bitrate de vídeo
            '-r', '25',       // 25fps
            '-s', '640x480',
            '-bf', '0',
            
            // Áudio MP2 (compatível com JSMpeg)
            '-codec:a', 'mp2',
            '-b:a', '128k',    // Bitrate aumentado para melhor qualidade
            '-ar', '44100',    // Sample rate padrão
            '-ac', '2',        // Stereo para melhor qualidade
            '-muxdelay', '0.001',
            
            // Flags de baixa latência
            '-strict', 'experimental',
            '-max_delay', '0',
            '-max_interleave_delta', '0',
            '-avoid_negative_ts', 'make_zero',
            
            // Output para pipe
            'pipe:1'
        ];

        this.ffmpegProcess = spawn('ffmpeg', args, {
            // Configurações do processo
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false
        });

        // Enviar dados para todos os clientes WebSocket
        this.ffmpegProcess.stdout.on('data', (data) => {
            this.broadcast(data);
        });

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            // Filtrar apenas erros críticos (ignorar warnings de H264)
            if (message.includes('error') &&
                !message.includes('decode_slice_header') &&
                !message.includes('Missing reference picture')) {
                console.error('[FFmpeg Error]:', message.trim());
            }
        });

        this.ffmpegProcess.on('error', (error) => {
            console.error('[FFmpeg] Erro ao iniciar processo:', error);
            this.ffmpegProcess = null;
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[FFmpeg] Processo encerrado com código ${code}`);
            this.ffmpegProcess = null;
            
            // Reiniciar automaticamente se houver clientes conectados
            if (this.clients.size > 0 && this.running) {
                console.log('[FFmpeg] Reiniciando stream em 2 segundos...');
                setTimeout(() => {
                    if (this.clients.size > 0 && this.running) {
                        this.startFFmpegStream();
                    }
                }, 2000);
            }
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