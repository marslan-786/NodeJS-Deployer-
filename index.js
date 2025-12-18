const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb'); 
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; 
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; 
const OWNER_IDS = [8167904992, 7134046678, 6022286935]; 

// ================= SETUP =================
const bot = new TelegramBot(TOKEN, { 
    polling: true,
    request: {
        proxy: process.env.PROXY || null
    }
});

const client = new MongoClient(MONGO_URL);

let db, projectsCol, keysCol, usersCol;
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ================= IMPROVED HELPER FUNCTIONS =================

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString()
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
        .replace(/~/g, '\\~')
        .replace(/`/g, '\\`')
        .replace(/>/g, '\\>')
        .replace(/#/g, '\\#')
        .replace(/\+/g, '\\+')
        .replace(/-/g, '\\-')
        .replace(/=/g, '\\=')
        .replace(/\|/g, '\\|')
        .replace(/\{/g, '\\{')
        .replace(/\}/g, '\\}')
        .replace(/\./g, '\\.')
        .replace(/!/g, '\\!');
}

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    const user = await usersCol.findOne({ user_id: userId });
    return !!user;
}

async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
        const safeId = new ObjectId(String(projId));
        
        // First remove existing file with same name
        await projectsCol.updateOne(
            { _id: safeId },
            { $pull: { files: { name: relativePath } } }
        );
        
        // Add new file
        await projectsCol.updateOne(
            { _id: safeId },
            { $push: { files: { name: relativePath, content: contentBuffer } } }
        );
        
        return true;
    } catch (e) {
        console.error("Error saving file:", e.message);
        return false;
    }
}

