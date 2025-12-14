const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid'); // UUID for keys

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
const SESSION_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

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
    return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
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
        const errMsg = error.message;
        if (errMsg.includes('message is not modified') || errMsg.includes('message to edit not found')) return;
        try {
            await bot.sendMessage(chatId, text, {
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'MarkdownV2'
            });
        } catch (e) { console.error("Send Failed:", e.message); }
    }
}

async function moveFile(userId, projName, basePath, fileName, targetFolder, chatId) {
    const oldPath = path.join(basePath, fileName);
    const newDir = path.join(basePath, targetFolder);
    const newPath = path.join(newDir, fileName);

    if (fs.existsSync(oldPath)) {
        if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
        
        fs.renameSync(oldPath, newPath);
        
        // DB Update
        const fileContent = fs.readFileSync(newPath);
        await projectsCol.updateOne(
            { user_id: userId, name: projName }, 
            { $pull: { files: { name: fileName } } }
        );
        const relativePath = path.join(targetFolder, fileName).replace(/\\/g, '/');
        await projectsCol.updateOne(
            { user_id: userId, name: projName }, 
            { $push: { files: { name: relativePath, content: fileContent } } }
        );

        bot.sendMessage(chatId, `📂 Moved \`${fileName}\` ➡️ \`${targetFolder}\``, { parse_mode: 'Markdown' }).catch(e=>{});
    } else {
        bot.sendMessage(chatId, `❌ File \`${fileName}\` not found in root. Upload it first.`, { parse_mode: 'Markdown' }).catch(e=>{});
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

function setupSessionSync(userId, projName, basePath) {
    const sessionDir = path.join(basePath, 'session');
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const watcherId = `${userId}_${projName}`;
    if (SESSION_WATCHERS[watcherId]) SESSION_WATCHERS[watcherId].close();

    try {
        const watcher = fs.watch(sessionDir, async (eventType, filename) => {
            if (filename && eventType === 'change') {
                const filePath = path.join(sessionDir, filename);
                if (fs.existsSync(filePath)) {
                    try {
                        const content = fs.readFileSync(filePath);
                        const safeKey = filename.replace(/\./g, '_DOT_');
                        await projectsCol.updateOne(
                            { user_id: userId, name: projName },
                            { $set: { [`session_data.${safeKey}`]: content } }
                        );
                    } catch (err) { }
                }
            }
        });
        SESSION_WATCHERS[watcherId] = watcher;
    } catch (err) { console.error("Watcher Error:", err.message); }
}

async function restoreSessionFromDB(userId, projName, basePath) {
    try {
        const project = await projectsCol.findOne({ user_id: userId, name: projName });
        if (project && project.session_data) {
            const sessionDir = path.join(basePath, 'session');
            if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
            
            for (const [safeKey, content] of Object.entries(project.session_data)) {
                const filename = safeKey.replace(/_DOT_/g, '.');
                fs.writeFileSync(path.join(sessionDir, filename), content.buffer);
            }
        }
    } catch (e) { console.error("Session Restore Error:", e); }
}

async function forceStopProject(userId, projName) {
    const projectId = `${userId}_${projName}`;
    if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].process) {
        try { ACTIVE_SESSIONS[projectId].process.kill('SIGKILL'); } catch (e) {}
        if(ACTIVE_SESSIONS[projectId].logStream) ACTIVE_SESSIONS[projectId].logStream.end();
        delete ACTIVE_SESSIONS[projectId];
    }
    if (SESSION_WATCHERS[projectId]) {
        try { SESSION_WATCHERS[projectId].close(); } catch(e){}
        delete SESSION_WATCHERS[projectId];
    }
    await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
}

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    await forceStopProject(userId, projName);
    const safeName = escapeMarkdown(projName);

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Initializing ${safeName}\\.\\.\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});

    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) { console.error(err); }
    }

    try { await restoreSessionFromDB(userId, projName, basePath); } catch (e) {}

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 *Starting App\\.\\.\\.*\n\n🔴 *Live Logging Active:*\nWait for pairing code\\.\\.\\.`, { parse_mode: 'MarkdownV2' }).catch(e => {});
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
    const logFilePath = path.join(LOG_DIR, `${projectId}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

    ACTIVE_SESSIONS[projectId] = {
        process: child,
        logging: true,
        logStream: logStream,
        chatId: chatId
    };

    setupSessionSync(userId, projName, basePath);

    await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Running", path: basePath } });

    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);

        if (!ACTIVE_SESSIONS[projectId] || !ACTIVE_SESSIONS[projectId].logging || !chatId) return;

        const cleanOutput = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const codeMatch = cleanOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) {
            bot.sendMessage(chatId, `🔑 *YOUR PAIRING CODE:*\n\n\`${codeMatch[0]}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            return;
        }

        if (cleanOutput.includes("Opened connection") || cleanOutput.includes("Connected Successfully")) {
            bot.sendMessage(chatId, `✅ *Success\\! Bot is Online\\.*\n\n🔇 _Live Logging Disabled\\._`, { parse_mode: "MarkdownV2" }).catch(e => {});
            if (ACTIVE_SESSIONS[projectId]) ACTIVE_SESSIONS[projectId].logging = false;
            return;
        }

        if (!cleanOutput.includes("npm") && cleanOutput.trim() !== "") {
             if(cleanOutput.length < 300) {
                 bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             }
        }
    });

    child.stderr.on('data', (data) => {
        logStream.write(data);
        const error = data.toString();
        if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging && chatId && !error.includes("npm")) {
             bot.sendMessage(chatId, `⚠️ *Error:*\n\`${escapeMarkdown(error.slice(0, 200))}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
        }
    });

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[projectId]) {
            try { logStream.end(); } catch(e){}
            delete ACTIVE_SESSIONS[projectId];
        }
        if (SESSION_WATCHERS[projectId]) try { SESSION_WATCHERS[projectId].close(); } catch(e){}
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 *Bot Stopped* \\(Exit Code: ${code}\\)`, { parse_mode: "MarkdownV2" }).catch(e => {});
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        let targetProjId = null;
        for (const [pid, session] of Object.entries(ACTIVE_SESSIONS)) {
            if (session.chatId === chatId && session.logging) {
                targetProjId = pid;
                break;
            }
        }
        if (targetProjId && text && !text.startsWith("/")) {
            const session = ACTIVE_SESSIONS[targetProjId];
            if (session.process && !session.process.killed) {
                try { session.process.stdin.write(text + "\n"); } catch (e) {}
                return;
            }
        }

        if (!text) return;

        if (text.startsWith("/start")) {
            if (await isAuthorized(userId)) {
                bot.sendMessage(chatId, "👋 *Node\\.js Master Bot*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' }).catch(e => {});
            } else {
                bot.sendMessage(chatId, "🔒 Private Bot\\.").catch(e => {});
            }
        }

        if (USER_STATE[userId]) {
            // STEP: ASK NAME
            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim().replace(/\s+/g, '_').replace(/[^\w-]/g, '');
                const exists = await projectsCol.findOne({ user_id: userId, name: projName });
                if (exists) return bot.sendMessage(chatId, "❌ Name taken.").catch(e => {});

                USER_STATE[userId] = { step: "wait_files", name: projName };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2' };
                bot.sendMessage(chatId, `✅ Name: *${escapeMarkdown(projName)}*\n\n1️⃣ Send files now\\.\n2️⃣ Move files: \`folder/file.js\`\n3️⃣ Click Done when finished\\.`, opts).catch(e => {});
            }
            // STEP: DONE BUTTON
            else if (text === "✅ Done / Apply Actions") {
                if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                    const projName = USER_STATE[userId].name;
                    const isUpdate = USER_STATE[userId].step === "update_files";
                    
                    delete USER_STATE[userId];
                    bot.sendMessage(chatId, "⚙️ Processing\\.\\.\\.", { reply_markup: { remove_keyboard: true }, parse_mode: 'MarkdownV2' }).catch(e => {});
                    
                    if (isUpdate) await forceStopProject(userId, projName);
                    startProject(userId, projName, chatId);
                }
            }
            // STEP: FOLDER MANAGEMENT (TEXT COMMANDS)
            else if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                const projName = USER_STATE[userId].name;
                const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);

                // Pattern 1: "plugins/tools.js" (Direct Path)
                if (text.includes('/')) {
                    const parts = text.split('/');
                    const fileName = parts.pop();
                    const folderPath = parts.join('/');
                    moveFile(userId, projName, basePath, fileName, folderPath, chatId);
                } 
                // Pattern 2: "folder file1.js file2.js" (Space Separated)
                else if (text.includes(' ')) {
                    const args = text.split(/\s+/);
                    const folderName = args[0];
                    const filesToMove = args.slice(1);
                    filesToMove.forEach(f => moveFile(userId, projName, basePath, f, folderName, chatId));
                }
            }
        }
    } catch (err) { console.error("Msg Error:", err); }
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
            fs.writeFileSync(filePath, Buffer.from(buffer));

            await projectsCol.updateOne({ user_id: userId, name: projName }, { $pull: { files: { name: fileName } } });
            await projectsCol.updateOne({ user_id: userId, name: projName }, { $push: { files: { name: fileName, content: Buffer.from(buffer) } } }, { upsert: true });

            // Removed Immediate Restart logic. Now just confirms receipt.
            bot.sendMessage(msg.chat.id, `📥 Received: \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' }).catch(e => {});
        }
    } catch (err) { console.error("Doc Error:", err); }
});

// ================= CALLBACK HANDLING =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
        await bot.answerCallbackQuery(query.id).catch(err => {});

        // --- OWNER PANEL START ---
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
            const keyboard = keys.map(k => [{
                text: `${k.status === 'active' ? '🟢' : '🔴'} ${k.key}`,
                callback_data: `view_key_${k.key}`
            }]);
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
                // Refresh view
                bot.emit('callback_query', { ...query, data: `view_key_${keyStr}` });
            }
        }

        else if (data.startsWith("del_key_")) {
            const keyStr = data.replace("del_key_", "");
            await keysCol.deleteOne({ key: keyStr });
            // Go back to list
            bot.emit('callback_query', { ...query, data: "list_keys" });
        }
        // --- OWNER PANEL END ---

        else if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            bot.sendMessage(chatId, "📂 Enter Project Name (No spaces):").catch(e => {});
        }
        else if (data === "manage_projects") {
            const projects = await projectsCol.find({ user_id: userId }).toArray();
            const keyboard = projects.map(p => [{ 
                text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, 
                callback_data: `menu_${p.name}` 
            }]);
            keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
            await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
        }
        
        else if (data.startsWith("menu_")) {
            const projName = getProjNameFromData(data, "menu_");
            const projectId = `${userId}_${projName}`;
            
            const isRunning = ACTIVE_SESSIONS[projectId] ? true : false;
            const isLogging = (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging) ? true : false;

            const keyboard = [
                [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `toggle_run_${projName}` }, 
                 { text: isLogging ? "🔴 Disable Logs" : "🟢 Enable Logs", callback_data: `toggle_log_${projName}` }],
                [{ text: "📝 Update Files", callback_data: `upd_${projName}` }, { text: "📥 Download Logs", callback_data: `get_logs_${projName}` }],
                [{ text: "🗑️ Delete", callback_data: `del_${projName}` }],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            
            const escapedName = escapeMarkdown(projName);
            await safeEditMessage(chatId, messageId, `⚙️ Manage: *${escapedName}*\n\nStatus: ${isRunning ? 'Running 🟢' : 'Stopped 🔴'}`, keyboard);
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
            
            const opts = {
                parse_mode: 'MarkdownV2',
                reply_markup: { 
                    resize_keyboard: true, 
                    keyboard: [[{ text: "✅ Done / Apply Actions" }]] 
                }
            };
            
            await bot.sendMessage(chatId, `📝 *Update Mode: ${escapedName}*\n\n1️⃣ Send new files\\.\n2️⃣ Move: \`plugins/file.js\`\n3️⃣ Click Done to restart\\.`, opts);
        }

        else if (data === "main_menu") {
            await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
        }
    } catch (err) {
        console.error("Callback Error:", err.message);
    }
});

async function restoreProjects() {
    console.log("🔄 Restoring Projects...");
    try {
        const runningProjs = await projectsCol.find({ status: "Running" }).toArray();
        for (const proj of runningProjs) {
            const dir = path.join(__dirname, 'deployments', proj.user_id.toString(), proj.name);
            if (!fs.existsSync(dir)) {
                console.log(`♻️ Rebuilding: ${proj.name}`);
                fs.mkdirSync(dir, { recursive: true });
                if (proj.files) { for (const file of proj.files) fs.writeFileSync(path.join(dir, file.name), file.content.buffer); }
                startProject(proj.user_id, proj.name, null, true);
            }
        }
    } catch (e) { console.error("Restore Error:", e); }
}

bot.on('polling_error', (error) => console.log(`[Polling Error] ${error.code}: ${error.message}`));