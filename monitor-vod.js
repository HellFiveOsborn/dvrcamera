const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const recordingsDir = path.join(__dirname, 'recordings');

function checkFFmpegProcesses(callback) {
    exec('tasklist | findstr ffmpeg', (error, stdout, stderr) => {
        if (error) {
            callback(0);
            return;
        }
        const lines = stdout.trim().split('\n').filter(line => line.includes('ffmpeg.exe'));
        callback(lines.length);
    });
}

function getRecordingStats() {
    if (!fs.existsSync(recordingsDir)) {
        return { recordings: 0, liveFiles: 0, totalSizeMB: 0 };
    }
    
    const files = fs.readdirSync(recordingsDir);
    const recordings = files.filter(f => f.startsWith('recording-') && f.endsWith('.mp4'));
    const liveFiles = files.filter(f => f.startsWith('live'));
    
    let totalSize = 0;
    [...recordings, ...liveFiles].forEach(file => {
        const filePath = path.join(recordingsDir, file);
        if (fs.existsSync(filePath)) {
            totalSize += fs.statSync(filePath).size;
        }
    });
    
    return {
        recordings: recordings.length,
        liveFiles: liveFiles.length,
        totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
        lastRecording: recordings.length > 0 ? recordings[recordings.length - 1] : null
    };
}

function monitor() {
    console.clear();
    console.log('=== Monitor VOD Sistema ===');
    console.log(new Date().toLocaleString('pt-BR'));
    console.log('');
    
    checkFFmpegProcesses((ffmpegCount) => {
        console.log(`🎥 Processos FFmpeg ativos: ${ffmpegCount}`);
        
        if (ffmpegCount === 0) {
            console.log('   ⚠️  Nenhum processo FFmpeg detectado!');
            console.log('   O sistema de gravação pode estar parado.');
        } else if (ffmpegCount === 1) {
            console.log('   ⚠️  Apenas 1 processo FFmpeg (esperado: 2)');
        } else if (ffmpegCount === 2) {
            console.log('   ✅ Sistema funcionando normalmente');
        } else {
            console.log('   ⚠️  Múltiplos processos FFmpeg detectados');
        }
        
        console.log('');
        
        const stats = getRecordingStats();
        
        console.log('📊 Estatísticas:');
        console.log(`   Gravações VOD: ${stats.recordings}`);
        console.log(`   Arquivos Live: ${stats.liveFiles}`);
        console.log(`   Espaço usado: ${stats.totalSizeMB} MB`);
        
        if (stats.lastRecording) {
            console.log(`   Última gravação: ${stats.lastRecording}`);
            
            // Verificar se está sendo criado novo arquivo
            const lastFile = path.join(recordingsDir, stats.lastRecording);
            if (fs.existsSync(lastFile)) {
                const stats = fs.statSync(lastFile);
                const ageMinutes = ((Date.now() - stats.mtimeMs) / (1000 * 60)).toFixed(1);
                const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
                console.log(`   Tamanho: ${sizeMB} MB | Idade: ${ageMinutes} min`);
                
                if (parseFloat(ageMinutes) < 1) {
                    console.log('   🔴 Gravando agora...');
                }
            }
        }
        
        // Verificar playlists
        console.log('');
        console.log('📝 Playlists:');
        
        const livePlaylist = path.join(recordingsDir, 'live.m3u8');
        if (fs.existsSync(livePlaylist)) {
            const stats = fs.statSync(livePlaylist);
            const ageSeconds = ((Date.now() - stats.mtimeMs) / 1000).toFixed(0);
            console.log(`   live.m3u8: ✅ (atualizado há ${ageSeconds}s)`);
            
            if (parseInt(ageSeconds) > 30) {
                console.log('   ⚠️  Playlist live não está sendo atualizada!');
            }
        } else {
            console.log('   live.m3u8: ❌ Não encontrado');
        }
        
        const vodPlaylist = path.join(recordingsDir, 'playlist.m3u8');
        if (fs.existsSync(vodPlaylist)) {
            const content = fs.readFileSync(vodPlaylist, 'utf8');
            const mediaFiles = content.split('\n').filter(l => l.endsWith('.mp4'));
            console.log(`   playlist.m3u8: ✅ (${mediaFiles.length} arquivos)`);
        } else {
            console.log('   playlist.m3u8: ❌ Não encontrado');
        }
        
        console.log('');
        console.log('Pressione Ctrl+C para sair');
        console.log('Atualizando a cada 5 segundos...');
    });
}

// Monitorar a cada 5 segundos
monitor();
setInterval(monitor, 5000);

// Capturar Ctrl+C
process.on('SIGINT', () => {
    console.log('\n\nMonitoramento encerrado.');
    process.exit(0);
});