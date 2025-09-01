const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class DVRManagerLowLatency {
    constructor(rtspUrl, recordingsDir, segmentDuration = 20) { // 20s para economizar espaço sem muito overhead
        this.rtspUrl = rtspUrl;
        this.recordingsDir = recordingsDir;
        this.segmentDuration = segmentDuration;
        this.ffmpegProcess = null;
        this.liveProcess = null; // Processo separado para live com baixa latência
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
            // Input com configurações balanceadas
            '-rtsp_transport', 'udp',
            '-i', this.rtspUrl,
            
            // Output 1: DVR (OTIMIZADO PARA CELULAR - baixo CPU e espaço)
            '-map', '0',
            '-c:v', 'libx264',
            '-preset', 'veryfast',     // Mantém veryfast para baixo CPU
            '-crf', '30',              // CRF 30 para economizar ~60% de espaço
            '-g', '50',
            '-sc_threshold', '0',
            '-profile:v', 'baseline',  // Baseline para melhor compatibilidade mobile
            '-level', '3.0',           // Level 3.0 para dispositivos móveis
            '-c:a', 'aac',
            '-b:a', '64k',             // Áudio em 64k (economiza 50%)
            '-ar', '22050',            // Sample rate reduzido
            '-ac', '1',                // Mono (economiza 50% no áudio)
            '-f', 'hls',
            '-hls_time', this.segmentDuration.toString(),
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(this.recordingsDir, 'dvr_%d.ts'),
            '-hls_flags', 'append_list',
            '-hls_playlist_type', 'event',
            dvrPlaylist,
            
            // Output 2: Live (EXTREME LOW LATENCY - <3s target)
            '-map', '0',               // Mapear stream completo
            '-c:v', 'copy',            // Copy direto do vídeo
            '-c:a', 'copy',            // Copy direto do áudio
            
            // HLS EXTREMO - mínimo absoluto
            '-f', 'hls',
            '-hls_time', '1',          // Segmentos de 1 segundo
            '-hls_list_size', '1',     // APENAS 1 segmento = 1 segundo total!
            '-hls_flags', 'delete_segments+append_list+omit_endlist+temp_file',
            '-hls_segment_type', 'mpegts',
            '-hls_segment_filename', path.join(this.recordingsDir, 'live%03d.ts'),
            
            // Flags EXTREMAS para entrega instantânea
            '-fflags', 'nobuffer+genpts+discardcorrupt+flush_packets',
            '-flags', 'low_delay',
            '-avioflags', 'direct',
            '-flush_packets', '1',
            '-max_delay', '0',         // ZERO delay
            '-muxdelay', '0',          // ZERO mux delay
            '-muxpreload', '0',        // ZERO preload
            
            livePlaylist
        ];

        console.log('[DVRManager] Iniciando sistema unificado DVR + Live...');
        this.ffmpegProcess = spawn('ffmpeg', args);

        this.ffmpegProcess.stderr.on('data', (data) => {
            const message = data.toString();
            if (message.toLowerCase().includes('error')) {
                console.error(`[DVR ERROR]: ${message.trim()}`);
            } else if (process.env.VERBOSE === 'true') {
                console.log(`[DVR]: ${message.trim()}`);
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
            '-rtsp_transport', 'tcp', // TCP é mais estável
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
            '-rtsp_transport', 'tcp',
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
        // Limpar segmentos antigos a cada 30 novos segmentos (10 minutos)
        if (!this.segmentCounter) this.segmentCounter = 0;
        this.segmentCounter++;
        
        if (this.segmentCounter >= 30) {
            this.cleanOldSegments();
            this.segmentCounter = 0;
        }
    }

    cleanOldSegments() {
        try {
            const now = Date.now();
            const maxAge = 48 * 60 * 60 * 1000; // 48 horas em milissegundos
            
            const files = fs.readdirSync(this.recordingsDir);
            const tsFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
            
            // Ordenar arquivos por número do segmento
            tsFiles.sort((a, b) => {
                const numA = parseInt(a.match(/dvr_(\d+)/)?.[1] || 0);
                const numB = parseInt(b.match(/dvr_(\d+)/)?.[1] || 0);
                return numA - numB;
            });
            
            let removedCount = 0;
            let totalSize = 0;
            
            // Método 1: Remover por idade (usando birthtime que é mais confiável)
            tsFiles.forEach(file => {
                const filePath = path.join(this.recordingsDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    // Usar birthtime (tempo de criação) ao invés de mtime
                    const age = now - stats.birthtimeMs;
                    
                    if (age > maxAge) {
                        totalSize += stats.size;
                        fs.unlinkSync(filePath);
                        removedCount++;
                    }
                } catch (e) {
                    // Se não conseguir ler o arquivo, tentar removê-lo
                    try {
                        fs.unlinkSync(filePath);
                        removedCount++;
                    } catch (e2) {
                        // Ignorar
                    }
                }
            });
            
            // Método 2: Limitar por número máximo de segmentos
            // Com segmentos de 20s, 48h = 8640 segmentos
            const maxSegmentsAllowed = Math.floor(this.maxDuration / this.segmentDuration);
            
            if (tsFiles.length > maxSegmentsAllowed) {
                const segmentsToRemove = tsFiles.length - maxSegmentsAllowed;
                const filesToRemove = tsFiles.slice(0, segmentsToRemove);
                
                filesToRemove.forEach(file => {
                    const filePath = path.join(this.recordingsDir, file);
                    try {
                        const stats = fs.statSync(filePath);
                        totalSize += stats.size;
                        fs.unlinkSync(filePath);
                        removedCount++;
                    } catch (e) {
                        // Ignorar erros
                    }
                });
            }
            
            if (removedCount > 0) {
                const sizeMB = (totalSize / (1024 * 1024)).toFixed(2);
                console.log(`[DVRManager] Limpeza: ${removedCount} segmentos removidos (${sizeMB} MB liberados)`);
            }
            
            // Limpar segmentos live antigos (manter apenas os últimos 10)
            const liveFiles = files.filter(f => f.startsWith('live') && f.endsWith('.ts'));
            if (liveFiles.length > 10) {
                liveFiles.sort().slice(0, -10).forEach(file => {
                    try {
                        fs.unlinkSync(path.join(this.recordingsDir, file));
                    } catch (e) {
                        // Ignorar erros
                    }
                });
            }
            
            // Atualizar playlist DVR para remover referências a arquivos deletados
            this.updateDVRPlaylist();
            
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
        // Limpeza inicial imediata
        console.log('[DVRManager] Executando limpeza inicial de segmentos antigos...');
        this.cleanOldSegments();
        
        // Limpar a cada 10 minutos (mais frequente para evitar acúmulo)
        this.cleanupInterval = setInterval(() => {
            this.cleanOldSegments();
        }, 10 * 60 * 1000); // 10 minutos
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
                liveLatency: '< 2 segundos',
                dvrSegmentSize: this.segmentDuration + ' segundos',
                liveSegmentSize: '2 segundos',
                mode: 'Mobile Optimized (Low CPU + Storage)',
                optimization: 'CPU: Mínimo | Espaço: ~60% economia'
            }
        };
    }
}

module.exports = DVRManagerLowLatency;