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
        this.maxSegments = Math.floor(this.maxDuration / this.segmentDuration);
        this.cleanupCounter = 0; // Contador para limpeza menos frequente
        
        // Controle de segmentos e thumbnails
        this.segmentMap = new Map(); // Mapear número do segmento -> info
        this.thumbnailsDir = path.join(recordingsDir, 'thumbnails');
        this.nextSegmentNumber = 0;
        this.isGeneratingThumbnail = false;
        
        // Criar diretório de thumbnails se não existir
        if (!fs.existsSync(this.thumbnailsDir)) {
            fs.mkdirSync(this.thumbnailsDir, { recursive: true });
        }
        
        // Inicializar mapa de segmentos existentes
        this.initializeSegmentMap();
    }
    
    initializeSegmentMap() {
        try {
            const files = fs.readdirSync(this.recordingsDir);
            const tsFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
            
            // Mapear segmentos existentes
            tsFiles.forEach(file => {
                const match = file.match(/dvr_(\d+)\.ts/);
                if (match) {
                    const segmentNum = parseInt(match[1]);
                    const filePath = path.join(this.recordingsDir, file);
                    const stats = fs.statSync(filePath);
                    this.segmentMap.set(segmentNum, {
                        timestamp: stats.mtime.getTime(),
                        size: stats.size
                    });
                }
            });
            
            // Encontrar o próximo número disponível para reutilização
            this.findNextAvailableSegment();
            
            console.log(`[DVRManager] Inicializado com ${this.segmentMap.size} segmentos existentes`);
            console.log(`[DVRManager] Próximo segmento será: dvr_${this.nextSegmentNumber}.ts`);
            
        } catch (error) {
            console.error('[DVRManager] Erro ao inicializar mapa de segmentos:', error);
        }
    }
    
    findNextAvailableSegment() {
        // Se não há segmentos, começar do 0
        if (this.segmentMap.size === 0) {
            this.nextSegmentNumber = 0;
            return;
        }
        
        // Se atingimos o máximo, encontrar o segmento mais antigo para reutilizar
        if (this.segmentMap.size >= this.maxSegments) {
            let oldestSegment = -1;
            let oldestTime = Date.now();
            
            for (const [num, info] of this.segmentMap.entries()) {
                if (info.timestamp < oldestTime) {
                    oldestTime = info.timestamp;
                    oldestSegment = num;
                }
            }
            
            this.nextSegmentNumber = oldestSegment;
            console.log(`[DVRManager] Reutilizando segmento mais antigo: ${oldestSegment}`);
        } else {
            // Encontrar o primeiro número não utilizado (0 até maxSegments-1)
            for (let i = 0; i < this.maxSegments; i++) {
                if (!this.segmentMap.has(i)) {
                    this.nextSegmentNumber = i;
                    break;
                }
            }
        }
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
            '-rtsp_transport', 'udp',  // UDP mais rápido
            '-rtsp_flags', 'prefer_tcp',
            '-analyzeduration', '500000', // 0.5s - análise rápida
            '-probesize', '500000',       // 0.5MB - probe pequeno
            '-fflags', '+nobuffer+genpts',
            '-flags', 'low_delay',
            '-i', this.rtspUrl,
            
            // Output 1: DVR com thumbnail embutido
            '-map', '0:v:0',           // Primeiro stream de vídeo
            '-map', '0:a?',            // TODOS os streams de áudio disponíveis
            '-c:v', 'copy',            // COPY DIRETO - ZERO CPU para vídeo!
            
            // Áudio
            '-c:a', 'aac',             // AAC para garantir compatibilidade
            '-b:a', '128k',            // Bitrate de áudio adequado
            '-ar', '44100',            // Sample rate padrão
            '-ac', '2',                // Stereo
            
            // Segmentação com HLS (mais compatível que segment)
            '-f', 'hls',
            '-hls_time', this.segmentDuration.toString(),
            '-hls_list_size', '0',
            '-hls_segment_filename', path.join(this.recordingsDir, 'dvr_%d.ts'),
            '-hls_flags', 'append_list+program_date_time',
            '-hls_playlist_type', 'event',
            '-hls_segment_type', 'mpegts',
            '-start_number', this.nextSegmentNumber.toString(),
            dvrPlaylist,
            
            // Output 2: Live (COPY vídeo, AAC áudio para compatibilidade)
            '-map', '0:v:0',           // Vídeo principal
            '-map', '0:a?',            // Todos os áudios disponíveis
            '-c:v', 'copy',            // COPY - sem recodificação de vídeo
            '-c:a', 'aac',             // AAC para áudio (compatível com HLS)
            '-b:a', '128k',            // Bitrate adequado
            '-ar', '44100',            // Sample rate padrão
            '-ac', '2',                // Stereo
            
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
        console.log('[DVRManager] Modo: COPY vídeo + AAC áudio (mínimo CPU)');
        console.log('[DVRManager] Segmentos DVR: ' + this.segmentDuration + 's | Live: 2s');
        console.log('[DVRManager] Áudio: AAC 128kbps 44.1kHz Stereo');
        
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
            // Detectar novos segmentos
            if (message.includes('Opening') && message.includes('dvr_')) {
                const match = message.match(/dvr_(\d+)\.ts/);
                if (match) {
                    const segmentNum = parseInt(match[1]);
                    const segmentPath = path.join(this.recordingsDir, `dvr_${segmentNum}.ts`);
                    this.onNewSegmentCreated(segmentNum, segmentPath);
                }
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

    onNewSegmentCreated(segmentNumber, segmentPath) {
        console.log(`[DVRManager] Novo segmento criado: dvr_${segmentNumber}.ts`);
        
        // Atualizar mapa
        this.segmentMap.set(segmentNumber, {
            timestamp: Date.now(),
            size: 0
        });
        
        // Gerar thumbnail de forma simples e eficiente
        this.generateThumbnailSimple(segmentNumber, segmentPath);
        
        // Preparar próximo número para reutilização
        this.findNextAvailableSegment();
    }
    
    // Versão simplificada e eficiente para Linux/Termux
    generateThumbnailSimple(segmentNumber, segmentPath) {
        const thumbnailPath = path.join(this.thumbnailsDir, `thumb_${segmentNumber}.jpg`);
        
        // Aguardar apenas 2 segundos para o arquivo ter conteúdo mínimo
        setTimeout(() => {
            // Verificar se arquivo existe
            if (!fs.existsSync(segmentPath)) {
                console.log(`[Thumbnail] Segmento ${segmentNumber} não encontrado, pulando`);
                return;
            }
            
            // Comando FFmpeg simplificado e otimizado
            const args = [
                '-loglevel', 'error', // Apenas erros, sem output verbose
                '-nostdin', // Não usar stdin (evita terminal)
                '-i', segmentPath,
                '-ss', '00:00:01', // Pegar frame em 1 segundo
                '-frames:v', '1', // Apenas 1 frame
                '-vf', 'scale=160:90', // Thumbnail pequeno
                '-q:v', '15', // Qualidade baixa mas aceitável
                '-f', 'mjpeg', // Formato JPEG direto
                '-y', // Sobrescrever sem perguntar
                thumbnailPath
            ];
            
            // Executar FFmpeg sem abrir terminal
            const ffmpeg = spawn('ffmpeg', args, {
                stdio: ['ignore', 'ignore', 'ignore'], // Ignorar todos os streams
                detached: false, // Não criar processo independente
                windowsHide: true // Esconder janela no Windows
            });
            
            // Timeout para matar processo se demorar muito
            const timeout = setTimeout(() => {
                ffmpeg.kill('SIGKILL');
                console.log(`[Thumbnail] Timeout ao gerar thumbnail ${segmentNumber}`);
            }, 5000); // 5 segundos máximo
            
            ffmpeg.on('exit', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    // Verificar se thumbnail foi criado
                    if (fs.existsSync(thumbnailPath)) {
                        const stats = fs.statSync(thumbnailPath);
                        console.log(`[Thumbnail] Gerado: ${segmentNumber} (${(stats.size/1024).toFixed(1)}KB)`);
                    }
                } else if (code !== null) {
                    console.log(`[Thumbnail] Falha ao gerar ${segmentNumber} (código: ${code})`);
                }
            });
            
            ffmpeg.on('error', (err) => {
                clearTimeout(timeout);
                console.error(`[Thumbnail] Erro FFmpeg: ${err.message}`);
            });
            
        }, 2000); // Aguardar 2 segundos após criação do segmento
    }
    
    // Método antigo mantido para compatibilidade
    generateThumbnail(segmentNumber, segmentPath) {
        // Redirecionar para o método simples
        this.generateThumbnailSimple(segmentNumber, segmentPath);
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
            
            let removedCount = 0;
            let removedThumbs = 0;
            
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
                
                // Remover segmentos e thumbnails correspondentes
                filesToRemove.forEach(file => {
                    try {
                        // Remover segmento
                        fs.unlinkSync(path.join(this.recordingsDir, file));
                        removedCount++;
                        
                        // Extrair número do segmento e remover thumbnail correspondente
                        const match = file.match(/dvr_(\d+)\.ts/);
                        if (match) {
                            const segmentNum = match[1];
                            const thumbPath = path.join(this.thumbnailsDir, `thumb_${segmentNum}.jpg`);
                            if (fs.existsSync(thumbPath)) {
                                fs.unlinkSync(thumbPath);
                                removedThumbs++;
                            }
                            // Remover do mapa
                            this.segmentMap.delete(parseInt(segmentNum));
                        }
                    } catch (e) {
                        // Ignorar erros silenciosamente
                    }
                });
                
                if (removedCount > 0) {
                    console.log(`[DVRManager] Limpeza: ${removedCount} segmentos e ${removedThumbs} thumbnails removidos`);
                }
            }
            
            // Limpar thumbnails órfãos (sem segmento correspondente)
            if (fs.existsSync(this.thumbnailsDir)) {
                const thumbFiles = fs.readdirSync(this.thumbnailsDir);
                thumbFiles.forEach(thumbFile => {
                    if (thumbFile.startsWith('thumb_') && thumbFile.endsWith('.jpg')) {
                        const match = thumbFile.match(/thumb_(\d+)\.jpg/);
                        if (match) {
                            const segmentNum = parseInt(match[1]);
                            // Se não existe segmento correspondente, remover thumbnail
                            if (!this.segmentMap.has(segmentNum)) {
                                try {
                                    fs.unlinkSync(path.join(this.thumbnailsDir, thumbFile));
                                    removedThumbs++;
                                } catch (e) {
                                    // Ignorar
                                }
                            }
                        }
                    }
                });
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
                    liveLatency: '< 2 segundos',
                    thumbnails: 0
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
            
            // Contar thumbnails disponíveis
            let thumbnailCount = 0;
            if (fs.existsSync(this.thumbnailsDir)) {
                const thumbFiles = fs.readdirSync(this.thumbnailsDir);
                thumbnailCount = thumbFiles.filter(f => f.startsWith('thumb_') && f.endsWith('.jpg')).length;
            }
            
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
                streamMode: 'Dual (DVR + Live Low Latency)',
                thumbnails: thumbnailCount,
                nextSegment: this.nextSegmentNumber
            };
        } catch (error) {
            return {
                available: false,
                error: error.message
            };
        }
    }
    
    getThumbnailForTime(timeInSeconds) {
        // Calcular qual segmento corresponde ao tempo
        const segmentIndex = Math.floor(timeInSeconds / this.segmentDuration);
        
        // Procurar o segmento mais próximo no mapa
        let closestSegment = null;
        let minDiff = Infinity;
        
        for (const [num, info] of this.segmentMap.entries()) {
            const segmentTime = num * this.segmentDuration;
            const diff = Math.abs(segmentTime - timeInSeconds);
            if (diff < minDiff) {
                minDiff = diff;
                closestSegment = num;
            }
        }
        
        if (closestSegment !== null) {
            const thumbPath = path.join(this.thumbnailsDir, `thumb_${closestSegment}.jpg`);
            if (fs.existsSync(thumbPath)) {
                return {
                    path: thumbPath,
                    segment: closestSegment,
                    exists: true
                };
            }
        }
        
        return {
            path: null,
            segment: closestSegment,
            exists: false
        };
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