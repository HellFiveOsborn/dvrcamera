const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class DVRManager {
    constructor(rtspUrl, recordingsDir, segmentDuration = 10) {
        this.rtspUrl = rtspUrl;
        this.recordingsDir = recordingsDir;
        this.segmentDuration = segmentDuration; // Segmentos menores para DVR
        this.ffmpegProcess = null;
        this.isRunning = false;
        this.startTime = null;
        this.maxDuration = 48 * 60 * 60; // 48 horas em segundos
        this.maxSegments = this.maxDuration / this.segmentDuration;
    }

    start() {
        if (this.isRunning) {
            console.log('[DVRManager] DVR já está em execução');
            return;
        }

        this.startTime = Date.now();
        
        // Criar playlist DVR principal
        const dvrPlaylist = path.join(this.recordingsDir, 'dvr.m3u8');
        
        const args = [
            '-rtsp_transport', 'udp',
            '-i', this.rtspUrl,
            // Codificação de vídeo
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-b:v', '2M',
            '-maxrate', '2M',
            '-bufsize', '4M',
            '-g', '30', // GOP size
            // Codificação de áudio
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            // Configurações HLS para DVR
            '-f', 'hls',
            '-hls_time', this.segmentDuration.toString(),
            '-hls_list_size', this.maxSegments.toString(), // Manter todos os segmentos
            '-hls_flags', 'append_list', // Adicionar à lista ao invés de sobrescrever
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.recordingsDir, 'dvr_%d.ts'),
            '-hls_playlist_type', 'event', // Tipo evento permite DVR
            '-start_number', '0',
            dvrPlaylist
        ];

        console.log('[DVRManager] Iniciando sistema DVR...');
        console.log(`[DVRManager] Segmentos de ${this.segmentDuration} segundos`);
        console.log(`[DVRManager] Buffer máximo: 48 horas`);
        
        this.ffmpegProcess = spawn('ffmpeg', args);
        this.isRunning = true;

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (process.env.VERBOSE) {
                console.log(`[DVRManager]: ${message}`);
            }
            
            // Detectar quando novos segmentos são criados
            if (message.includes('Opening') && message.includes('.ts')) {
                this.onNewSegment();
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[DVRManager] Processo encerrado com código ${code}`);
            this.isRunning = false;
            
            if (code !== 0 && code !== null) {
                console.log('[DVRManager] Reiniciando em 5 segundos...');
                setTimeout(() => this.start(), 5000);
            }
        });

        // Iniciar limpeza periódica
        this.startCleanup();
    }

    stop() {
        if (this.ffmpegProcess && this.isRunning) {
            console.log('[DVRManager] Parando DVR...');
            this.ffmpegProcess.kill('SIGTERM');
            this.isRunning = false;
        }
    }

    onNewSegment() {
        // Atualizar playlist de live para apontar para o DVR
        this.updateLivePlaylist();
        
        // Limpar segmentos antigos
        this.cleanOldSegments();
    }

    updateLivePlaylist() {
        try {
            const livePlaylist = path.join(this.recordingsDir, 'live.m3u8');
            const dvrPlaylist = path.join(this.recordingsDir, 'dvr.m3u8');
            
            if (fs.existsSync(dvrPlaylist)) {
                // Ler playlist DVR
                const dvrContent = fs.readFileSync(dvrPlaylist, 'utf8');
                const lines = dvrContent.split('\n');
                
                // Pegar apenas os últimos segmentos para o "live"
                const segmentLines = [];
                let segmentCount = 0;
                const maxLiveSegments = 6; // Últimos 60 segundos
                
                for (let i = lines.length - 1; i >= 0 && segmentCount < maxLiveSegments; i--) {
                    const line = lines[i];
                    if (line.endsWith('.ts')) {
                        segmentLines.unshift(lines[i-1]); // EXTINF line
                        segmentLines.unshift(line); // .ts file
                        segmentCount++;
                        i--; // Skip EXTINF line in next iteration
                    }
                }
                
                // Criar playlist live
                const liveContent = [
                    '#EXTM3U',
                    '#EXT-X-VERSION:3',
                    `#EXT-X-TARGETDURATION:${this.segmentDuration}`,
                    '#EXT-X-MEDIA-SEQUENCE:0',
                    ...segmentLines,
                    ''
                ].join('\n');
                
                fs.writeFileSync(livePlaylist, liveContent);
            }
        } catch (error) {
            // Silenciar erros durante atualização
        }
    }

    cleanOldSegments() {
        try {
            const now = Date.now();
            const maxAge = 48 * 60 * 60 * 1000; // 48 horas
            
            const files = fs.readdirSync(this.recordingsDir);
            const tsFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
            
            tsFiles.forEach(file => {
                const filePath = path.join(this.recordingsDir, file);
                const stats = fs.statSync(filePath);
                const age = now - stats.mtimeMs;
                
                if (age > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`[DVRManager] Segmento antigo removido: ${file}`);
                }
            });
        } catch (error) {
            // Silenciar erros de limpeza
        }
    }

    startCleanup() {
        // Limpar a cada hora
        setInterval(() => {
            this.cleanOldSegments();
        }, 60 * 60 * 1000);
    }

    getDVRInfo() {
        try {
            const files = fs.readdirSync(this.recordingsDir);
            const tsFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
            
            if (tsFiles.length === 0) {
                return {
                    available: false,
                    duration: 0,
                    segments: 0,
                    startTime: null,
                    endTime: null
                };
            }
            
            // Ordenar por número do segmento
            tsFiles.sort((a, b) => {
                const numA = parseInt(a.match(/dvr_(\d+)/)[1]);
                const numB = parseInt(b.match(/dvr_(\d+)/)[1]);
                return numA - numB;
            });
            
            const firstFile = tsFiles[0];
            const lastFile = tsFiles[tsFiles.length - 1];
            
            const firstStats = fs.statSync(path.join(this.recordingsDir, firstFile));
            const lastStats = fs.statSync(path.join(this.recordingsDir, lastFile));
            
            const duration = tsFiles.length * this.segmentDuration;
            
            return {
                available: true,
                duration: duration,
                durationFormatted: this.formatDuration(duration),
                segments: tsFiles.length,
                startTime: firstStats.birthtime,
                endTime: lastStats.mtime,
                maxDuration: '48 horas',
                currentPosition: 'live',
                canSeek: true
            };
        } catch (error) {
            return {
                available: false,
                error: error.message
            };
        }
    }

    formatDuration(seconds) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = seconds % 60;
        
        if (hours > 0) {
            return `${hours}h ${minutes}m`;
        } else if (minutes > 0) {
            return `${minutes}m ${secs}s`;
        } else {
            return `${secs}s`;
        }
    }

    getStatus() {
        return {
            isRunning: this.isRunning,
            pid: this.ffmpegProcess ? this.ffmpegProcess.pid : null,
            startTime: this.startTime,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            dvrInfo: this.getDVRInfo()
        };
    }
}

module.exports = DVRManager;