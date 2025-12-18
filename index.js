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
    polling: {
        interval: 100,
        autoStart: true,
        params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query', 'document']
        }
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

// ================= IMPROVED ESCAPE FUNCTION =================

function escapeMarkdownV2(text) {
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

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString()
        .replace(/_/g, '\\_')
        .replace(/\*/g, '\\*')
        .replace(/`/g, '\\`')
        .replace(/\[/g, '\\[')
        .replace(/\]/g, '\\]');
}

// ================= HELPER FUNCTIONS =================

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    const user = await usersCol.findOne({ user_id: userId });
    return !!user;
}

async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
        const safeId = new ObjectId(String(projId));
        
        await projectsCol.updateOne(
            { _id: safeId },
            { $pull: { files: { name: relativePath } } }
        );
        
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
            await safeSendMessage(chatId, "❌ Invalid format. Use: `folder_name file1 file2 ...`", { parse_mode: 'Markdown' });
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
                
                await safeSendMessage(chatId, `📂 Moved: \`${fileName}\` ➡️ \`${folderName}/\``, { parse_mode: 'Markdown' });
            } else {
                await safeSendMessage(chatId, `⚠️ File not found: \`${fileName}\``, { parse_mode: 'Markdown' });
            }
        }
        
        if (movedCount > 0) {
            await safeSendMessage(chatId, `✅ Successfully moved ${movedCount} file(s) to \`${folderName}/\``, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error("Error moving files:", e);
        await safeSendMessage(chatId, `❌ Error moving files: ${e.message}`);
    }
}

// ================= SAFE MESSAGE SENDING =================

async function safeSendMessage(chatId, text, options = {}) {
    try {
        // If parse_mode is MarkdownV2 and there might be issues, convert to Markdown
        if (options.parse_mode === 'MarkdownV2') {
            const escapedText = escapeMarkdownV2(text);
            return await bot.sendMessage(chatId, escapedText, options);
        }
        
        return await bot.sendMessage(chatId, text, options);
    } catch (e) {
        console.error("Error sending message:", e.message);
        // اگر مارک ڈاؤن ایرر ہے تو سادہ متن بھیج دیں
        if (e.message.includes("can't parse entities")) {
            try {
                const plainOptions = { ...options };
                delete plainOptions.parse_mode; // Remove parse_mode
                return await bot.sendMessage(chatId, text, plainOptions);
            } catch (err) {
                console.error("Even plain text failed:", err.message);
                // Last resort: send without any formatting
                return await bot.sendMessage(chatId, text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, ''));
            }
        }
        return null;
    }
}