async function moveFilesToFolder(userId, projData, inputLine, chatId) {
    try {
        const parts = inputLine.trim().split(/\s+/);
        if (parts.length < 2) {
            await bot.sendMessage(chatId, "❌ Invalid format. Use: `folder_name file1 file2 ...`", { parse_mode: 'Markdown' });
            return;
        }

        const folderName = parts[0];
        const filesToMove = parts.slice(1);
        const basePath = path.join(__dirname, 'deployments', userId.toString(), projData.name);
        const targetDir = path.join(basePath, folderName);

        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }

        let movedCount = 0;
        for (const fileName of filesToMove) {
            const oldPath = path.join(basePath, fileName);
            if (fs.existsSync(oldPath)) {
                const content = fs.readFileSync(oldPath);
                const relativeNewPath = path.join(folderName, fileName).replace(/\\/g, '/');
                
                await saveFileToStorage(userId, projData._id, relativeNewPath, content);
                await projectsCol.updateOne(
                    { _id: new ObjectId(String(projData._id)) },
                    { $pull: { files: { name: fileName } } }
                );
                
                const newPath = path.join(targetDir, fileName);
                fs.renameSync(oldPath, newPath);
                movedCount++;
                
                await bot.sendMessage(chatId, `📂 Moved: \`${fileName}\` ➡️ \`${folderName}/\``, { parse_mode: 'Markdown' });
            } else {
                await bot.sendMessage(chatId, `⚠️ File not found: \`${fileName}\``, { parse_mode: 'Markdown' });
            }
        }
        
        if (movedCount > 0) {
            await bot.sendMessage(chatId, `✅ Successfully moved ${movedCount} file(s) to \`${folderName}/\``, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error("Error moving files:", e);
        await bot.sendMessage(chatId, `❌ Error moving files: ${e.message}`, { parse_mode: 'Markdown' });
    }
}

// ================= ENHANCED PROCESS MANAGEMENT =================

async function forceStopProject(projId) {
    try {
        const pid = projId.toString();
        if (ACTIVE_SESSIONS[pid]) {
            const session = ACTIVE_SESSIONS[pid];
            console.log(`Stopping project ${pid}, PID: ${session.process.pid}`);
            
            try {
                if (session.logStream) {
                    session.logStream.end();
                    session.logStream = null;
                }
                
                if (session.process) {
                    if (process.platform === 'win32') {
                        spawn("taskkill", ["/pid", session.process.pid, "/f", "/t"]);
                    } else {
                        process.kill(-session.process.pid, 'SIGKILL');
                    }
                    session.process.kill('SIGKILL');
                }
            } catch (killError) {
                console.log(`Process kill error (may already be dead): ${killError.message}`);
            }
            
            delete ACTIVE_SESSIONS[pid];
        }
        
        await projectsCol.updateOne(
            { _id: new ObjectId(String(projId)) },
            { $set: { status: "Stopped" } }
        );
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log(`Project ${pid} stopped successfully`);
        return true;
    } catch (e) {
        console.error(`Error stopping project ${projId}:`, e);
        return false;
    }
}

async function startProject(userId, projId, chatId, silent = false) {
    try {
        console.log(`Starting project ${projId} for user ${userId}`);
        
        // First stop if running
        await forceStopProject(projId);
        
        const projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
        if (!projectData) {
            if (!silent && chatId) {
                await bot.sendMessage(chatId, "❌ Project not found!", { parse_mode: 'Markdown' });
            }
            return;
        }

        const basePath = path.join(__dirname, 'deployments', userId.toString(), projectData.name);
        if (!fs.existsSync(basePath)) {
            fs.mkdirSync(basePath, { recursive: true });
        }

        // Write all files to disk
        if (projectData.files && projectData.files.length > 0) {
            console.log(`Writing ${projectData.files.length} files to disk`);
            for (const file of projectData.files) {
                const fullPath = path.join(basePath, file.name);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                if (file.content && file.content.buffer) {
                    fs.writeFileSync(fullPath, file.content.buffer);
                } else if (file.content && Buffer.isBuffer(file.content)) {
                    fs.writeFileSync(fullPath, file.content);
                } else if (file.content) {
                    fs.writeFileSync(fullPath, Buffer.from(file.content));
                }
            }
        }

        if (!silent && chatId) {
            await bot.sendMessage(
                chatId, 
                `⏳ Starting *${escapeMarkdown(projectData.name)}*...`, 
                { parse_mode: 'MarkdownV2' }
            ).catch(e => console.log("Send message error:", e.message));
        }

        // Install dependencies if package.json exists
        const packagePath = path.join(basePath, 'package.json');
        if (fs.existsSync(packagePath)) {
            console.log("Installing npm dependencies...");
            if (!silent && chatId) {
                await bot.sendMessage(chatId, "📦 Installing dependencies...", { parse_mode: 'Markdown' });
            }
            
            const install = spawn('npm', ['install', '--production'], { 
                cwd: basePath, 
                shell: true,
                stdio: 'pipe'
            });
            
            await new Promise(resolve => {
                install.on('close', (code) => {
                    console.log(`npm install exited with code ${code}`);
                    resolve();
                });
                
                install.stderr.on('data', (data) => {
                    console.error(`npm install error: ${data.toString()}`);
                });
            });
        }

        // Start the project
        const logFilePath = path.join(LOG_DIR, `${projId}.txt`);
        const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        
        const child = spawn('node', ['index.js'], { 
            cwd: basePath, 
            shell: true,
            detached: process.platform !== 'win32',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Store session information
        ACTIVE_SESSIONS[projId.toString()] = {
            process: child,
            logging: true,
            logStream: logStream,
            chatId: chatId,
            name: projectData.name,
            startTime: new Date()
        };

        await projectsCol.updateOne(
            { _id: new ObjectId(String(projId)) },
            { $set: { status: "Running", lastStarted: new Date() } }
        );

        console.log(`Project ${projId} started with PID: ${child.pid}`);

        // Handle stdout
        child.stdout.on('data', async (data) => {
            try {
                const out = data.toString();
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] ${out}`;
                
                // Write to log file
                logStream.write(logLine);
                
                // Send to Telegram if logging is enabled
                const session = ACTIVE_SESSIONS[projId.toString()];
                if (session && session.logging && chatId) {
                    // Extract pairing code
                    const codeMatch = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
                    if (codeMatch) {
                        await bot.sendMessage(
                            chatId, 
                            `🔑 *Pairing Code:* \`${codeMatch[0]}\``, 
                            { parse_mode: 'Markdown' }
                        ).catch(e => console.log("Pairing code send error:", e.message));
                    } else if (out.trim().length > 0) {
                        // Send only important logs (avoid spam)
                        const importantKeywords = ['error', 'warning', 'started', 'listening', 'connected', 'failed'];
                        const lowerOut = out.toLowerCase();
                        if (importantKeywords.some(keyword => lowerOut.includes(keyword)) || out.length < 100) {
                            const escapedOut = escapeMarkdown(out.trim().slice(0, 300));
                            if (escapedOut.length > 0) {
                                await bot.sendMessage(
                                    chatId, 
                                    `🖥️ \`${escapedOut}\``, 
                                    { parse_mode: 'MarkdownV2' }
                                ).catch(e => {
                                    if (!e.message.includes("message is not modified")) {
                                        console.log("Log send error:", e.message);
                                    }
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.error("Error processing stdout:", e);
            }
        });

        // Handle stderr
        child.stderr.on('data', (data) => {
            const err = data.toString();
            const timestamp = new Date().toISOString();
            const logLine = `[${timestamp}] [ERROR] ${err}`;
            logStream.write(logLine);
            console.error(`Project ${projId} stderr:`, err);
        });

        // Handle process exit
        child.on('close', async (code) => {
            console.log(`Project ${projId} closed with code ${code}`);
            
            const session = ACTIVE_SESSIONS[projId.toString()];
            if (session) {
                if (session.logStream) {
                    session.logStream.write(`\n[${new Date().toISOString()}] Process exited with code ${code}\n`);
                    session.logStream.end();
                }
                
                if (!silent && session.chatId && code !== 0) {
                    await bot.sendMessage(
                        session.chatId,
                        `⚠️ Project *${escapeMarkdown(session.name)}* stopped with code ${code}`,
                        { parse_mode: 'MarkdownV2' }
                    ).catch(e => console.log("Exit message error:", e.message));
                }
                
                delete ACTIVE_SESSIONS[projId.toString()];
            }
            
            await projectsCol.updateOne(
                { _id: new ObjectId(String(projId)) },
                { $set: { status: "Stopped" } }
            );
        });

        // Handle errors
        child.on('error', async (error) => {
            console.error(`Project ${projId} error:`, error);
            logStream.write(`[${new Date().toISOString()}] [PROCESS ERROR] ${error.message}\n`);
            
            if (!silent && chatId) {
                await bot.sendMessage(
                    chatId,
                    `❌ Error starting project: ${error.message}`,
                    { parse_mode: 'Markdown' }
                ).catch(e => console.log("Error message send error:", e.message));
            }
        });

        return true;
    } catch (e) {
        console.error(`Error in startProject for ${projId}:`, e);
        if (!silent && chatId) {
            await bot.sendMessage(
                chatId,
                `❌ Failed to start project: ${e.message}`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
        return false;
    }
}

// ================= IMPROVED HANDLERS =================

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        if (!await isAuthorized(userId)) {
            return;
        }

        if (text === "/start") {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "🚀 Deploy Project", callback_data: "deploy_new" }],
                    [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]
                ]
            };
            
            if (OWNER_IDS.includes(userId)) {
                keyboard.inline_keyboard.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
            }
            
            await bot.sendMessage(chatId, "👋 *Node Master Bot*", { 
                reply_markup: keyboard,
                parse_mode: 'Markdown' 
            });
            return;
        }

        if (USER_STATE[userId]) {
            const state = USER_STATE[userId];
            
            if (text === "✅ Done / Apply Actions") {
                const projId = state.data._id;
                delete USER_STATE[userId];
                
                await bot.sendMessage(chatId, "⚙️ Applying changes and restarting...", { 
                    reply_markup: { remove_keyboard: true },
                    parse_mode: 'Markdown'
                });
                
                await startProject(userId, projId, chatId);
                return;
            }

            if ((state.step === "wait_files" || state.step === "update_files") && text && !text.startsWith('/')) {
                await moveFilesToFolder(userId, state.data, text, chatId);
                return;
            }

            if (state.step === "ask_name") {
                if (!text || text.length < 2) {
                    await bot.sendMessage(chatId, "❌ Please enter a valid project name (min 2 characters)");
                    return;
                }
                
                const existingProject = await projectsCol.findOne({ 
                    user_id: userId, 
                    name: text 
                });
                
                if (existingProject) {
                    await bot.sendMessage(chatId, "❌ A project with this name already exists. Please choose a different name.");
                    return;
                }
                
                const res = await projectsCol.insertOne({ 
                    user_id: userId, 
                    name: text, 
                    files: [], 
                    status: "Stopped",
                    createdAt: new Date()
                });
                
                USER_STATE[userId] = { 
                    step: "wait_files", 
                    data: { _id: res.insertedId, name: text } 
                };
                
                await bot.sendMessage(chatId, `✅ Project *${text}* Created.\n\nSend your project files or use move commands.\n\nExample move command:\n\`folder_name file1.js file2.js\`\n\nClick "✅ Done / Apply Actions" when finished.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { 
                        resize_keyboard: true, 
                        keyboard: [[{ text: "✅ Done / Apply Actions" }]] 
                    }
                });
            }
        }
    } catch (e) {
        console.error("Error in message handler:", e);
    }
});

bot.on('document', async (msg) => {
    try {
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const state = USER_STATE[userId];
        
        if (state && (state.step === "wait_files" || state.step === "update_files")) {
            const fileId = msg.document.file_id;
            const fileName = msg.document.file_name;
            
            await bot.sendMessage(chatId, `📥 Receiving file: ${fileName}...`, { parse_mode: 'Markdown' });
            
            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await fetch(fileLink);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const buffer = await response.arrayBuffer();
                const success = await saveFileToStorage(userId, state.data._id, fileName, Buffer.from(buffer));
                
                if (success) {
                    await bot.sendMessage(chatId, `✅ File saved: \`${fileName}\``, { parse_mode: 'Markdown' });
                } else {
                    await bot.sendMessage(chatId, `❌ Failed to save: \`${fileName}\``, { parse_mode: 'Markdown' });
                }
            } catch (e) {
                console.error("Error downloading file:", e);
                await bot.sendMessage(chatId, `❌ Error downloading file: ${e.message}`, { parse_mode: 'Markdown' });
            }
        }
    } catch (e) {
        console.error("Error in document handler:", e);
    }
});

