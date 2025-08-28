module.exports = {
    // Configurações da Câmera
    camera: {
        rtspUrl: process.env.RTSP_URL || 'rtsp://admin:senha@192.168.1.33:554/onvif1',
        rtspTransport: process.env.RTSP_TRANSPORT || 'udp', // tcp ou udp (use udp para esta câmera)
    },
    
    // Configurações do Servidor
    server: {
        port: parseInt(process.env.PORT) || 3000,
        cors: true,
    },
    
    // Configurações de Streaming ao Vivo
    streaming: {
        videoCodec: 'libx264',
        audioCodec: 'aac',
        preset: 'ultrafast',
        tune: 'zerolatency',
        hlsTime: 10,           // Duração de cada segmento HLS em segundos
        hlsListSize: 6,        // Número de segmentos na playlist
        deleteSegments: true,  // Deletar segmentos antigos
    },
    
    // Configurações de Gravação VOD
    vod: {
        segmentDuration: parseInt(process.env.SEGMENT_DURATION) || 30, // segundos
        retentionHours: 48,    // horas
        cleanupInterval: 30,   // minutos
        format: 'mp4',
        copyCodecs: true,      // Copiar codecs sem recodificar (mais rápido)
    },
    
    // Configurações de Diretórios
    paths: {
        recordings: process.env.RECORDINGS_DIR || './recordings',
        public: './public',
    },
    
    // Configurações de Log
    logging: {
        debug: process.env.DEBUG === 'true',
        verbose: process.env.VERBOSE === 'true',
        showFFmpegErrors: process.env.SHOW_FFMPEG_ERRORS !== 'false',
    },
    
    // Configurações de Reinicialização
    restart: {
        delay: 5000,           // Delay em ms antes de reiniciar após falha
        maxRetries: 10,        // Número máximo de tentativas
    }
};