async function safeEditMessage(chatId, messageId, text, reply_markup = null) {
    try {
        const options = {
            chat_id: chatId,
            message_id: messageId,
            text: text,
            parse_mode: 'Markdown'
        };
        
        if (reply_markup) {
            options.reply_markup = reply_markup;
        }
        
        return await bot.editMessageText(text, options);
    } catch (e) {
        if (e.message.includes("message is not modified")) {
            return null;
        }
        if (e.message.includes("can't parse entities")) {
            try {
                const plainText = text.replace(/[\\_*[\]()~`>#+\-=|{}.!]/g, '');
                return await bot.editMessageText(plainText, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: reply_markup
                });
            } catch (err) {
                console.error("Even plain text edit failed:", err.message);
            }
        }
        console.error("Error editing message:", e.message);
        return null;
    }
}

// ================= PROCESS MANAGEMENT =================

async function forceStopProject(projId) {
    try {
        const pid = projId.toString();
        if (ACTIVE_SESSIONS[pid]) {
            const session = ACTIVE_SESSIONS[pid];
            console.log(`Stopping project ${pid}, PID: ${session.process?.pid}`);
            
            try {
                if (session.logStream) {
                    session.logStream.end();
                }
                
                if (session.process) {
                    session.process.kill('SIGKILL');
                }
            } catch (killError) {
                console.log(`Process kill error: ${killError.message}`);
            }
            
            delete ACTIVE_SESSIONS[pid];
        }
        
        await projectsCol.updateOne(
            { _id: new ObjectId(String(projId)) },
            { $set: { status: "Stopped" } }
        );
        
        await new Promise(resolve => setTimeout(resolve, 1500));
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
        
        await forceStopProject(projId);
        
        const projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
        if (!projectData) {
            if (!silent && chatId) {
                await safeSendMessage(chatId, "❌ Project not found!");
            }
            return;
        }

        const basePath = path.join(__dirname, 'deployments', userId.toString(), projectData.name);
        if (!fs.existsSync(basePath)) {
            fs.mkdirSync(basePath, { recursive: true });
        }

        // Write files to disk
        if (projectData.files && projectData.files.length > 0) {
            console.log(`Writing ${projectData.files.length} files to disk`);
            for (const file of projectData.files) {
                const fullPath = path.join(basePath, file.name);
                const dir = path.dirname(fullPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                if (file.content) {
                    const buffer = file.content.buffer ? Buffer.from(file.content.buffer) : 
                                 file.content.data ? Buffer.from(file.content.data) : 
                                 Buffer.isBuffer(file.content) ? file.content : 
                                 Buffer.from(file.content);
                    fs.writeFileSync(fullPath, buffer);
                }
            }
        }

        if (!silent && chatId) {
            await safeSendMessage(chatId, `⏳ Starting *${escapeMarkdown(projectData.name)}*...`, { parse_mode: 'Markdown' });
        }

        // Install dependencies
        const packagePath = path.join(basePath, 'package.json');
        if (fs.existsSync(packagePath)) {
            console.log("Installing npm dependencies...");
            if (!silent && chatId) {
                await safeSendMessage(chatId, "📦 Installing dependencies...");
            }
            
            const install = spawn('npm', ['install', '--omit=dev'], { 
                cwd: basePath, 
                shell: true,
                stdio: 'pipe'
            });
            
            await new Promise(resolve => {
                install.on('close', resolve);
            });
        }

        // Start the project
        const logFilePath = path.join(LOG_DIR, `${projId}.txt`);
        const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
        
        const child = spawn('node', ['index.js'], { 
            cwd: basePath, 
            shell: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

        ACTIVE_SESSIONS[projId.toString()] = {
            process: child,
            logging: !silent,
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
                const out = data.toString().trim();
                if (!out) return;
                
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] ${out}\n`;
                
                logStream.write(logLine);
                
                const session = ACTIVE_SESSIONS[projId.toString()];
                if (session && session.logging && chatId) {
                    // Check for pairing code
                    const codeMatch = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
                    if (codeMatch) {
                        await safeSendMessage(chatId, `🔑 *Pairing Code:* \`${codeMatch[0]}\``, { parse_mode: 'Markdown' });
                    } 
                    // Send important logs (avoid spam)
                    else if (out.length < 200) {
                        const importantKeywords = ['error', 'Error', 'ERROR', 'warning', 'Warning', 'started', 
                                                 'listening', 'Listening', 'connected', 'Connected', 'failed', 'Failed'];
                        const lowerOut = out.toLowerCase();
                        if (importantKeywords.some(keyword => lowerOut.includes(keyword.toLowerCase())) || out.length < 100) {
                            await safeSendMessage(chatId, `📝 \`${escapeMarkdown(out)}\``, { parse_mode: 'Markdown' });
                        }
                    }
                }
            } catch (e) {
                console.error("Error processing stdout:", e);
            }
        });

        // Handle stderr
        child.stderr.on('data', (data) => {
            const err = data.toString().trim();
            if (err) {
                const timestamp = new Date().toISOString();
                const logLine = `[${timestamp}] [ERROR] ${err}\n`;
                logStream.write(logLine);
                console.error(`Project ${projId} stderr:`, err);
            }
        });

        // Handle process exit
        child.on('close', async (code) => {
            console.log(`Project ${projId} closed with code ${code}`);
            
            const session = ACTIVE_SESSIONS[projId.toString()];
            if (session) {
                if (session.logStream) {
                    session.logStream.end();
                }
                
                if (!silent && session.chatId && code !== 0) {
                    await safeSendMessage(session.chatId, 
                        `⚠️ Project *${escapeMarkdown(session.name)}* stopped with code ${code}`, { parse_mode: 'Markdown' });
                }
                
                delete ACTIVE_SESSIONS[projId.toString()];
            }
            
            await projectsCol.updateOne(
                { _id: new ObjectId(String(projId)) },
                { $set: { status: "Stopped" } }
            );
        });

        child.on('error', async (error) => {
            console.error(`Project ${projId} error:`, error);
            logStream.write(`[${new Date().toISOString()}] [PROCESS ERROR] ${error.message}\n`);
            
            if (!silent && chatId) {
                await safeSendMessage(chatId, `❌ Error starting project: ${error.message}`);
            }
        });

        return true;
    } catch (e) {
        console.error(`Error in startProject for ${projId}:`, e);
        if (!silent && chatId) {
            await safeSendMessage(chatId, `❌ Failed to start project: ${e.message}`);
        }
        return false;
    }
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        if (!text) return;

        if (text === "/start") {
            if (!await isAuthorized(userId)) {
                await safeSendMessage(chatId, "❌ You are not authorized to use this bot.");
                return;
            }

            // Build keyboard based on user type
            const keyboard = {
                inline_keyboard: [
                    [{ text: "🚀 Deploy Project", callback_data: "deploy_new" }],
                    [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]
                ]
            };
            
            if (OWNER_IDS.includes(userId)) {
                keyboard.inline_keyboard.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
            }
            
            await safeSendMessage(chatId, "👋 *Node Master Bot*\n\nSelect an option:", {
                parse_mode: 'Markdown',
                reply_markup: keyboard
            });
            return;
        }

        if (USER_STATE[userId]) {
            const state = USER_STATE[userId];
            
            if (text === "✅ Done / Apply Actions") {
                const projId = state.data._id;
                delete USER_STATE[userId];
                
                await bot.sendMessage(chatId, "⚙️ Applying changes and restarting...", { 
                    reply_markup: { remove_keyboard: true }
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
                    await safeSendMessage(chatId, "❌ Please enter a valid project name (min 2 characters)");
                    return;
                }
                
                const existingProject = await projectsCol.findOne({ 
                    user_id: userId, 
                    name: text 
                });
                
                if (existingProject) {
                    await safeSendMessage(chatId, "❌ A project with this name already exists. Please choose a different name.");
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
                
                await safeSendMessage(chatId, `✅ Project *${escapeMarkdown(text)}* created.`, {
                    parse_mode: 'Markdown'
                });
                
                await bot.sendMessage(chatId, `📁 Now send your project files (JavaScript, JSON, etc.) one by one.`, {
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
            
            await safeSendMessage(chatId, `📥 Receiving file: ${fileName}...`);
            
            try {
                const fileLink = await bot.getFileLink(fileId);
                const response = await fetch(fileLink);
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const buffer = await response.arrayBuffer();
                const success = await saveFileToStorage(userId, state.data._id, fileName, Buffer.from(buffer));
                
                if (success) {
                    await safeSendMessage(chatId, `✅ File saved: \`${fileName}\``, { parse_mode: 'Markdown' });
                } else {
                    await safeSendMessage(chatId, `❌ Failed to save: \`${fileName}\``, { parse_mode: 'Markdown' });
                }
            } catch (e) {
                console.error("Error downloading file:", e);
                await safeSendMessage(chatId, `❌ Error downloading file: ${e.message}`);
            }
        }
    } catch (e) {
        console.error("Error in document handler:", e);
    }
});

// ================= CALLBACK HANDLERS =================

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

        // جواب فوری دیں
        await bot.answerCallbackQuery(query.id).catch(() => {});

        if (data === "owner_panel") {
            if (!OWNER_IDS.includes(userId)) {
                return;
            }
            
            await safeEditMessage(chatId, messageId, "👑 *Owner Panel*", {
                inline_keyboard: [
                    [{ text: "🔑 Generate Key", callback_data: "gen_key" }],
                    [{ text: "📜 List Keys", callback_data: "list_keys" }],
                    [{ text: "📊 Statistics", callback_data: "stats" }],
                    [{ text: "🔙 Back", callback_data: "main_menu" }]
                ]
            });
        }

        if (data === "manage_projects") {
            const projects = await projectsCol.find({ user_id: userId }).toArray();
            
            if (projects.length === 0) {
                await safeEditMessage(chatId, messageId, "📂 *You have no projects yet.*", {
                    inline_keyboard: [
                        [{ text: "🚀 Create New Project", callback_data: "deploy_new" }],
                        [{ text: "🔙 Main Menu", callback_data: "main_menu" }]
                    ]
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
            
            await safeEditMessage(chatId, messageId, "📂 *Select Project:*", {
                inline_keyboard: keyboard
            });
        }

        if (data.startsWith("menu_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            if (!proj) {
                await safeSendMessage(chatId, "❌ Project not found");
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
            
            await safeEditMessage(chatId, messageId, statusText, {
                inline_keyboard: keyboard
            });
        }

        if (data.startsWith("tog_run_")) {
            const projId = data.split('_')[2];
            
            if (ACTIVE_SESSIONS[projId]) {
                await forceStopProject(projId);
                await safeSendMessage(chatId, `🛑 Stopped project`);
            } else {
                await startProject(userId, projId, chatId);
            }
            
            // Refresh menu
            setTimeout(() => {
                bot.answerCallbackQuery({
                    id: query.id,
                    from: query.from,
                    message: query.message,
                    chat_instance: query.chat_instance,
                    data: `menu_${projId}`
                });
            }, 1500);
        }

        if (data.startsWith("tog_log_")) {
            const projId = data.split('_')[2];
            
            if (ACTIVE_SESSIONS[projId]) {
                ACTIVE_SESSIONS[projId].logging = !ACTIVE_SESSIONS[projId].logging;
                const status = ACTIVE_SESSIONS[projId].logging ? "enabled" : "disabled";
                await safeSendMessage(chatId, `📝 Logging ${status} for project`);
            }
            
            setTimeout(() => {
                bot.answerCallbackQuery({
                    id: query.id,
                    from: query.from,
                    message: query.message,
                    chat_instance: query.chat_instance,
                    data: `menu_${projId}`
                });
            }, 500);
        }

        if (data.startsWith("upd_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            if (!proj) {
                await safeSendMessage(chatId, "❌ Project not found");
                return;
            }
            
            await forceStopProject(projId);
            
            USER_STATE[userId] = { 
                step: "update_files", 
                data: proj 
            };
            
            const messageText = `📝 *UPDATE MODE:* ${proj.name}\n\n` +
                              `Send files to replace existing ones.\n` +
                              `Use move command to organize: \`folder_name file1.js file2.js\`\n\n` +
                              `Click "✅ Done / Apply Actions" when finished.`;
            
            await safeSendMessage(chatId, messageText, { parse_mode: 'Markdown' });
            
            await bot.sendMessage(chatId, `📁 Now you can send files. Each new file will replace the existing one with same name.`, {
                reply_markup: { 
                    resize_keyboard: true, 
                    keyboard: [[{ text: "✅ Done / Apply Actions" }]] 
                }
            });
        }

        if (data.startsWith("renew_")) {
            const projId = data.split('_')[1];
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            
            await forceStopProject(projId);
            
            const basePath = path.join(__dirname, 'deployments', userId.toString(), proj.name);
            
            // Clean session files
            if (fs.existsSync(basePath)) {
                const files = fs.readdirSync(basePath);
                files.forEach(file => {
                    if (file.includes('session') || file.includes('auth') || file.includes('creds')) {
                        const filePath = path.join(basePath, file);
                        try {
                            fs.rmSync(filePath, { recursive: true, force: true });
                        } catch (e) {
                            console.log(`Error removing ${filePath}:`, e.message);
                        }
                    }
                });
            }
            
            await safeSendMessage(chatId, "🔄 Session cleaned. Restarting...");
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
                } else {
                    await safeSendMessage(chatId, "Log file is empty");
                }
            } else {
                await safeSendMessage(chatId, "No logs available yet");
            }
        }

        if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            
            await safeEditMessage(chatId, messageId, "📝 *Enter a name for your new project:*", {
                inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "main_menu" }]]
            });
            
            await safeSendMessage(chatId, "Please enter a name for your new project:");
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
            
            await safeEditMessage(chatId, messageId, "🏠 *Main Menu*", keyboard);
        }

    } catch (e) {
        console.error("Error in callback query:", e);
        try {
            await bot.answerCallbackQuery(query.id, { 
                text: "❌ Error: " + e.message.slice(0, 50)
            });
        } catch (err) {
            // Ignore answer errors
        }
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
        
        await projectsCol.createIndex({ user_id: 1 });
        await projectsCol.createIndex({ status: 1 });
        
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
        console.log("Bot instance conflict. Waiting 5 seconds...");
        setTimeout(() => {
            try {
                bot.stopPolling();
                setTimeout(() => bot.startPolling(), 1000);
            } catch (e) {
                console.log("Error restarting polling:", e.message);
            }
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