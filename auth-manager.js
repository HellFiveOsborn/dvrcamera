const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

class AuthManager {
    constructor() {
        this.dbPath = path.join(__dirname, 'database.db');
        this.db = null;
        this.saltRounds = 10;
        this.init();
    }

    init() {
        // Criar banco de dados se não existir
        this.db = new sqlite3.Database(this.dbPath, (err) => {
            if (err) {
                console.error('[Auth] Erro ao abrir banco de dados:', err);
            } else {
                console.log('[Auth] Banco de dados conectado');
                this.createTables();
            }
        });
    }

    createTables() {
        // Criar tabela de usuários
        this.db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password TEXT NOT NULL,
                email TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                last_login DATETIME,
                is_active INTEGER DEFAULT 1
            )
        `, (err) => {
            if (err) {
                console.error('[Auth] Erro ao criar tabela users:', err);
            } else {
                console.log('[Auth] Tabela users pronta');
                this.createDefaultUser();
            }
        });

        // Criar tabela de sessões
        this.db.run(`
            CREATE TABLE IF NOT EXISTS sessions (
                sid TEXT PRIMARY KEY,
                sess TEXT NOT NULL,
                expired DATETIME NOT NULL
            )
        `, (err) => {
            if (err) {
                console.error('[Auth] Erro ao criar tabela sessions:', err);
            } else {
                console.log('[Auth] Tabela sessions pronta');
            }
        });

        // Criar tabela de logs de acesso
        this.db.run(`
            CREATE TABLE IF NOT EXISTS access_logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                action TEXT,
                ip_address TEXT,
                user_agent TEXT,
                timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        `, (err) => {
            if (err) {
                console.error('[Auth] Erro ao criar tabela access_logs:', err);
            } else {
                console.log('[Auth] Tabela access_logs pronta');
            }
        });
    }

    async createDefaultUser() {
        // Criar usuário padrão do .env se não existir
        const defaultUsername = process.env.DEFAULT_USERNAME || 'admin';
        const defaultPassword = process.env.DEFAULT_PASSWORD || 'admin123';
        const defaultEmail = process.env.DEFAULT_EMAIL || 'admin@localhost';

        this.db.get('SELECT * FROM users WHERE username = ?', [defaultUsername], async (err, row) => {
            if (err) {
                console.error('[Auth] Erro ao verificar usuário padrão:', err);
            } else if (!row) {
                // Criar usuário padrão
                const hashedPassword = await bcrypt.hash(defaultPassword, this.saltRounds);
                this.db.run(
                    'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
                    [defaultUsername, hashedPassword, defaultEmail],
                    (err) => {
                        if (err) {
                            console.error('[Auth] Erro ao criar usuário padrão:', err);
                        } else {
                            console.log(`[Auth] Usuário padrão criado: ${defaultUsername}`);
                        }
                    }
                );
            } else {
                console.log('[Auth] Usuário padrão já existe');
            }
        });
    }

    async validateUser(username, password) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT * FROM users WHERE username = ? AND is_active = 1',
                [username],
                async (err, user) => {
                    if (err) {
                        reject(err);
                    } else if (!user) {
                        resolve(null);
                    } else {
                        // Verificar senha
                        const match = await bcrypt.compare(password, user.password);
                        if (match) {
                            // Atualizar último login
                            this.db.run(
                                'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?',
                                [user.id]
                            );
                            resolve(user);
                        } else {
                            resolve(null);
                        }
                    }
                }
            );
        });
    }

    async createUser(username, password, email = null) {
        return new Promise(async (resolve, reject) => {
            try {
                const hashedPassword = await bcrypt.hash(password, this.saltRounds);
                this.db.run(
                    'INSERT INTO users (username, password, email) VALUES (?, ?, ?)',
                    [username, hashedPassword, email],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({ id: this.lastID, username, email });
                        }
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    }

    async updatePassword(userId, newPassword) {
        return new Promise(async (resolve, reject) => {
            try {
                const hashedPassword = await bcrypt.hash(newPassword, this.saltRounds);
                this.db.run(
                    'UPDATE users SET password = ? WHERE id = ?',
                    [hashedPassword, userId],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(this.changes > 0);
                        }
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    }

    async getUserById(userId) {
        return new Promise((resolve, reject) => {
            this.db.get(
                'SELECT id, username, email, created_at, last_login, is_active FROM users WHERE id = ?',
                [userId],
                (err, user) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(user);
                    }
                }
            );
        });
    }

    async getAllUsers() {
        return new Promise((resolve, reject) => {
            this.db.all(
                'SELECT id, username, email, created_at, last_login, is_active FROM users',
                [],
                (err, users) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(users);
                    }
                }
            );
        });
    }

    async deactivateUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET is_active = 0 WHERE id = ?',
                [userId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes > 0);
                    }
                }
            );
        });
    }

    async activateUser(userId) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'UPDATE users SET is_active = 1 WHERE id = ?',
                [userId],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.changes > 0);
                    }
                }
            );
        });
    }

    async logAccess(userId, action, ipAddress, userAgent) {
        return new Promise((resolve, reject) => {
            this.db.run(
                'INSERT INTO access_logs (user_id, action, ip_address, user_agent) VALUES (?, ?, ?, ?)',
                [userId, action, ipAddress, userAgent],
                function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(this.lastID);
                    }
                }
            );
        });
    }

    async getAccessLogs(userId = null, limit = 100) {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM access_logs';
            let params = [];
            
            if (userId) {
                query += ' WHERE user_id = ?';
                params.push(userId);
            }
            
            query += ' ORDER BY timestamp DESC LIMIT ?';
            params.push(limit);
            
            this.db.all(query, params, (err, logs) => {
                if (err) {
                    reject(err);
                } else {
                    resolve(logs);
                }
            });
        });
    }

    close() {
        if (this.db) {
            this.db.close((err) => {
                if (err) {
                    console.error('[Auth] Erro ao fechar banco de dados:', err);
                } else {
                    console.log('[Auth] Banco de dados fechado');
                }
            });
        }
    }
}

module.exports = AuthManager;