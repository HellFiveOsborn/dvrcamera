#!/usr/bin/env node

const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');

const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

async function resetPassword() {
    const username = process.argv[2] || 'admin';
    const newPassword = process.argv[3] || '987654321admin';
    
    console.log(`Resetando senha para usuário: ${username}`);
    
    try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        
        db.run(
            'UPDATE users SET password = ? WHERE username = ?',
            [hashedPassword, username],
            function(err) {
                if (err) {
                    console.error('Erro ao resetar senha:', err);
                } else if (this.changes === 0) {
                    console.log('Usuário não encontrado. Criando novo usuário...');
                    
                    // Criar novo usuário se não existir
                    db.run(
                        'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
                        [username, hashedPassword, 'admin@localhost'],
                        function(err) {
                            if (err) {
                                console.error('Erro ao criar usuário:', err);
                            } else {
                                console.log(`✅ Usuário ${username} criado com sucesso!`);
                                console.log(`Senha: ${newPassword}`);
                            }
                            db.close();
                        }
                    );
                } else {
                    console.log(`✅ Senha resetada com sucesso para: ${username}`);
                    console.log(`Nova senha: ${newPassword}`);
                    db.close();
                }
            }
        );
    } catch (error) {
        console.error('Erro:', error);
        db.close();
    }
}

resetPassword();