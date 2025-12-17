const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
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
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; // To track file sync watchers
const LOG_DIR = path.join(__dirname, 'temp_logs');

// Clean up logs on start
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

async function connectDB() {
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        console.log("✅ Connected to MongoDB");
        
        // 🔄 ON STARTUP: RESTORE EVERYTHING FROM DB
        setTimeout(restoreProjects, 3000); 
    } catch (e) {
        console.error("❌ DB Error:", e);
        process.exit(1);
    }
}
connectDB();

// ================= HELPER FUNCTIONS =================

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString().replace(/[_*[\]()~\x60>#+\-=|{}.!]/g, '\\$&');
}

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    try {
        const user = await usersCol.findOne({ user_id: userId });
        return !!user;
    } catch (e) { return false; }
}

function getMainMenu(userId) {
    let keyboard = [
        [{ text: "🚀 Deploy Node.js Project", callback_data: "deploy_new" }],
        [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]
    ];
    if (OWNER_IDS.includes(userId)) {
        keyboard.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
    }
    return { inline_keyboard: keyboard };
}

function getProjNameFromData(data, prefix) {
    return data.replace(prefix, ""); 
}

async function safeEditMessage(chatId, messageId, text, keyboard) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'MarkdownV2'
        });
    } catch (error) {
        try {
            await bot.sendMessage(chatId, text, {
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'MarkdownV2'
            });
        } catch (e) { }
    }
}

// Save File to Disk AND MongoDB
async function saveFileToStorage(userId, projName, relativePath, contentBuffer) {
    try {
        // 1. Update DB (Upsert: Replace if exists, Add if new)
        // We pull first to avoid duplicates, then push.
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $pull: { files: { name: relativePath } } }
        );
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $push: { files: { name: relativePath, content: contentBuffer } } }
        );
    } catch (e) {
        console.error(`DB Save Error (${relativePath}):`, e.message);
    }
}

