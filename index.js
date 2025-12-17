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
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

// ANTI-CRASH: Polling Error Handler
bot.on('polling_error', (error) => {
    if (error.message.includes('409 Conflict')) return; // Ignore multiple instance warnings
    console.log(`[Polling Error] ${error.message}`);
});

const client = new MongoClient(MONGO_URL, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000
});

let db, projectsCol, keysCol, usersCol;

// 🔥 GLOBAL CACHE & STATE
const PROJECT_CACHE = {}; 
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

// Filter Spam Logs
const IGNORED_LOGS = ['Bad MAC', 'Decrypt', 'rate-overlimit', 'pre-key', 'SessionEntry', 'Closing session'];

if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ================= DATABASE CONNECTION =================
async function connectDB() {
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        console.log("✅ Connected to MongoDB");
        
        startDBKeepAlive();
        setTimeout(syncCacheAndRestore, 2000); 
    } catch (e) {
        console.error("❌ DB Error:", e);
        setTimeout(connectDB, 5000);
    }
}
connectDB();

function startDBKeepAlive() {
    setInterval(async () => {
        try { if (db) await db.command({ ping: 1 }); } 
        catch (e) { connectDB(); }
    }, 5 * 60 * 1000); 
}

// 🔥 SYNC RAM + DISK ON STARTUP
async function syncCacheAndRestore() {
    try {
        const allProjects = await projectsCol.find({}).toArray();
        for (const key in PROJECT_CACHE) delete PROJECT_CACHE[key];

        for (const proj of allProjects) {
            const uid = proj.user_id;
            if (!PROJECT_CACHE[uid]) PROJECT_CACHE[uid] = [];
            PROJECT_CACHE[uid].push(proj);
            
            const dir = path.join(__dirname, 'deployments', uid.toString(), proj.name);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            
            if (proj.files) {
                for (const file of proj.files) {
                    const filePath = path.join(dir, file.name);
                    const fileDir = path.dirname(filePath);
                    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
                    fs.writeFileSync(filePath, file.content.buffer);
                }
            }
            if (proj.status === "Running") {
                startProject(uid, proj._id, null, true);
            }
        }
        console.log("🚀 Projects Restored & Cache Ready!");
    } catch (e) { console.error("Restore Error:", e); }
}

// ================= HELPER FUNCTIONS =================

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    try { return !!(await usersCol.findOne({ user_id: userId })); } catch { return false; }
}

function getMainMenu(userId) {
    let keyboard = [
        [{ text: "🚀 Deploy New Project", callback_data: "deploy_new" }],
        [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]
    ];
    if (OWNER_IDS.includes(userId)) {
        keyboard.push([{ text: "👑 Owner Panel", callback_data: "owner_panel" }]);
    }
    return { inline_keyboard: keyboard };
}

function getData(data, prefix) { return data.substring(prefix.length); }

async function safeEditMessage(chatId, messageId, text, keyboard) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2'
        });
    } catch (error) {
        try {
            await bot.sendMessage(chatId, text, {
                reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2'
            });
        } catch (e) { }
    }
}

// 🔥 REPLACED: DUAL SAVE (RAM + DB)
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
        const safeId = new ObjectId(String(projId));
        // Update RAM
        if (PROJECT_CACHE[userId]) {
            const p = PROJECT_CACHE[userId].find(x => x._id.toString() === safeId.toString());
            if (p) {
                if (!p.files) p.files = [];
                p.files = p.files.filter(f => f.name !== relativePath);
                p.files.push({ name: relativePath, content: contentBuffer });
            }
        }
        // Update DB
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: relativePath } } });
        await projectsCol.updateOne({ _id: safeId }, { $push: { files: { name: relativePath, content: contentBuffer } } });
        return true;
    } catch (e) { return false; }
}

async function moveFile(userId, projData, basePath, fileName, targetFolder, chatId) {
    const oldPath = path.join(basePath, fileName);
    const newDir = path.join(basePath, targetFolder);
    const newPath = path.join(newDir, fileName);
    try {
        if (!fs.existsSync(oldPath)) return bot.sendMessage(chatId, "⚠️ File not found.");
        if (!fs.existsSync(newDir)) await fs.promises.mkdir(newDir, { recursive: true });
        await fs.promises.rename(oldPath, newPath);
        const fileContent = await fs.promises.readFile(newPath);
        const relativePath = path.join(targetFolder, fileName).replace(/\\/g, '/');
        await saveFileToStorage(userId, projData._id, relativePath, fileContent);
        await projectsCol.updateOne({ _id: new ObjectId(String(projData._id)) }, { $pull: { files: { name: fileName } } });
        await bot.sendMessage(chatId, `📂 Moved to \`${targetFolder}\``, { parse_mode: 'Markdown' });
    } catch (e) { await bot.sendMessage(chatId, "❌ Move Error"); }
}

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) return resolve();
        if(chatId) bot.sendMessage(chatId, `📦 *Installing NPM Modules...*`, { parse_mode: 'Markdown' });
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('close', (code) => code === 0 ? resolve() : reject());
    });
}

