#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Diretório de gravações
const recordingsDir = path.join(__dirname, 'recordings');

console.log('========================================');
console.log('   LIMPEZA EMERGENCIAL DO DVR');
console.log('========================================');
console.log(`Diretório: ${recordingsDir}`);
console.log('');

function getDirectorySize(dir) {
    let totalSize = 0;
    try {
        const files = fs.readdirSync(dir);
        files.forEach(file => {
            const filePath = path.join(dir, file);
            const stats = fs.statSync(filePath);
            if (stats.isFile()) {
                totalSize += stats.size;
            }
        });
    } catch (e) {
        console.error('Erro ao calcular tamanho:', e.message);
    }
    return totalSize;
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function cleanupDVR() {
    try {
        // Verificar se o diretório existe
        if (!fs.existsSync(recordingsDir)) {
            console.log('❌ Diretório de gravações não encontrado!');
            return;
        }

        // Calcular tamanho inicial
        const initialSize = getDirectorySize(recordingsDir);
        console.log(`📊 Tamanho atual: ${formatBytes(initialSize)}`);
        console.log('');

        const now = Date.now();
        const maxAge = 48 * 60 * 60 * 1000; // 48 horas em ms
        const maxSegments = 8640; // 48h com segmentos de 20s

        // Listar todos os arquivos
        const files = fs.readdirSync(recordingsDir);
        const dvrFiles = files.filter(f => f.startsWith('dvr_') && f.endsWith('.ts'));
        const liveFiles = files.filter(f => f.startsWith('live') && f.endsWith('.ts'));

        console.log(`📁 Arquivos encontrados:`);
        console.log(`   - Segmentos DVR: ${dvrFiles.length}`);
        console.log(`   - Segmentos Live: ${liveFiles.length}`);
        console.log('');

        // Ordenar arquivos DVR por número
        dvrFiles.sort((a, b) => {
            const numA = parseInt(a.match(/dvr_(\d+)/)?.[1] || 0);
            const numB = parseInt(b.match(/dvr_(\d+)/)?.[1] || 0);
            return numA - numB;
        });

        let removedCount = 0;
        let removedSize = 0;
        let keptCount = 0;

        // Método 1: Remover arquivos mais antigos que 48h
        console.log('🔍 Analisando arquivos por idade...');
        const filesToRemove = [];
        const filesToKeep = [];

        dvrFiles.forEach(file => {
            const filePath = path.join(recordingsDir, file);
            try {
                const stats = fs.statSync(filePath);
                const age = now - stats.birthtimeMs;
                const ageHours = age / (1000 * 60 * 60);
                
                if (age > maxAge) {
                    filesToRemove.push({
                        name: file,
                        path: filePath,
                        size: stats.size,
                        age: ageHours
                    });
                } else {
                    filesToKeep.push({
                        name: file,
                        path: filePath,
                        size: stats.size,
                        age: ageHours
                    });
                }
            } catch (e) {
                // Arquivo corrompido, marcar para remoção
                filesToRemove.push({
                    name: file,
                    path: filePath,
                    size: 0,
                    age: 999
                });
            }
        });

        // Método 2: Se ainda temos muitos arquivos, remover os mais antigos
        if (filesToKeep.length > maxSegments) {
            console.log(`⚠️  Excesso de segmentos: ${filesToKeep.length} > ${maxSegments}`);
            const excess = filesToKeep.length - maxSegments;
            const oldestFiles = filesToKeep.slice(0, excess);
            filesToRemove.push(...oldestFiles);
            filesToKeep.splice(0, excess);
        }

        // Remover arquivos
        if (filesToRemove.length > 0) {
            console.log('');
            console.log(`🗑️  Removendo ${filesToRemove.length} arquivos antigos...`);
            
            // Mostrar alguns exemplos
            const examples = filesToRemove.slice(0, 5);
            examples.forEach(f => {
                console.log(`   - ${f.name} (${f.age.toFixed(1)}h, ${formatBytes(f.size)})`);
            });
            if (filesToRemove.length > 5) {
                console.log(`   ... e mais ${filesToRemove.length - 5} arquivos`);
            }
            console.log('');

            // Remover arquivos
            filesToRemove.forEach(f => {
                try {
                    fs.unlinkSync(f.path);
                    removedCount++;
                    removedSize += f.size;
                } catch (e) {
                    console.error(`   ❌ Erro ao remover ${f.name}: ${e.message}`);
                }
            });
        }

        // Limpar arquivos live antigos (manter apenas últimos 10)
        if (liveFiles.length > 10) {
            console.log(`🔄 Limpando arquivos live (${liveFiles.length} > 10)...`);
            liveFiles.sort().slice(0, -10).forEach(file => {
                try {
                    const filePath = path.join(recordingsDir, file);
                    const stats = fs.statSync(filePath);
                    fs.unlinkSync(filePath);
                    removedCount++;
                    removedSize += stats.size;
                } catch (e) {
                    // Ignorar
                }
            });
        }

        // Atualizar playlist
        console.log('📝 Atualizando playlist DVR...');
        updatePlaylist();

        // Calcular tamanho final
        const finalSize = getDirectorySize(recordingsDir);
        const savedSpace = initialSize - finalSize;

        // Relatório final
        console.log('');
        console.log('========================================');
        console.log('   RELATÓRIO DE LIMPEZA');
        console.log('========================================');
        console.log(`✅ Arquivos removidos: ${removedCount}`);
        console.log(`💾 Espaço liberado: ${formatBytes(removedSize)}`);
        console.log(`📊 Tamanho inicial: ${formatBytes(initialSize)}`);
        console.log(`📊 Tamanho final: ${formatBytes(finalSize)}`);
        console.log(`🎯 Economia total: ${formatBytes(savedSpace)} (${((savedSpace/initialSize)*100).toFixed(1)}%)`);
        console.log(`📁 Segmentos mantidos: ${filesToKeep.length}`);
        
        if (filesToKeep.length > 0) {
            const oldestKept = filesToKeep[0];
            const newestKept = filesToKeep[filesToKeep.length - 1];
            console.log(`⏰ Período mantido: ${oldestKept.age.toFixed(1)}h até ${newestKept.age.toFixed(1)}h atrás`);
        }

    } catch (error) {
        console.error('❌ Erro durante limpeza:', error);
    }
}

function updatePlaylist() {
    try {
        const playlistPath = path.join(recordingsDir, 'dvr.m3u8');
        if (!fs.existsSync(playlistPath)) {
            console.log('   ⚠️  Playlist não encontrada');
            return;
        }

        const content = fs.readFileSync(playlistPath, 'utf8');
        const lines = content.split('\n');
        const newLines = [];
        let removedFromPlaylist = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (line.endsWith('.ts')) {
                const segmentPath = path.join(recordingsDir, line);
                if (fs.existsSync(segmentPath)) {
                    if (i > 0 && lines[i-1].startsWith('#EXTINF')) {
                        newLines.push(lines[i-1]);
                    }
                    newLines.push(line);
                } else {
                    removedFromPlaylist++;
                }
            } else if (!line.startsWith('#EXTINF')) {
                newLines.push(line);
            }
        }

        fs.writeFileSync(playlistPath, newLines.join('\n'));
        console.log(`   ✅ Playlist atualizada (${removedFromPlaylist} referências removidas)`);
        
    } catch (error) {
        console.error('   ❌ Erro ao atualizar playlist:', error.message);
    }
}

// Executar limpeza
cleanupDVR();

console.log('');
console.log('💡 Dica: Reinicie o servidor para aplicar as correções de limpeza automática');
console.log('   npm start');
console.log('');