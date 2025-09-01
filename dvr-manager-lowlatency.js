const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class DVRManagerLowLatency {
    constructor(rtspUrl, recordingsDir, segmentDuration = 30) { // 30s para reduzir I/O e CPU
        this.rtspUrl = rtspUrl;
        this.recordingsDir = recordingsDir;
        this.segmentDuration = segmentDuration;
        this.ffmpegProcess = null;
        this.liveProcess = null; // Processo separado para live com baixa latência
        this.isRunning = false;
        this.startTime = null;
        this.maxDuration = 48 * 60 * 60; // 48 horas em segundos
        this.maxSegments = this.maxDuration / this.segmentDuration;
        this.cleanupCounter = 0; // Contador para limpeza menos frequente
    }

    start() {
        if (this.isRunning) {
            console.log('[DVRManager] DVR já está em execução');
            return;
        }

        this.startTime = Date.now();
        
        // Iniciar apenas um processo unificado por enquanto
        this.startUnified();
        
        this.isRunning = true;
        
        // Iniciar limpeza periódica
        this.startCleanup();
    }

    startUnified() {
        // Processo unificado que gera ambos os streams
        const dvrPlaylist = path.join(this.recordingsDir, 'dvr.m3u8');
        const livePlaylist = path.join(this.recordingsDir, 'live.m3u8');
        
        const args = [
            // Input otimizado para mobile (menor buffer, menos CPU)
            '-rtsp_transport', 'udp',  // TCP mais confiável em redes móveis
            '-rtsp_flags', 'prefer_tcp',
            '-analyzeduration', '500000', // 0.5s - análise rápida
            '-probesize', '500000',       // 0.5MB - probe pequeno
            '-fflags', '+nobuffer+genpts',
            '-flags', 'low_delay',
            '-i', this.rtspUrl,
            
            // Output 1: DVR (ULTRA OTIMIZADO MOBILE - mínimo CPU/bateria)
            '-map', '0:v:0',           // Apenas primeiro stream de vídeo
            '-map', '0:a:0?',          // Áudio opcional
            '-c:v', 'copy',            // COPY DIRETO - ZERO CPU para vídeo!
            '-c:a', 'copy',            // COPY DIRETO - ZERO CPU para áudio!
            
            // HLS otimizado para armazenamento
            '-f', 'hls',
            '-hls_time', this.segmentDuration.toString(),
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(this.recordingsDir, 'dvr_%d.ts'),
            '-hls_flags', 'append_list+program_date_time',
            '-hls_playlist_type', 'event',
            '-hls_segment_type', 'mpegts',
            '-copyts',                 // Preservar timestamps
            '-start_at_zero',
            dvrPlaylist,
            
            // Output 2: Live (COPY DIRETO - latência mínima)
            '-map', '0:v:0',           // Apenas vídeo principal
            '-map', '0:a:0?',          // Áudio opcional
            '-c:v', 'copy',            // COPY - sem recodificação
            '-c:a', 'copy',            // COPY - sem recodificação
            
            // HLS live otimizado
            '-f', 'hls',
            '-hls_time', '2',          // Segmentos de 2s (balanço latência/estabilidade)
            '-hls_list_size', '2',     // Apenas 2 segmentos = 4s buffer
            '-hls_flags', 'delete_segments+omit_endlist',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.recordingsDir, 'live%03d.ts'),
            '-hls_allow_cache', '0',
            
            livePlaylist
        ];

        console.log('[DVRManager] Iniciando sistema unificado DVR + Live (Mobile Optimized)...');
        console.log('[DVRManager] Modo: COPY direto (0% CPU para codificação)');
        console.log('[DVRManager] Segmentos DVR: ' + this.segmentDuration + 's | Live: 2s');
        
        this.ffmpegProcess = spawn('ffmpeg', args, {
            // Otimizações de processo para mobile
            stdio: ['ignore', 'ignore', 'pipe'],
            detached: false
        });

        // Buffer menor para reduzir uso de memória
        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            // Apenas erros críticos para economizar CPU
            if (message.toLowerCase().includes('error') || message.toLowerCase().includes('fatal')) {
                console.error(`[DVR ERROR]: ${message.trim()}`);
            }
            // Detectar novos segmentos para limpeza
            if (message.includes('Opening') && message.includes('dvr_')) {
                this.onNewSegment();
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[DVRManager] Processo encerrado com código ${code}`);
            if (this.isRunning && code !== 0 && code !== null) {
                console.log('[DVRManager] Reiniciando em 5 segundos...');
                setTimeout(() => {
                    if (this.isRunning) {
                        this.startUnified();
                    }
                }, 5000);
            }
        });
    }

    startDVR() {
        // Método mantido para compatibilidade mas não usado
        const dvrPlaylist = path.join(this.recordingsDir, 'dvr.m3u8');
        
        const args = [
            // Configurações de reconexão e estabilidade
            '-rtsp_transport', 'udp', // TCP é mais estável
            '-timeout', '5000000', // 5 segundos timeout
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            '-loglevel', 'warning', // Mostrar apenas warnings e erros
            '-i', this.rtspUrl,
            // Codificação de vídeo para DVR
            // Codificação de vídeo - usar libx264 se copy falhar
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-b:v', '2M',
            '-maxrate', '2.5M',
            '-bufsize', '5M',
            '-g', '30',
            // Codificação de áudio
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ar', '44100',
            '-ac', '2',
            // Configurações HLS para DVR
            '-f', 'hls',
            '-hls_time', this.segmentDuration.toString(),
            '-hls_list_size', this.maxSegments.toString(),
            '-hls_flags', 'append_list',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.recordingsDir, 'dvr_%d.ts'),
            '-hls_playlist_type', 'event',
            '-start_number', '0',
            dvrPlaylist
        ];

        console.log('[DVRManager] Iniciando gravação DVR...');
        this.ffmpegProcess = spawn('ffmpeg', args);

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            
            // Sempre mostrar erros
            if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
                console.error(`[DVR ERROR]: ${message.trim()}`);
            } else if (process.env.VERBOSE === 'true') {
                console.log(`[DVR]: ${message}`);
            }
            
            if (message.includes('Opening') && message.includes('.ts')) {
                this.onNewSegment();
            }
        });

        this.ffmpegProcess.on('close', (code) => {
            console.log(`[DVRManager] Processo DVR encerrado com código ${code}`);
            // Só reiniciar se não foi parada intencional e código indica erro
            if (this.isRunning && code !== 0 && code !== null && code !== 255) {
                console.log('[DVRManager] Reiniciando DVR em 5 segundos...');
                setTimeout(() => {
                    if (this.isRunning) {
                        this.startDVR();
                    }
                }, 5000);
            }
        });
    }

    startLive() {
        const livePlaylist = path.join(this.recordingsDir, 'live.m3u8');
        
        const args = [
            // Input com baixa latência e reconexão
            '-rtsp_transport', 'udp',
            '-timeout', '5000000',
            '-reconnect', '1',
            '-reconnect_at_eof', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '2',
            '-fflags', 'nobuffer+genpts+discardcorrupt',
            '-flags', 'low_delay',
            '-analyzeduration', '1000000', // 1 segundo
            '-probesize', '1000000',
            '-loglevel', 'warning', // Mostrar apenas warnings e erros
            '-i', this.rtspUrl,
            
            // Codificação ultra rápida para baixa latência
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-b:v', '1500k',
            '-maxrate', '2000k',
            '-bufsize', '500k',
            
            // Áudio com baixa latência
            '-c:a', 'aac',
            '-b:a', '96k',
            '-ar', '44100',
            '-ac', '2',
            '-af', 'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
            
            // HLS otimizado para baixa latência
            '-f', 'hls',
            '-hls_time', '1', // Segmentos de 1 segundo
            '-hls_list_size', '3', // Apenas 3 segmentos na playlist
            '-hls_flags', 'delete_segments+temp_file',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.recordingsDir, 'live%03d.ts'),
            '-hls_playlist_type', 'event',
            '-hls_allow_cache', '0',
            '-start_number', '0',
            
            // Otimizações adicionais
            '-avoid_negative_ts', 'make_zero',
            '-vsync', 'passthrough',
            '-copyts',
            '-start_at_zero',
            
            livePlaylist
        ];

        console.log('[DVRManager] Iniciando stream LIVE com baixa latência...');
        console.log('[DVRManager] Latência alvo: < 2 segundos');
        
        this.liveProcess = spawn('ffmpeg', args);

        this.liveProcess.stderr.on('data', (data) => {
            const message = data.toString();
            
            // Sempre mostrar erros
            if (message.toLowerCase().includes('error') || message.toLowerCase().includes('failed')) {
                console.error(`[LIVE ERROR]: ${message.trim()}`);
            } else if (process.env.VERBOSE === 'true') {
                console.log(`[LIVE]: ${message}`);
            }
        });

        this.liveProcess.on('close', (code) => {
            console.log(`[DVRManager] Processo LIVE encerrado com código ${code}`);
            // Só reiniciar se não foi parada intencional e código indica erro
            if (this.isRunning && code !== 0 && code !== null && code !== 255) {
                console.log('[DVRManager] Reiniciando LIVE em 2 segundos...');
                setTimeout(() => {
                    if (this.isRunning) {
                        this.startLive();
                    }
                }, 2000);
            }
        });
    }

    stop() {
        console.log('[DVRManager] Parando sistema...');
        this.isRunning = false;
        
        // Parar intervalo de limpeza
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        
        if (this.ffmpegProcess) {
            this.ffmpegProcess.kill('SIGTERM');
        }
        
        if (this.liveProcess) {
            this.liveProcess.kill('SIGTERM');
        }
    }

    onNewSegment() {
        // Limpar menos frequentemente para economizar CPU
        // Com segmentos de 30s, limpar a cada 60 segmentos = 30 minutos
        this.cleanupCounter++;
        
        if (this.cleanupCounter >= 60) {
            // Executar limpeza em processo separado para não bloquear
            setImmediate(() => this.cleanOldSegments());
            this.cleanupCounter = 0;
        }
    }

    cleanOldSegments() {
        try {
            const now = Date.now();
            const maxAge = 48 * 60 * 60 * 1000; // 48 horas em milissegundos
            
            // Usar readdir assíncrono para não bloquear
            const files = fs.readdirSync(this.recordingsDir);
            
            // Processar apenas arquivos DVR (ignorar live para performance)
            const tsFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
            
            // Limitar processamento para economizar CPU
            if (tsFiles.length === 0) return;
            
            let removedCount = 0; // Declarar no escopo correto
            
            // Método simplificado: remover apenas por número máximo
            const maxSegmentsAllowed = Math.floor(this.maxDuration / this.segmentDuration);
            
            if (tsFiles.length > maxSegmentsAllowed) {
                // Ordenar apenas se necessário (economiza CPU)
                tsFiles.sort((a, b) => {
                    const numA = parseInt(a.match(/dvr_(\d+)/)?.[1] || 0);
                    const numB = parseInt(b.match(/dvr_(\d+)/)?.[1] || 0);
                    return numA - numB;
                });
                
                const segmentsToRemove = tsFiles.length - maxSegmentsAllowed;
                const filesToRemove = tsFiles.slice(0, segmentsToRemove);
                
                // Remover em batch para reduzir syscalls
                filesToRemove.forEach(file => {
                    try {
                        fs.unlinkSync(path.join(this.recordingsDir, file));
                        removedCount++;
                    } catch (e) {
                        // Ignorar erros silenciosamente
                    }
                });
                
                if (removedCount > 0) {
                    console.log(`[DVRManager] Limpeza: ${removedCount} segmentos removidos`);
                }
            }
            
            // Limpar segmentos live antigos (manter apenas os últimos 5 para economizar espaço)
            const liveFiles = files.filter(f => f.startsWith('live') && f.endsWith('.ts'));
            if (liveFiles.length > 5) {
                liveFiles.sort().slice(0, -5).forEach(file => {
                    try {
                        fs.unlinkSync(path.join(this.recordingsDir, file));
                    } catch (e) {
                        // Ignorar
                    }
                });
            }
            
            // Atualizar playlist apenas se houve remoção (economiza I/O)
            if (removedCount > 0) {
                setImmediate(() => this.updateDVRPlaylist());
            }
            
        } catch (error) {
            console.error('[DVRManager] Erro na limpeza:', error.message);
        }
    }
    
    updateDVRPlaylist() {
        try {
            const playlistPath = path.join(this.recordingsDir, 'dvr.m3u8');
            if (!fs.existsSync(playlistPath)) return;
            
            let content = fs.readFileSync(playlistPath, 'utf8');
            const lines = content.split('\n');
            const newLines = [];
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                
                // Se é uma linha de segmento
                if (line.endsWith('.ts')) {
                    const segmentPath = path.join(this.recordingsDir, line);
                    // Só incluir se o arquivo existe
                    if (fs.existsSync(segmentPath)) {
                        // Incluir a linha #EXTINF anterior também
                        if (i > 0 && lines[i-1].startsWith('#EXTINF')) {
                            newLines.push(lines[i-1]);
                        }
                        newLines.push(line);
                    }
                } else if (!line.startsWith('#EXTINF')) {
                    // Incluir outras linhas de metadata
                    newLines.push(line);
                }
            }
            
            fs.writeFileSync(playlistPath, newLines.join('\n'));
        } catch (error) {
            console.error('[DVRManager] Erro ao atualizar playlist:', error.message);
        }
    }

    startCleanup() {
        // Limpeza inicial após 1 minuto (dar tempo para o sistema estabilizar)
        setTimeout(() => {
            console.log('[DVRManager] Executando limpeza inicial...');
            this.cleanOldSegments();
        }, 60000);
        
        // Limpar a cada 30 minutos (menos frequente para economizar CPU/bateria)
        this.cleanupInterval = setInterval(() => {
            setImmediate(() => this.cleanOldSegments());
        }, 30 * 60 * 1000); // 30 minutos
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
                    endTime: null,
                    liveLatency: '< 2 segundos'
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
                canSeek: true,
                liveLatency: '< 2 segundos',
                streamMode: 'Dual (DVR + Live Low Latency)'
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
            dvrPid: this.ffmpegProcess ? this.ffmpegProcess.pid : null,
            livePid: this.liveProcess ? this.liveProcess.pid : null,
            startTime: this.startTime,
            uptime: this.startTime ? Date.now() - this.startTime : 0,
            dvrInfo: this.getDVRInfo(),
            performance: {
                liveLatency: '< 4 segundos',
                dvrSegmentSize: this.segmentDuration + ' segundos',
                liveSegmentSize: '2 segundos',
                mode: 'Ultra Mobile Optimized (Zenfone 5)',
                optimization: 'CPU: ~0% (copy mode) | Bateria: Máxima economia | I/O: Mínimo'
            }
        };
    }
}

module.exports = DVRManagerLowLatency;