// Move File Helper
async function moveFile(userId, projName, basePath, fileName, targetFolder, chatId) {
    const oldPath = path.join(basePath, fileName);
    const newDir = path.join(basePath, targetFolder);
    const newPath = path.join(newDir, fileName);

    try {
        if (!fs.existsSync(oldPath)) {
             await bot.sendMessage(chatId, `⚠️ File not found: \`${fileName}\`\nUpload it first!`, { parse_mode: 'Markdown' });
             return;
        }

        if (!fs.existsSync(newDir)) {
            await fs.promises.mkdir(newDir, { recursive: true });
        }
        
        await fs.promises.rename(oldPath, newPath);
        
        // Read the moved file to update DB
        const fileContent = await fs.promises.readFile(newPath); 
        const relativePath = path.join(targetFolder, fileName).replace(/\\/g, '/'); // Ensure forward slashes
        
        // Update DB
        await saveFileToStorage(userId, projName, relativePath, fileContent);
        // Remove old path from DB
        await projectsCol.updateOne(
            { user_id: userId, name: projName }, 
            { $pull: { files: { name: fileName } } }
        );

        await bot.sendMessage(chatId, `📂 Moved: \`${fileName}\` ➡️ \`${targetFolder}\``, { parse_mode: 'Markdown' });
    } catch (error) {
        await bot.sendMessage(chatId, `❌ Error moving \`${fileName}\``, { parse_mode: 'Markdown' });
    }
}

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json, skipping install.");
        }
        if(chatId) bot.sendMessage(chatId, `📦 *Installing Dependencies\\.\\.\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('error', (err) => reject(`System Error: ${err.message}`));
        install.on('close', (code) => code === 0 ? resolve("Success") : resolve("Warning: Install issue"));
    });
}

// 🔥 FULL SYNC WATCHER: Watches EVERYTHING (Sessions, DBs, Files) 🔥
function startFullSyncWatcher(userId, projName, basePath) {
    const watcherId = `${userId}_${projName}`;
    
    // Clear existing watcher if any
    if (FILE_WATCHERS[watcherId]) {
        try { FILE_WATCHERS[watcherId].close(); } catch(e){}
    }

    try {
        // Recursive watch on the whole project folder
        const watcher = fs.watch(basePath, { recursive: true }, async (eventType, filename) => {
            if (filename) {
                // ⛔ IGNORE node_modules and temp files (Too big/frequent)
                if (filename.includes('node_modules') || filename.includes('.git') || filename.includes('package-lock.json')) return;
                
                const fullPath = path.join(basePath, filename);
                
                // Only sync if file exists (it was created or modified)
                // If deleted, we keep it in DB for safety, or handle deletion logic separately.
                // For now, we sync updates.
                if (fs.existsSync(fullPath)) {
                    // Check if it's a file (not a folder)
                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.isFile()) {
                            const content = fs.readFileSync(fullPath);
                            const relativePath = filename.replace(/\\/g, '/'); // Normalize path
                            
                            // SYNC TO MONGODB
                            // We use a simplified update without pulling first to reduce DB operations for rapid changes?
                            // No, pull/push is safer for array structure to avoid duplicates.
                            await projectsCol.updateOne(
                                { user_id: userId, name: projName },
                                { $pull: { files: { name: relativePath } } }
                            );
                            await projectsCol.updateOne(
                                { user_id: userId, name: projName },
                                { $push: { files: { name: relativePath, content: content } } }
                            );
                            // console.log(`🔄 Synced: ${relativePath}`);
                        }
                    } catch (err) {
                        // File might be locked or deleted rapidly
                    }
                }
            }
        });
        FILE_WATCHERS[watcherId] = watcher;
        console.log(`👀 Watching ${projName} for changes...`);
    } catch (err) {
        console.error("Watcher Error:", err.message);
    }
}

async function forceStopProject(userId, projName) {
    const projectId = `${userId}_${projName}`;
    if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].process) {
        try { ACTIVE_SESSIONS[projectId].process.kill('SIGKILL'); } catch (e) {}
        if(ACTIVE_SESSIONS[projectId].logStream) ACTIVE_SESSIONS[projectId].logStream.end();
        delete ACTIVE_SESSIONS[projectId];
    }
    if (FILE_WATCHERS[projectId]) {
        try { FILE_WATCHERS[projectId].close(); } catch(e){}
        delete FILE_WATCHERS[projectId];
    }
    await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
}

async function renewSession(userId, projName, chatId, basePath) {
    try {
        await forceStopProject(userId, projName);
        
        // 1. Delete session-related files from DB
        // We assume session files are usually in a folder or have specific names. 
        // A safer way is to delete the 'session' folder locally and let the watcher update DB?
        // No, watcher update is triggered on file change. Deletion might not be synced if logic is "exists".
        
        // Manual Clean from DB for typical Baileys folders
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $pull: { files: { name: { $regex: /^session\// } } } } // Remove all files starting with session/
        );
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $pull: { files: { name: { $regex: /^auth_info_baileys\// } } } } 
        );

        // 2. Delete Local Folder
        const sessionPath = path.join(basePath, 'session');
        const authPath = path.join(basePath, 'auth_info_baileys');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        if(chatId) bot.sendMessage(chatId, `🔄 *Session Renewed/Cleared.*\nStarting fresh...`, { parse_mode: 'Markdown' }).catch(e => {});
        setTimeout(() => startProject(userId, projName, chatId), 2000);
    } catch (e) {
        console.error("Renew Error:", e);
    }
}

// ================= 🔥 MAIN START PROJECT 🔥 =================

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    await forceStopProject(userId, projName);
    const safeName = escapeMarkdown(projName);

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Initializing ${safeName}\\.\\.\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});

    // Ensure directory exists (in case it's a fresh start)
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });

    // 🔄 RESTORE FILES FROM DB BEFORE START
    // This is crucial for Railway Restarts
    const projectData = await projectsCol.findOne({ user_id: userId, name: projName });
    if (projectData && projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.content.buffer);
        }
        // console.log(`✅ Restored ${projectData.files.length} files for ${projName}`);
    }

    // Install deps if needed
    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) { }
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
    const logFilePath = path.join(LOG_DIR, `${projectId}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

    ACTIVE_SESSIONS[projectId] = {
        process: child,
        logging: true, // Start ON
        logStream: logStream,
        chatId: chatId,
        basePath: basePath
    };

    // 🔥 START THE WATCHER 🔥
    startFullSyncWatcher(userId, projName, basePath);

    await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Running", path: basePath } });

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 *App Started\\.*\nWaiting for Login Code/Success\\.\\.\\.`, { parse_mode: 'MarkdownV2' }).catch(e => {});
    }

    // --- STDOUT HANDLER ---
    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);

        if (!chatId) return;

        const cleanOutput = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        const lowerOut = cleanOutput.toLowerCase();

        // 1. PAIRING CODE
        const codeMatch = cleanOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) {
            bot.sendMessage(chatId, `🔑 *YOUR PAIRING CODE:*\n\n\`${codeMatch[0]}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            return; 
        }

        // 2. INPUT REQUESTS
        if ((lowerOut.includes("enter") || lowerOut.includes("input") || lowerOut.includes("provide") || lowerOut.includes("number")) && cleanOutput.includes(":")) {
             bot.sendMessage(chatId, `⌨️ *Input Requested:*\n\`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             return;
        }

        // 3. AUTO-MUTE ON SUCCESS
        const successKeywords = [
            "success", "connected", "bot is live", "open", "authenticated", 
            "✅", "started!", "database connected", "sa message", "bot connected"
        ];

        if (successKeywords.some(k => lowerOut.includes(k))) {
            bot.sendMessage(chatId, `✅ *Status Update:*\n\`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            if (ACTIVE_SESSIONS[projectId].logging) {
                ACTIVE_SESSIONS[projectId].logging = false;
                bot.sendMessage(chatId, `🔇 *Auto-Mute Active:* Bot is Live! Logs disabled to keep chat clean.`).catch(()=>{});
            }
            return;
        }

        // 4. Normal Logs
        if (ACTIVE_SESSIONS[projectId].logging) {
             if(cleanOutput.trim().length > 0 && cleanOutput.length < 800) {
                 bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             }
        }
    });

    // --- STDERR HANDLER ---
    child.stderr.on('data', (data) => {
        logStream.write(data);
        const error = data.toString();
        if (chatId && ACTIVE_SESSIONS[projectId].logging) {
             if (!error.includes("npm notice") && !error.includes("ExperimentalWarning")) {
                 bot.sendMessage(chatId, `⚠️ *Error:*\n\`${escapeMarkdown(error.slice(0, 300))}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             }
        }
    });

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[projectId]) {
            try { logStream.end(); } catch(e){}
            delete ACTIVE_SESSIONS[projectId];
        }
        if (FILE_WATCHERS[projectId]) try { FILE_WATCHERS[projectId].close(); } catch(e){}
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent && ACTIVE_SESSIONS[projectId]?.logging) { 
             bot.sendMessage(chatId, `🛑 *Bot Stopped* \\(Exit Code: ${code}\\)`, { parse_mode: "MarkdownV2" }).catch(e => {});
        }
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        if (text && text.startsWith("/start")) {
            if (await isAuthorized(userId)) {
                bot.sendMessage(chatId, "👋 *Node\\.js Master Bot*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' }).catch(e => {});
            } else {
                bot.sendMessage(chatId, "🔒 Private Bot\\.").catch(e => {});
            }
            return;
        }

        if (USER_STATE[userId]) {
            if (text === "✅ Done / Apply Actions") {
                if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                    const projName = USER_STATE[userId].name;
                    const isUpdate = USER_STATE[userId].step === "update_files";
                    delete USER_STATE[userId]; 
                    const statusMsg = await bot.sendMessage(chatId, "⚙️ *Processing Actions\\.\\.\\.*", { reply_markup: { remove_keyboard: true }, parse_mode: 'MarkdownV2' });
                    if (isUpdate) await forceStopProject(userId, projName);
                    setTimeout(() => {
                        startProject(userId, projName, chatId);
                        bot.deleteMessage(chatId, statusMsg.message_id).catch(e=>{});
                    }, 1500);
                    return;
                }
            }

            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');
                const exists = await projectsCol.findOne({ user_id: userId, name: projName });
                if (exists) return bot.sendMessage(chatId, "❌ Name taken.").catch(e => {});
                USER_STATE[userId] = { step: "wait_files", name: projName };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2' };
                bot.sendMessage(chatId, `✅ Name: *${escapeMarkdown(projName)}*\n\n1️⃣ Send files now\\.\n2️⃣ To move: \`folder/file.js\`\n3️⃣ Click Done when finished\\.`, opts).catch(e => {});
            }

            else if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                if (!text) return;
                const projName = USER_STATE[userId].name;
                const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
                if (text.includes('/')) {
                    const parts = text.split('/');
                    const fileName = parts.pop();
                    const folderPath = parts.join('/');
                    await moveFile(userId, projName, basePath, fileName, folderPath, chatId);
                } 
                else if (text.includes(' ')) {
                    const args = text.split(/\s+/);
                    const folderName = args[0];
                    const filesToMove = args.slice(1);
                    for (const f of filesToMove) await moveFile(userId, projName, basePath, f, folderName, chatId);
                }
            }
        } 
        
        else {
             let targetProjId = null;
             for (const [pid, session] of Object.entries(ACTIVE_SESSIONS)) {
                 if (session.chatId === chatId) { targetProjId = pid; break; }
             }
             if (targetProjId && text && !text.startsWith("/")) {
                 const session = ACTIVE_SESSIONS[targetProjId];
                 if (session.process && !session.process.killed) {
                     try { 
                         session.process.stdin.write(text + "\n");
                         bot.sendMessage(chatId, `⌨️ _Sent:_ \`${text}\``, { parse_mode: 'Markdown' }).catch(()=>{});
                     } catch (e) { }
                 }
             }
        }
    } catch (err) { }
});

