const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class StreamManager {
    constructor(rtspUrl, recordingsDir) {
        this.rtspUrl = rtspUrl;
        this.recordingsDir = recordingsDir;
        this.streamProcess = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) {
            console.log('[StreamManager] Streaming já está em execução');
            return;
        }

        const args = [
            '-rtsp_transport', 'udp',
            '-i', this.rtspUrl,
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-b:v', '2M',
            '-maxrate', '2M',
            '-bufsize', '4M',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '16000',  // Taxa de amostragem detectada
            '-ac', '1',       // Mono detectado
            '-f', 'hls',
            '-hls_time', '10',
            '-hls_list_size', '6',
            '-hls_flags', 'delete_segments',
            '-hls_segment_filename', path.join(this.recordingsDir, 'live%03d.ts'),
            path.join(this.recordingsDir, 'live.m3u8')
        ];

        console.log('[StreamManager] Iniciando streaming ao vivo...');
        this.streamProcess = spawn('ffmpeg', args);
        this.isRunning = true;

        this.streamProcess.stdout.on('data', (data) => {
            if (process.env.DEBUG) {
                console.log(`[StreamManager stdout]: ${data}`);
            }
        });

        this.streamProcess.stderr.on('data', (data) => {
            if (process.env.VERBOSE) {
                console.error(`[StreamManager stderr]: ${data}`);
            }
        });

        this.streamProcess.on('close', (code) => {
            console.log(`[StreamManager] Processo de streaming encerrado com código ${code}`);
            this.isRunning = false;
            
            // Reiniciar automaticamente após 5 segundos
            if (code !== 0) {
                console.log('[StreamManager] Reiniciando streaming em 5 segundos...');
                setTimeout(() => this.start(), 5000);
            }
        });

        this.streamProcess.on('error', (error) => {
            console.error('[StreamManager] Erro ao iniciar streaming:', error);
            this.isRunning = false;
        });
    }

    stop() {
        if (this.streamProcess && this.isRunning) {
            console.log('[StreamManager] Parando streaming...');
            this.streamProcess.kill('SIGTERM');
            this.isRunning = false;
        }
    }

    restart() {
        console.log('[StreamManager] Reiniciando streaming...');
        this.stop();
        setTimeout(() => this.start(), 2000);
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            pid: this.streamProcess ? this.streamProcess.pid : null
        };
    }
}

module.exports = StreamManager;