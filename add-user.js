#!/usr/bin/env node

const readline = require('readline');
const AuthManager = require('./auth-manager');
const { hideCursor, showCursor } = require('process');

// Cores para o terminal
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

const authManager = new AuthManager();

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Função para fazer perguntas
function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// Função para ler senha sem mostrar na tela
function questionPassword(query) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        const stdout = process.stdout;
        
        stdout.write(query);
        
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        
        let password = '';
        
        const onData = (char) => {
            char = char.toString('utf8');
            
            switch (char) {
                case '\n':
                case '\r':
                case '\u0004':
                    stdin.setRawMode(false);
                    stdin.pause();
                    stdin.removeListener('data', onData);
                    stdout.write('\n');
                    resolve(password);
                    break;
                case '\u0003': // Ctrl+C
                    process.exit();
                    break;
                case '\u007f': // Backspace
                case '\b':
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                        stdout.clearLine();
                        stdout.cursorTo(0);
                        stdout.write(query + '*'.repeat(password.length));
                    }
                    break;
                default:
                    password += char;
                    stdout.write('*');
                    break;
            }
        };
        
        stdin.on('data', onData);
    });
}

// Função para validar email
function isValidEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Função principal
async function main() {
    console.log('\n' + colors.cyan + colors.bright + '╔═══════════════════════════════════════════╗');
    console.log('║     ADICIONAR NOVO USUÁRIO - SISTEMA DVR    ║');
    console.log('╚═══════════════════════════════════════════╝' + colors.reset);
    console.log('');
    
    try {
        // Verificar argumentos da linha de comando
        const args = process.argv.slice(2);
        let username, password, email;
        
        if (args.length >= 2) {
            // Modo não-interativo
            username = args[0];
            password = args[1];
            email = args[2] || null;
            
            console.log(colors.yellow + '📝 Modo não-interativo detectado' + colors.reset);
            console.log(`   Usuário: ${username}`);
            if (email) console.log(`   Email: ${email}`);
            
        } else {
            // Modo interativo
            console.log(colors.yellow + '📝 Por favor, forneça as informações do novo usuário:\n' + colors.reset);
            
            // Solicitar username
            username = await question(colors.cyan + 'Nome de usuário: ' + colors.reset);
            while (!username || username.length < 3) {
                console.log(colors.red + '❌ O nome de usuário deve ter pelo menos 3 caracteres' + colors.reset);
                username = await question(colors.cyan + 'Nome de usuário: ' + colors.reset);
            }
            
            // Solicitar senha
            password = await questionPassword(colors.cyan + 'Senha: ' + colors.reset);
            while (!password || password.length < 6) {
                console.log(colors.red + '❌ A senha deve ter pelo menos 6 caracteres' + colors.reset);
                password = await questionPassword(colors.cyan + 'Senha: ' + colors.reset);
            }
            
            // Confirmar senha
            const confirmPassword = await questionPassword(colors.cyan + 'Confirme a senha: ' + colors.reset);
            if (password !== confirmPassword) {
                console.log(colors.red + '\n❌ As senhas não coincidem!' + colors.reset);
                process.exit(1);
            }
            
            // Solicitar email (opcional)
            email = await question(colors.cyan + 'Email (opcional, pressione Enter para pular): ' + colors.reset);
            if (email && !isValidEmail(email)) {
                console.log(colors.yellow + '⚠️  Email inválido, será ignorado' + colors.reset);
                email = null;
            }
        }
        
        console.log('\n' + colors.yellow + '⏳ Criando usuário...' + colors.reset);
        
        // Criar usuário
        const user = await authManager.createUser(username, password, email);
        
        console.log('\n' + colors.green + colors.bright + '✅ Usuário criado com sucesso!' + colors.reset);
        console.log(colors.green + '┌─────────────────────────────────────────────');
        console.log(`│ ID: ${user.id}`);
        console.log(`│ Usuário: ${user.username}`);
        if (user.email) console.log(`│ Email: ${user.email}`);
        console.log('└─────────────────────────────────────────────' + colors.reset);
        
        // Listar todos os usuários
        console.log('\n' + colors.blue + '📋 Usuários cadastrados no sistema:' + colors.reset);
        const users = await authManager.getAllUsers();
        
        console.log(colors.blue + '┌────┬──────────────────┬─────────────┬──────────────────────┐');
        console.log('│ ID │ Usuário          │ Status      │ Último Login         │');
        console.log('├────┼──────────────────┼─────────────┼──────────────────────┤' + colors.reset);
        
        users.forEach(u => {
            const status = u.is_active ? colors.green + 'Ativo' + colors.reset : colors.red + 'Inativo' + colors.reset;
            const lastLogin = u.last_login ? new Date(u.last_login).toLocaleString('pt-BR') : 'Nunca';
            const username = u.username.padEnd(16);
            const id = u.id.toString().padEnd(2);
            
            console.log(`│ ${id} │ ${username} │ ${status}      │ ${lastLogin.padEnd(20)} │`);
        });
        
        console.log(colors.blue + '└────┴──────────────────┴─────────────┴──────────────────────┘' + colors.reset);
        
    } catch (error) {
        if (error.code === 'SQLITE_CONSTRAINT') {
            console.log('\n' + colors.red + '❌ Erro: Este nome de usuário já existe!' + colors.reset);
        } else {
            console.log('\n' + colors.red + '❌ Erro ao criar usuário:', error.message + colors.reset);
            if (process.env.DEBUG === 'true') {
                console.error(error);
            }
        }
        process.exit(1);
    } finally {
        authManager.close();
        rl.close();
    }
}

// Executar
main().catch(error => {
    console.error(colors.red + '❌ Erro fatal:', error.message + colors.reset);
    process.exit(1);
});

// Tratamento de sinais
process.on('SIGINT', () => {
    console.log('\n' + colors.yellow + '⚠️  Operação cancelada pelo usuário' + colors.reset);
    authManager.close();
    process.exit(0);
});