// ================= ENHANCED CALLBACKS =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
        if (!await isAuthorized(userId)) {
            await bot.answerCallbackQuery(query.id, { text: "❌ Not authorized" });
            return;
        }

        if (data === "owner_panel") {
            if (!OWNER_IDS.includes(userId)) {
                await bot.answerCallbackQuery(query.id, { text: "❌ Owner only" });
                return;
            }
            
            await bot.editMessageText("👑 *Owner Panel*", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🔑 Generate Key", callback_data: "gen_key" }],
                        [{ text: "📜 List Keys", callback_data: "list_keys" }],
                        [{ text: "📊 Statistics", callback_data: "stats" }],
                        [{ text: "🔙 Back", callback_data: "main_menu" }]
                    ]
                },
                parse_mode: 'Markdown'
            }).catch(e => {
                if (!e.message.includes("message is not modified")) {
                    console.error("Edit message error:", e.message);
                }
            });
        }

        if (data === "manage_projects") {
            const projects = await projectsCol.find({ user_id: userId }).toArray();
            
            if (projects.length === 0) {
                const keyboard = {
                    inline_keyboard: [
                        [{ text: "🚀 Create New Project", callback_data: "deploy_new" }],
                        [{ text: "🔙 Main Menu", callback_data: "main_menu" }]
                    ]
                };
                
                await bot.editMessageText("📂 *You have no projects yet.*", {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                }).catch(e => {
                    if (!e.message.includes("message is not modified")) {
                        console.error("Edit message error:", e.message);
                    }
                });
                return;
            }
            
            const keyboard = projects.map(p => [
                { 
                    text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, 
                    callback_data: `menu_${p._id}` 
                }
            ]);
            
            keyboard.push([{ text: "🔙 Main Menu", callback_data: "main_menu" }]);
            
            await bot.editMessageText("📂 *Select Project:*", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'Markdown'
            }).catch(e => {
                if (!e.message.includes("message is not modified")) {
                    console.error("Edit message error:", e.message);
                }
            });
        }

        if (data.startsWith("menu_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            if (!proj) {
                await bot.answerCallbackQuery(query.id, { text: "❌ Project not found" });
                return;
            }
            
            const isRunning = ACTIVE_SESSIONS[projId] ? true : false;
            const isLogging = ACTIVE_SESSIONS[projId]?.logging || false;
            
            const keyboard = [
                [
                    { 
                        text: isRunning ? "🛑 Stop" : "▶️ Start", 
                        callback_data: `tog_run_${projId}` 
                    }, 
                    { 
                        text: isLogging ? "🔇 Mute Logs" : "🔊 Unmute Logs", 
                        callback_data: `tog_log_${projId}` 
                    }
                ],
                [
                    { text: "📝 Update Files", callback_data: `upd_${projId}` }, 
                    { text: "📥 Download Logs", callback_data: `dl_log_${projId}` }
                ],
                [
                    { text: "🔄 Renew Session", callback_data: `renew_${projId}` },
                    { text: "🗑️ Delete", callback_data: `del_${projId}` }
                ],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            
            const statusText = `⚙️ *Project:* ${escapeMarkdown(proj.name)}\n` +
                             `📊 *Status:* ${isRunning ? '🟢 Running' : '🔴 Stopped'}\n` +
                             `📅 *Created:* ${proj.createdAt ? new Date(proj.createdAt).toLocaleDateString() : 'N/A'}\n` +
                             `📁 *Files:* ${proj.files ? proj.files.length : 0}`;
            
            await bot.editMessageText(statusText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'MarkdownV2'
            }).catch(e => {
                if (!e.message.includes("message is not modified")) {
                    console.error("Edit message error:", e.message);
                }
            });
        }

        if (data.startsWith("tog_run_")) {
            const projId = data.split('_')[2];
            
            await bot.answerCallbackQuery(query.id, { text: "Processing..." });
            
            if (ACTIVE_SESSIONS[projId]) {
                await forceStopProject(projId);
                await bot.sendMessage(chatId, `🛑 Stopped project`);
            } else {
                await startProject(userId, projId, chatId);
            }
            
            setTimeout(() => {
                bot.answerCallbackQuery({ ...query, data: `menu_${projId}` });
            }, 1500);
        }

        if (data.startsWith("tog_log_")) {
            const projId = data.split('_')[2];
            
            if (ACTIVE_SESSIONS[projId]) {
                ACTIVE_SESSIONS[projId].logging = !ACTIVE_SESSIONS[projId].logging;
                const status = ACTIVE_SESSIONS[projId].logging ? "enabled" : "disabled";
                
                await bot.answerCallbackQuery(query.id, { 
                    text: `Logging ${status}` 
                });
                
                await bot.sendMessage(
                    chatId, 
                    `📝 Logging ${status} for project`
                );
            }
            
            setTimeout(() => {
                bot.answerCallbackQuery({ ...query, data: `menu_${projId}` });
            }, 500);
        }

        if (data.startsWith("upd_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            await forceStopProject(projId);
            
            USER_STATE[userId] = { 
                step: "update_files", 
                data: proj 
            };
            
            await bot.sendMessage(chatId, `📝 *Update Mode:* ${escapeMarkdown(proj.name)}\n\nSend files to replace existing ones.\nUse move command to organize: \`folder_name file1.js file2.js\`\n\nClick "✅ Done / Apply Actions" when finished.`, {
                parse_mode: 'MarkdownV2',
                reply_markup: { 
                    resize_keyboard: true, 
                    keyboard: [[{ text: "✅ Done / Apply Actions" }]] 
                }
            });
            
            await bot.answerCallbackQuery(query.id, { text: "Update mode activated" });
        }

        if (data.startsWith("renew_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            await bot.answerCallbackQuery(query.id, { text: "Renewing session..." });
            
            await forceStopProject(projId);
            
            const basePath = path.join(__dirname, 'deployments', userId.toString(), proj.name);
            
            // Clean session files
            const sessionPatterns = ['session', 'auth_info', 'creds'];
            sessionPatterns.forEach(pattern => {
                const files = fs.readdirSync(basePath).filter(f => f.includes(pattern));
                files.forEach(file => {
                    const filePath = path.join(basePath, file);
                    try {
                        if (fs.existsSync(filePath)) {
                            fs.rmSync(filePath, { recursive: true, force: true });
                            console.log(`Removed session file: ${filePath}`);
                        }
                    } catch (e) {
                        console.error(`Error removing ${filePath}:`, e.message);
                    }
                });
            });
            
            await bot.sendMessage(chatId, "🔄 Session cleaned. Restarting...");
            await startProject(userId, projId, chatId);
        }

        if (data.startsWith("dl_log_")) {
            const projId = data.split('_')[2];
            const logPath = path.join(LOG_DIR, `${projId}.txt`);
            
            if (fs.existsSync(logPath)) {
                const stats = fs.statSync(logPath);
                if (stats.size > 0) {
                    await bot.sendDocument(chatId, logPath, {
                        caption: `📊 Logs for project ${projId}`
                    });
                    await bot.answerCallbackQuery(query.id, { text: "Logs sent" });
                } else {
                    await bot.answerCallbackQuery(query.id, { text: "Log file is empty" });
                }
            } else {
                await bot.answerCallbackQuery(query.id, { text: "No logs available yet" });
            }
        }

        if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            
            await bot.editMessageText("📝 *Enter a name for your new project:*", {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            }).catch(e => {
                if (!e.message.includes("message is not modified")) {
                    console.error("Edit message error:", e.message);
                }
            });
            
            await bot.sendMessage(chatId, "Please enter a name for your new project:");
        }

        if (data === "main_menu") {
            const keyboard = {
                inline_keyboard: [
                    [{ text: "🚀 Deploy Project", callback_data: "deploy_new" }],
                    [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]
                ]
            };
            
            if (OWNER_IDS.includes(userId)) {
                keyboard.inline_keyboard.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
            }
            
            await bot.editMessageText("🏠 *Main Menu*", {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            }).catch(e => {
                if (!e.message.includes("message is not modified")) {
                    console.error("Edit message error:", e.message);
                }
            });
        }

    } catch (e) {
        console.error("Error in callback query:", e);
        await bot.answerCallbackQuery(query.id, { 
            text: "❌ Error: " + e.message 
        }).catch(() => {});
    }
});