bot.on('document', async (msg) => {
    try {
        const userId = msg.from.id;
        if (USER_STATE[userId] && (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files")) {
            const projName = USER_STATE[userId].name;
            const fileName = msg.document.file_name;
            const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const filePath = path.join(dir, fileName);
            const fileLink = await bot.getFileLink(msg.document.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer();
            
            // Save to Disk
            fs.writeFileSync(filePath, Buffer.from(buffer));
            
            // Save to DB Immediately
            await saveFileToStorage(userId, projName, fileName, Buffer.from(buffer));

            bot.sendMessage(msg.chat.id, `📥 Received: \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' }).catch(e => {});
        }
    } catch (err) { }
});

// ================= CALLBACK HANDLING =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
        await bot.answerCallbackQuery(query.id).catch(err => {});

        if (data === "owner_panel") {
            if (!OWNER_IDS.includes(userId)) return bot.sendMessage(chatId, "⛔ Access Denied");
            const keyboard = [
                [{ text: "🔑 Generate Key", callback_data: "gen_key" }],
                [{ text: "📜 List Keys", callback_data: "list_keys" }],
                [{ text: "🔙 Back", callback_data: "main_menu" }]
            ];
            await safeEditMessage(chatId, messageId, "👑 *Owner Panel*", keyboard);
        }

        else if (data === "gen_key") {
            const newKey = uuid.v4().split('-')[0];
            await keysCol.insertOne({ key: newKey, status: "active", created_by: userId });
            const keyboard = [[{ text: "🔙 Back", callback_data: "owner_panel" }]];
            await safeEditMessage(chatId, messageId, `✅ *Key Generated:*\n\`${newKey}\`\n\nCommand: \`/start ${newKey}\``, keyboard);
        }

        else if (data === "list_keys") {
            const keys = await keysCol.find({}).toArray();
            if (keys.length === 0) {
                await safeEditMessage(chatId, messageId, "⚠️ *No Keys Found*", [[{ text: "🔙 Back", callback_data: "owner_panel" }]]);
                return;
            }
            const keyboard = keys.map(k => [{ text: `${k.status === 'active' ? '🟢' : '🔴'} ${k.key}`, callback_data: `view_key_${k.key}` }]);
            keyboard.push([{ text: "🔙 Back", callback_data: "owner_panel" }]);
            await safeEditMessage(chatId, messageId, "📜 *Manage Keys:*", keyboard);
        }

        else if (data.startsWith("view_key_")) {
            const keyStr = data.replace("view_key_", "");
            const keyDoc = await keysCol.findOne({ key: keyStr });
            if (!keyDoc) return bot.sendMessage(chatId, "❌ Key not found");
            const statusText = keyDoc.status === 'active' ? "Active 🟢" : "Inactive 🔴";
            const usedBy = keyDoc.used_by ? `\`${keyDoc.used_by}\`` : "_Not Used_";
            const keyboard = [
                [{ text: "🔄 Toggle Status", callback_data: `tog_key_${keyStr}` }],
                [{ text: "🗑️ Delete Key", callback_data: `del_key_${keyStr}` }],
                [{ text: "🔙 Back", callback_data: "list_keys" }]
            ];
            await safeEditMessage(chatId, messageId, `🔑 *Key:* \`${escapeMarkdown(keyStr)}\`\n📊 *Status:* ${statusText}\n👤 *Used By:* ${usedBy}`, keyboard);
        }

        else if (data.startsWith("tog_key_")) {
            const keyStr = data.replace("tog_key_", "");
            const keyDoc = await keysCol.findOne({ key: keyStr });
            if (keyDoc) {
                const newStatus = keyDoc.status === 'active' ? 'inactive' : 'active';
                await keysCol.updateOne({ key: keyStr }, { $set: { status: newStatus } });
                bot.emit('callback_query', { ...query, data: `view_key_${keyStr}` });
            }
        }

        else if (data.startsWith("del_key_")) {
            const keyStr = data.replace("del_key_", "");
            await keysCol.deleteOne({ key: keyStr });
            bot.emit('callback_query', { ...query, data: "list_keys" });
        }
        
        else if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            bot.sendMessage(chatId, "📂 Enter Project Name (No spaces):").catch(e => {});
        }
        else if (data === "manage_projects") {
            const projects = await projectsCol.find({ user_id: userId }).toArray();
            const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p.name}` }]);
            keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
            await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
        }
        
        else if (data.startsWith("menu_")) {
            const projName = getProjNameFromData(data, "menu_");
            const projectId = `${userId}_${projName}`;
            const isRunning = ACTIVE_SESSIONS[projectId] ? true : false;
            const isLogging = (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging) ? true : false;

            const keyboard = [
                [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `toggle_run_${projName}` }, { text: isLogging ? "🔴 Disable Logs" : "🟢 Enable Logs", callback_data: `toggle_log_${projName}` }],
                [{ text: "📝 Update Files", callback_data: `upd_${projName}` }, { text: "📥 Download Logs", callback_data: `get_logs_${projName}` }],
                [{ text: "🔄 Renew Session", callback_data: `renew_ses_${projName}` }], 
                [{ text: "🗑️ Delete", callback_data: `del_${projName}` }],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            await safeEditMessage(chatId, messageId, `⚙️ Manage: *${escapeMarkdown(projName)}*\n\nStatus: ${isRunning ? 'Running 🟢' : 'Stopped 🔴'}`, keyboard);
        }
        
        else if (data.startsWith("toggle_run_")) {
            const projName = getProjNameFromData(data, "toggle_run_");
            const projectId = `${userId}_${projName}`;
            if (ACTIVE_SESSIONS[projectId]) {
                await forceStopProject(userId, projName);
                bot.sendMessage(chatId, `🛑 *${escapeMarkdown(projName)} Stopped\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});
            } else {
                try { await bot.deleteMessage(chatId, messageId); } catch(e){}
                startProject(userId, projName, chatId);
                return; 
            }
            bot.emit('callback_query', { ...query, data: `menu_${projName}` });
        }

        else if (data.startsWith("renew_ses_")) {
            const projName = getProjNameFromData(data, "renew_ses_");
            const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
            await renewSession(userId, projName, chatId, basePath);
        }

        else if (data.startsWith("toggle_log_")) {
            const projName = getProjNameFromData(data, "toggle_log_");
            const projectId = `${userId}_${projName}`;
            if (ACTIVE_SESSIONS[projectId]) ACTIVE_SESSIONS[projectId].logging = !ACTIVE_SESSIONS[projectId].logging;
            bot.emit('callback_query', { ...query, data: `menu_${projName}` });
        }

        else if (data.startsWith("get_logs_")) {
            const projName = getProjNameFromData(data, "get_logs_");
            const projectId = `${userId}_${projName}`;
            const logFile = path.join(LOG_DIR, `${projectId}.txt`);
            if (fs.existsSync(logFile)) bot.sendDocument(chatId, logFile, { caption: `Logs: ${projName}` }).catch(e => {});
            else bot.sendMessage(chatId, "❌ No logs found.").catch(e => {});
        }
        
        else if (data.startsWith("del_")) {
            const projName = getProjNameFromData(data, "del_");
            try {
                await forceStopProject(userId, projName); 
                await projectsCol.deleteOne({ user_id: userId, name: projName });
                const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
                await bot.deleteMessage(chatId, messageId).catch(e => {});
                bot.sendMessage(chatId, "✅ Project Deleted!").catch(e => {});
            } catch (e) { bot.sendMessage(chatId, "❌ Delete Error").catch(e => {}); }
        }
        
        else if (data.startsWith("upd_")) {
            const projName = getProjNameFromData(data, "upd_");
            USER_STATE[userId] = { step: "update_files", name: projName };
            const escapedName = escapeMarkdown(projName);
            const opts = { parse_mode: 'MarkdownV2', reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] } };
            await bot.sendMessage(chatId, `📝 *Update Mode: ${escapedName}*\n\n1️⃣ Send new files\\.\n2️⃣ To move: \`folder/file.js\`\n3️⃣ Click Done to restart\\.`, opts);
        }

        else if (data === "main_menu") {
            await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
        }
    } catch (err) { }
});