function startFullSyncWatcher(userId, projId, basePath) {
    const watcherId = projId.toString();
    if (FILE_WATCHERS[watcherId]) try { FILE_WATCHERS[watcherId].close(); } catch(e){}
    try {
        const watcher = fs.watch(basePath, { recursive: true }, async (eventType, filename) => {
            if (filename && !filename.includes('node_modules') && !filename.includes('.git')) {
                const fullPath = path.join(basePath, filename);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    const content = fs.readFileSync(fullPath);
                    saveFileToStorage(userId, projId, filename.replace(/\\/g, '/'), content);
                }
            }
        });
        FILE_WATCHERS[watcherId] = watcher;
    } catch (err) {}
}

async function forceStopProject(projId) {
    const pid = projId.toString();
    if (ACTIVE_SESSIONS[pid]) {
        try { ACTIVE_SESSIONS[pid].process.kill('SIGKILL'); } catch (e) {}
        try { ACTIVE_SESSIONS[pid].logStream.end(); } catch (e) {}
        delete ACTIVE_SESSIONS[pid];
    }
    if (FILE_WATCHERS[pid]) { try { FILE_WATCHERS[pid].close(); } catch(e){} delete FILE_WATCHERS[pid]; }
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
}

// ================= 🔥 MAIN START PROJECT 🔥 =================

async function startProject(userId, projId, chatId, silent = false) {
    let projectData = null;
    if (PROJECT_CACHE[userId]) projectData = PROJECT_CACHE[userId].find(p => p._id.toString() === projId.toString());
    if (!projectData) projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
    if (!projectData) return;

    const projName = projectData.name;
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const pid = projId.toString();

    await forceStopProject(projId);
    
    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Starting ${escapeMarkdown(projName)}...*`, { parse_mode: 'MarkdownV2' });

    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
    
    // Restore files from DB
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    // Dependency check
    if (fs.existsSync(path.join(basePath, 'package.json')) && !fs.existsSync(path.join(basePath, 'node_modules'))) {
        try { await installDependencies(basePath, chatId); } catch (e) { return; }
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
    const logFilePath = path.join(LOG_DIR, `${pid}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

    ACTIVE_SESSIONS[pid] = { 
        process: child, 
        logging: true, 
        logStream: logStream, 
        chatId: chatId, 
        name: projName 
    };

    startFullSyncWatcher(userId, projId, basePath);
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running", path: basePath } });

    const handleLog = (data, isError) => {
        const raw = data.toString();
        logStream.write(raw);
        if (!chatId) return;
        const clean = raw.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        
        if (IGNORED_LOGS.some(ign => clean.includes(ign))) return;

        // Pairing Code
        const codeMatch = clean.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || clean.match(/Pairing Code:\s*([A-Z0-9-]{8,})/i);
        if (codeMatch) return bot.sendMessage(chatId, `🔑 *PAIRING CODE:*\n\`${codeMatch[1] || codeMatch[0]}\``, { parse_mode: "MarkdownV2" });

        // Auto Mute on Success
        if (clean.toLowerCase().includes("connected") || clean.toLowerCase().includes("bot is live")) {
            bot.sendMessage(chatId, `✅ *${escapeMarkdown(projName)} is Live!*`, { parse_mode: "MarkdownV2" });
            ACTIVE_SESSIONS[pid].logging = false;
            return;
        }

        // Live Log output
        if (ACTIVE_SESSIONS[pid].logging) {
            if (clean.trim().length > 0) {
                bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(clean.slice(0, 400))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
            }
        }
    };

    child.stdout.on('data', d => handleLog(d, false));
    child.stderr.on('data', d => handleLog(d, true));
    child.on('close', (code) => {
        forceStopProject(projId);
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 *Stopped* (Code ${code})`);
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
                bot.sendMessage(chatId, "👋 *Master Bot Manager*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' });
            } else {
                bot.sendMessage(chatId, "🔒 Private Access Only.");
            }
            return;
        }

        if (USER_STATE[userId]) {
            // ✅ DONE BUTTON LOGIC
            if (text === "✅ Done / Apply Actions") {
                const projData = USER_STATE[userId].data;
                const isUpd = USER_STATE[userId].step === "update_files";
                delete USER_STATE[userId];
                const status = await bot.sendMessage(chatId, "⚙️ *Restarting with new files...*", { reply_markup: { remove_keyboard: true } });
                
                if (isUpd) await forceStopProject(projData._id);
                setTimeout(() => {
                    startProject(userId, projData._id, chatId);
                    bot.deleteMessage(chatId, status.message_id).catch(()=>{});
                }, 2000);
                return;
            }

            // ASK NAME LOGIC
            if (USER_STATE[userId].step === "ask_name") {
                const name = text.trim();
                const res = await projectsCol.insertOne({ user_id: userId, name: name, files: [], status: "Stopped" });
                const newProj = { _id: res.insertedId, user_id: userId, name: name, files: [], status: "Stopped" };
                if (!PROJECT_CACHE[userId]) PROJECT_CACHE[userId] = [];
                PROJECT_CACHE[userId].push(newProj);
                USER_STATE[userId] = { step: "wait_files", data: newProj };
                bot.sendMessage(chatId, `✅ Created: *${escapeMarkdown(name)}*\nSend files now.`, {
                    reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2'
                });
            }
        } 
        
        else {
            // Manual Console Input
            let targetPid = null;
            for (const [pid, session] of Object.entries(ACTIVE_SESSIONS)) {
                if (session.chatId === chatId) { targetPid = pid; break; }
            }
            if (targetPid && text && !text.startsWith("/")) {
                const session = ACTIVE_SESSIONS[targetPid];
                if (session.process && !session.process.killed) {
                    try { session.process.stdin.write(text + "\n"); } catch (e) { }
                }
            }
        }
    } catch (err) { }
});

bot.on('document', async (msg) => {
    const userId = msg.from.id;
    if (USER_STATE[userId] && (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files")) {
        const projData = USER_STATE[userId].data;
        const fileName = msg.document.file_name;
        const loading = await bot.sendMessage(msg.chat.id, `📥 *Uploading:* \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' });

        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.arrayBuffer();
        
        // Save to Disk
        const dir = path.join(__dirname, 'deployments', userId.toString(), projData.name);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, fileName), Buffer.from(buffer));

        // Save to RAM + DB
        await saveFileToStorage(userId, projData._id, fileName, Buffer.from(buffer));
        bot.editMessageText(`✅ *Saved:* \`${escapeMarkdown(fileName)}\``, { chat_id: msg.chat.id, message_id: loading.message_id, parse_mode: 'MarkdownV2' }).catch(()=>{});
    }
});