// ================= DATABASE CONNECTION =================

async function connectDB() {
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        
        console.log("✅ Connected to MongoDB");
        
        // Create indexes
        await projectsCol.createIndex({ user_id: 1 });
        await projectsCol.createIndex({ status: 1 });
        
        // Restore running projects
        await restoreProjects();
        
    } catch (e) {
        console.error("MongoDB connection error:", e);
        setTimeout(connectDB, 5000);
    }
}

async function restoreProjects() {
    try {
        const running = await projectsCol.find({ status: "Running" }).toArray();
        console.log(`Restoring ${running.length} projects...`);
        
        for (const proj of running) {
            console.log(`Restoring project: ${proj.name} (${proj._id})`);
            await startProject(proj.user_id, proj._id, null, true);
        }
    } catch (e) {
        console.error("Error restoring projects:", e);
    }
}

// ================= ERROR HANDLING =================

bot.on('polling_error', (error) => {
    console.error("Polling error:", error.message);
    
    if (error.message.includes("409 Conflict")) {
        console.log("Bot instance conflict detected. Restarting polling...");
        setTimeout(() => {
            bot.stopPolling();
            bot.startPolling();
        }, 5000);
    }
});

bot.on('error', (error) => {
    console.error("Bot error:", error);
});

process.on('uncaughtException', (error) => {
    console.error("Uncaught exception:", error);
});

process.on('unhandledRejection', (error) => {
    console.error("Unhandled rejection:", error);
});

// Start the bot
connectDB();

console.log("🤖 Bot is starting...");