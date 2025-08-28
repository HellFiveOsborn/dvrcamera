# Sistema DVR com Autenticação - Câmera RTSP

Sistema de vigilância com DVR estilo YouTube, autenticação de usuários e gravação contínua de 48 horas.

## 🚀 Características Principais

### Sistema DVR
- **Timeline Navegável**: Interface estilo YouTube com timeline de 48 horas
- **Gravação Contínua**: Buffer circular com retenção automática de 48 horas
- **Navegação Temporal**: Clique na timeline ou use botões de atalho (-1h, -30m, -10m, -1m)
- **Indicadores Visuais**: 
  - Marcador amarelo mostra posição atual
  - Tooltip com horário exato ao passar o mouse
  - Gradiente visual (passado → ao vivo)
  - Ticks de tempo a cada hora

### Sistema de Autenticação
- **Login Seguro**: Autenticação com bcrypt e sessões persistentes
- **Gerenciamento de Usuários**: Adicione usuários via CLI
- **Sessões Persistentes**: Até 30 dias com "Lembrar de mim"
- **Banco de Dados SQLite**: Armazenamento seguro de usuários e sessões
- **Logs de Acesso**: Rastreamento de login/logout

## 📋 Pré-requisitos

- Node.js 14+ 
- FFmpeg instalado e no PATH
- Câmera RTSP compatível

## 🔧 Instalação

1. Clone o repositório:
```bash
git clone https://github.com/HellFiveOsborn/dvrcamera
cd dvrcamera
```

2. Instale as dependências:
```bash
npm install
```

3. Configure o arquivo `.env`:
```env
# Configurações da Câmera RTSP
RTSP_URL=rtsp://admin:senha@192.168.1.33:554/onvif1

# Configurações do Servidor
PORT=3000

# Configurações de Autenticação
DEFAULT_USERNAME=admin
DEFAULT_PASSWORD=sua_senha_segura
DEFAULT_EMAIL=admin@localhost

# Configurações de Sessão
SESSION_SECRET=sua-chave-secreta-muito-segura
SESSION_MAX_AGE=2592000000  # 30 dias em ms

# Configurações de Log
DEBUG=true
VERBOSE=true
```

## 🎯 Uso

### Iniciar o Sistema

```bash
npm start
```

O sistema estará disponível em:
- **Login**: http://localhost:3000/login.html
- **DVR**: http://localhost:3000/dvr.html (requer autenticação)

### Gerenciamento de Usuários

#### Adicionar novo usuário (interativo):
```bash
npm run add-user
```

#### Adicionar usuário via linha de comando:
```bash
npm run add-user username password email@example.com
```

### Scripts Disponíveis

```bash
npm start          # Inicia o servidor DVR com autenticação
npm run dev        # Modo desenvolvimento com DEBUG
npm run add-user   # Adiciona novo usuário
npm run check      # Verifica instalação do FFmpeg
npm run debug      # Debug da conexão RTSP
npm run monitor    # Monitora gravações VOD
```

## 🔐 Sistema de Autenticação

### Login Padrão
- **Usuário**: admin (configurável no .env)
- **Senha**: definida no .env

### Recursos de Segurança
- Senhas criptografadas com bcrypt (10 rounds)
- Sessões armazenadas em SQLite
- Cookie httpOnly para prevenir XSS
- Logout automático após período de inatividade
- Logs de acesso para auditoria

### Banco de Dados
O sistema cria automaticamente três tabelas SQLite:
- `users`: Armazena usuários do sistema
- `sessions`: Gerencia sessões ativas
- `access_logs`: Registra atividades de login/logout

## 📁 Estrutura do Projeto

```
cam/
├── server.js           # Servidor principal com autenticação
├── auth-manager.js     # Gerenciador de autenticação
├── dvr-manager.js      # Gerenciador DVR
├── stream-manager.js   # Gerenciador de streaming
├── config.js          # Configurações centralizadas
├── add-user.js        # CLI para adicionar usuários
├── database.db        # Banco SQLite (criado automaticamente)
├── sessions.db        # Sessões (criado automaticamente)
├── public/
│   ├── login.html     # Página de login
│   ├── dvr.html       # Interface DVR principal
│   └── index.html     # Interface alternativa
└── recordings/        # Diretório de gravações DVR
```

## 🎮 Interface DVR

### Controles Principais
- **Botão AO VIVO**: Volta para transmissão ao vivo
- **Timeline**: Clique para navegar nas últimas 48h
- **Atalhos de Tempo**: -1h, -30m, -10m, -1m
- **Menu de Usuário**: Exibe usuário logado e opção de logout

### Indicadores Visuais
- **Marcador Amarelo**: Posição atual na timeline
- **Badge AO VIVO**: Indica quando está assistindo ao vivo
- **Tooltip**: Mostra horário exato ao passar mouse na timeline
- **Ticks de Tempo**: Marcações horárias na timeline

## 🔧 Configurações Avançadas

### Transporte RTSP
Configure no `config.js`:
- `udp`: Melhor performance (padrão)
- `tcp`: Mais confiável em redes instáveis

### Duração dos Segmentos
- DVR: 10 segundos (otimizado para navegação)
- Live: 2 segundos (baixa latência)

### Retenção de Gravações
- Padrão: 48 horas
- Limpeza automática de segmentos antigos
- Buffer circular eficiente

## 🐛 Solução de Problemas

### Erro de Autenticação
1. Verifique as credenciais no `.env`
2. Recrie o usuário: `npm run add-user`
3. Limpe as sessões: delete `sessions.db`

### Stream não carrega
1. Verifique a URL RTSP no `.env`
2. Teste conexão: `npm run debug`
3. Verifique FFmpeg: `npm run check`

### Timeline não funciona
1. Aguarde alguns segmentos serem gravados
2. Verifique permissões na pasta `recordings/`
3. Monitore logs: `npm run verbose`

## 📊 APIs Disponíveis

### Autenticação
- `POST /api/auth/login` - Login de usuário
- `POST /api/auth/logout` - Logout
- `GET /api/auth/check` - Verificar autenticação
- `GET /api/auth/session` - Informações da sessão

### DVR (requer autenticação)
- `GET /api/dvr/info` - Informações do DVR
- `GET /api/dvr/segments` - Lista de segmentos
- `POST /api/dvr/restart` - Reiniciar DVR
- `GET /api/status` - Status do sistema
- `GET /api/health` - Health check

## 🔒 Segurança

### Recomendações
1. **Altere a senha padrão** no `.env`
2. **Use HTTPS** em produção
3. **Configure SESSION_SECRET** único
4. **Limite tentativas de login** (implementar rate limiting)
5. **Monitore logs de acesso** regularmente

### Adicionar HTTPS
Para produção, configure certificados SSL:
```javascript
const https = require('https');
const fs = require('fs');

const options = {
  key: fs.readFileSync('private-key.pem'),
  cert: fs.readFileSync('certificate.pem')
};

https.createServer(options, app).listen(443);
```

## 📝 Licença

MIT

## 🤝 Contribuindo

Contribuições são bem-vindas! Por favor:
1. Fork o projeto
2. Crie uma branch para sua feature
3. Commit suas mudanças
4. Push para a branch
5. Abra um Pull Request

## 📞 Suporte

Para problemas ou dúvidas:
1. Verifique a seção de Solução de Problemas
2. Consulte os logs com `npm run verbose`
3. Abra uma issue no GitHub

---

**Sistema DVR v3.0** - Desenvolvido com ❤️ por HellFive Osborn