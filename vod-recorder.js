const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class VODRecorder {
    constructor(rtspUrl, recordingsDir, segmentDuration = 30) {
        this.rtspUrl = rtspUrl;
        this.recordingsDir = recordingsDir;
        this.segmentDuration = segmentDuration;
        this.recordProcess = null;
        this.isRecording = false;
        this.maxRecordings = (48 * 60 * 60) / segmentDuration; // 48 horas
        this.cleanupInterval = null;
    }

    start() {
        if (this.isRecording) {
            console.log('[VODRecorder] Gravação já está em execução');
            return;
        }

        // Gerar nome base único para esta sessão
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const baseFilename = `recording-${timestamp}`;

        const args = [
            '-rtsp_transport', 'udp',
            '-i', this.rtspUrl,
            '-c:v', 'copy',
            '-c:a', 'copy',
            '-f', 'segment',
            '-segment_time', this.segmentDuration.toString(),
            '-segment_format', 'mp4',
            '-segment_list', path.join(this.recordingsDir, 'playlist.m3u8'),
            '-segment_list_type', 'm3u8',
            '-segment_list_size', '0',
            '-segment_list_flags', 'live',
            '-reset_timestamps', '1',
            '-avoid_negative_ts', 'make_zero',
            '-movflags', '+faststart',
            path.join(this.recordingsDir, `${baseFilename}-%03d.mp4`)
        ];

        console.log('[VODRecorder] Iniciando gravação VOD...');
        console.log(`[VODRecorder] Segmentos de ${this.segmentDuration} segundos`);
        console.log(`[VODRecorder] Retenção de 48 horas (máx ${this.maxRecordings} arquivos)`);
        
        this.recordProcess = spawn('ffmpeg', args);
        this.isRecording = true;

        this.recordProcess.stdout.on('data', (data) => {
            if (process.env.DEBUG) {
                console.log(`[VODRecorder stdout]: ${data}`);
            }
        });

        this.recordProcess.stderr.on('data', (data) => {
            if (process.env.VERBOSE) {
                console.error(`[VODRecorder stderr]: ${data}`);
            }
        });

        this.recordProcess.on('close', (code) => {
            console.log(`[VODRecorder] Processo de gravação encerrado com código ${code}`);
            this.isRecording = false;
            
            // Reiniciar automaticamente após 5 segundos
            if (code !== 0) {
                console.log('[VODRecorder] Reiniciando gravação em 5 segundos...');
                setTimeout(() => this.start(), 5000);
            }
        });

        this.recordProcess.on('error', (error) => {
            console.error('[VODRecorder] Erro ao iniciar gravação:', error);
            this.isRecording = false;
        });

        // Iniciar limpeza automática
        this.startCleanupSchedule();
    }

    stop() {
        if (this.recordProcess && this.isRecording) {
            console.log('[VODRecorder] Parando gravação...');
            this.recordProcess.kill('SIGTERM');
            this.isRecording = false;
        }
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
    }

    restart() {
        console.log('[VODRecorder] Reiniciando gravação...');
        this.stop();
        setTimeout(() => this.start(), 2000);
    }

    startCleanupSchedule() {
        // Executar limpeza inicial
        this.cleanupOldRecordings();
        
        // Agendar limpeza a cada 30 minutos
        this.cleanupInterval = setInterval(() => {
            this.cleanupOldRecordings();
        }, 30 * 60 * 1000);
    }

    cleanupOldRecordings() {
        const now = Date.now();
        const maxAge = 48 * 60 * 60 * 1000; // 48 horas em milissegundos
        
        try {
            const files = fs.readdirSync(this.recordingsDir);
            const recordingFiles = files.filter(f => f.startsWith('recording-') && f.endsWith('.mp4'));
            
            let removedCount = 0;
            
            // Remover arquivos mais antigos que 48 horas
            recordingFiles.forEach(file => {
                const filePath = path.join(this.recordingsDir, file);
                try {
                    const stats = fs.statSync(filePath);
                    const fileAge = now - stats.mtimeMs;
                    
                    // Também remover arquivos vazios (0 KB)
                    if (fileAge > maxAge || stats.size === 0) {
                        fs.unlinkSync(filePath);
                        if (stats.size === 0) {
                            console.log(`[VODRecorder] Arquivo vazio removido: ${file}`);
                        } else {
                            console.log(`[VODRecorder] Arquivo removido (>48h): ${file}`);
                        }
                        removedCount++;
                    }
                } catch (err) {
                    // Arquivo pode ter sido removido por outro processo
                }
            });
            
            // Também limitar pelo número máximo de arquivos
            const remainingFiles = fs.readdirSync(this.recordingsDir)
                .filter(f => f.startsWith('recording-') && f.endsWith('.mp4'))
                .map(f => {
                    try {
                        const stats = fs.statSync(path.join(this.recordingsDir, f));
                        return {
                            name: f,
                            path: path.join(this.recordingsDir, f),
                            mtime: stats.mtimeMs,
                            size: stats.size
                        };
                    } catch {
                        return null;
                    }
                })
                .filter(f => f !== null && f.size > 0) // Filtrar arquivos válidos e não vazios
                .sort((a, b) => b.mtime - a.mtime); // Mais recentes primeiro
            
            if (remainingFiles.length > this.maxRecordings) {
                const filesToDelete = remainingFiles.slice(this.maxRecordings);
                filesToDelete.forEach(file => {
                    try {
                        fs.unlinkSync(file.path);
                        console.log(`[VODRecorder] Arquivo removido (excesso): ${file.name}`);
                        removedCount++;
                    } catch (err) {
                        // Arquivo pode ter sido removido
                    }
                });
            }
            
            if (removedCount > 0) {
                console.log(`[VODRecorder] Total de arquivos removidos: ${removedCount}`);
            }
        } catch (error) {
            console.error('[VODRecorder] Erro ao limpar gravações antigas:', error);
        }
    }

    getStatus() {
        const files = fs.readdirSync(this.recordingsDir);
        const recordings = files.filter(f => f.startsWith('recording-') && f.endsWith('.mp4'));
        
        return {
            isRecording: this.isRecording,
            pid: this.recordProcess ? this.recordProcess.pid : null,
            totalRecordings: recordings.length,
            maxRecordings: this.maxRecordings,
            segmentDuration: this.segmentDuration
        };
    }

    getRecordings() {
        try {
            const files = fs.readdirSync(this.recordingsDir);
            const mp4Files = files
                .filter(file => file.startsWith('recording-') && file.endsWith('.mp4'))
                .map(file => {
                    try {
                        const filePath = path.join(this.recordingsDir, file);
                        const stats = fs.statSync(filePath);
                        
                        // Ignorar arquivos vazios
                        if (stats.size === 0) {
                            return null;
                        }
                        
                        return {
                            filename: file,
                            size: stats.size,
                            created: stats.birthtime,
                            modified: stats.mtime,
                            url: `/recordings/${file}`
                        };
                    } catch {
                        return null;
                    }
                })
                .filter(file => file !== null) // Remover nulls
                .sort((a, b) => new Date(b.created) - new Date(a.created));
            
            return {
                total: mp4Files.length,
                maxDuration: '48 horas',
                segmentDuration: `${this.segmentDuration} segundos`,
                recordings: mp4Files
            };
        } catch (error) {
            console.error('[VODRecorder] Erro ao listar gravações:', error);
            return {
                error: 'Erro ao listar gravações',
                recordings: []
            };
        }
    }
}

module.exports = VODRecorder;