// ================= CALLBACK HANDLING =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try { await bot.answerCallbackQuery(query.id); } catch(e) {}

    if (data === "manage_projects") {
        const projects = PROJECT_CACHE[userId] || [];
        const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p._id.toString()}` }]);
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
    }
    
    else if (data.startsWith("menu_")) {
        const projId = getData(data, "menu_");
        const projects = PROJECT_CACHE[userId] || [];
        const proj = projects.find(p => p._id.toString() === projId);
        if (!proj) return;

        const isRunning = proj.status === "Running";
        const isLogging = (ACTIVE_SESSIONS[projId] && ACTIVE_SESSIONS[projId].logging);

        const keyboard = [
            [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `tog_run_${projId}` }, { text: isLogging ? "🔴 No Logs" : "🟢 Live Logs", callback_data: `tog_log_${projId}` }],
            [{ text: "📝 Update Files", callback_data: `upd_${projId}` }, { text: "📥 Get Log File", callback_data: `get_logs_${projId}` }],
            [{ text: "🔄 Renew Session", callback_data: `renew_${projId}` }, { text: "🗑️ Delete", callback_data: `del_${projId}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        await safeEditMessage(chatId, messageId, `⚙️ *Manage:* ${escapeMarkdown(proj.name)}\nStatus: ${isRunning ? "Running 🟢" : "Stopped 🔴"}`, keyboard);
    }

    else if (data.startsWith("tog_run_")) {
        const projId = getData(data, "tog_run_");
        if (ACTIVE_SESSIONS[projId]) await forceStopProject(projId);
        else await startProject(userId, projId, chatId);
        setTimeout(() => bot.emit('callback_query', { ...query, data: `menu_${projId}` }), 1000);
    }

    else if (data.startsWith("tog_log_")) {
        const projId = getData(data, "tog_log_");
        if (ACTIVE_SESSIONS[projId]) ACTIVE_SESSIONS[projId].logging = !ACTIVE_SESSIONS[projId].logging;
        bot.emit('callback_query', { ...query, data: `menu_${projId}` });
    }

    else if (data.startsWith("upd_")) {
        const projId = getData(data, "upd_");
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        USER_STATE[userId] = { step: "update_files", data: proj };
        bot.sendMessage(chatId, `📝 *Update Mode:* ${escapeMarkdown(proj.name)}\nSend new files now.`, {
            reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2'
        });
    }

    else if (data.startsWith("get_logs_")) {
        const projId = getData(data, "get_logs_");
        const logFile = path.join(LOG_DIR, `${projId}.txt`);
        if (fs.existsSync(logFile)) bot.sendDocument(chatId, logFile);
        else bot.sendMessage(chatId, "❌ No logs available.");
    }

    else if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Project Name:");
    }

    else if (data === "main_menu") {
        await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
    }
});

// Old restore function compatibility
async function restoreProjects() { syncCacheAndRestore(); }

bot.on('polling_error', (e) => console.log(e.message));