// 🔥 ON RESTART: RESTORE EVERYTHING AND START 🔥
async function restoreProjects() {
    console.log("🔄 Restoring Projects from MongoDB...");
    try {
        // Fetch ALL projects that were running or active
        const allProjects = await projectsCol.find({}).toArray(); // Fetch all to be safe, or check status
        
        for (const proj of allProjects) {
            // Only restore if it was running OR user expects it there
            if (proj.status === "Running" || true) { // Force restore everything to be safe
                const dir = path.join(__dirname, 'deployments', proj.user_id.toString(), proj.name);
                
                // Recreate Directory
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                
                // Restore Files from DB to Disk
                if (proj.files) { 
                    for (const file of proj.files) {
                        const filePath = path.join(dir, file.name);
                        const fileDir = path.dirname(filePath);
                        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
                        fs.writeFileSync(filePath, file.content.buffer);
                    }
                }
                
                // If it was marked as "Running", start it automatically
                if (proj.status === "Running") {
                    console.log(`✅ Restarting: ${proj.name}`);
                    startProject(proj.user_id, proj.name, null, true); // Silent start
                }
            }
        }
    } catch (e) { console.error("Restore Error:", e); }
}

bot.on('polling_error', (error) => console.log(`[Polling Error] ${error.code}: ${error.message}`));
