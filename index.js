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
console.log("[INIT] Starting Master Bot v4.0...");
const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

// ANTI-CRASH: Polling Error Handler
bot.on('polling_error', (error) => {
    if (error.message.includes('409 Conflict')) {
        console.log("⚠️ Conflict: Bot is running twice!");
    } else {
        console.log(`[Polling Error] ${error.message}`);
    }
});

const client = new MongoClient(MONGO_URL, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000
});

let db, projectsCol, keysCol, usersCol;
const PROJECT_CACHE = {}; 
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

const IGNORED_LOGS = [
    'Bad MAC', 'Decrypt', 'rate-overlimit', 'pre-key', 
    'SessionEntry', 'Closing session', 'ratchet', 
    'connection closed', 'QR', 'timeout', 'npm warn'
];

if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// ================= DATABASE CONNECTION =================
async function connectDB() {
    console.log("[DB] 🟡 Connecting...");
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        console.log("[DB] 🟢 Connected!");
        startDBKeepAlive();
        setTimeout(syncCacheAndRestore, 1000); 
    } catch (e) {
        console.error("[DB FAIL]", e.message);
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

// ULTRA STRONG MARKDOWN ESCAPER
function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString().replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

// SYNC DB -> RAM -> DISK
async function syncCacheAndRestore() {
    console.log("🔄 Syncing DB to Local Cache...");
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
        console.log("🚀 System Ready!");
    } catch (e) { console.error("Sync Error:", e); }
}

// ================= HELPERS =================

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

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    try { return !!(await usersCol.findOne({ user_id: userId })); } catch { return false; }
}

function getData(data, prefix) { return data.substring(prefix.length); }

async function safeEditMessage(chatId, messageId, text, keyboard) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId, message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2'
        });
    } catch (e) {
        await bot.sendMessage(chatId, text, {
            reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2'
        });
    }
}

// DUAL SAVE: RAM + DB
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    if (PROJECT_CACHE[userId]) {
        const projIndex = PROJECT_CACHE[userId].findIndex(p => p._id.toString() === projId.toString());
        if (projIndex > -1) {
            if (!PROJECT_CACHE[userId][projIndex].files) PROJECT_CACHE[userId][projIndex].files = [];
            PROJECT_CACHE[userId][projIndex].files = PROJECT_CACHE[userId][projIndex].files.filter(f => f.name !== relativePath);
            PROJECT_CACHE[userId][projIndex].files.push({ name: relativePath, content: contentBuffer });
        }
    }
    const safeId = new ObjectId(String(projId));
    await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: relativePath } } }).catch(()=>{});
    await projectsCol.updateOne({ _id: safeId }, { $push: { files: { name: relativePath, content: contentBuffer } } }).catch(()=>{});
    return true;
}

function startFullSyncWatcher(userId, projId, basePath) {
    const watcherId = projId.toString();
    if (FILE_WATCHERS[watcherId]) try { FILE_WATCHERS[watcherId].close(); } catch(e){}
    try {
        const watcher = fs.watch(basePath, { recursive: true }, async (eventType, filename) => {
            if (filename && !filename.includes('node_modules') && !filename.includes('.git')) {
                const fullPath = path.join(basePath, filename);
                if (fs.existsSync(fullPath)) {
                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.isFile()) {
                            const content = fs.readFileSync(fullPath);
                            saveFileToStorage(userId, projId, filename.replace(/\\/g, '/'), content);
                        }
                    } catch (err) {}
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
    for (const uid in PROJECT_CACHE) {
        const p = PROJECT_CACHE[uid].find(x => x._id.toString() === pid);
        if (p) p.status = "Stopped";
    }
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
}

// ================= PROCESS ENGINE =================

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
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    const pkgPath = path.join(basePath, 'package.json');
    if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(basePath, 'node_modules'))) {
        try { await installDependencies(basePath, chatId); } catch (err) { return; }
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
    const logFilePath = path.join(LOG_DIR, `${pid}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

    ACTIVE_SESSIONS[pid] = { process: child, logging: true, logStream: logStream, chatId: chatId, name: projName };
    startFullSyncWatcher(userId, projId, basePath);
    
    projectData.status = "Running";
    projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running", path: basePath } });

    const handleLog = (data, isError) => {
        const raw = data.toString();
        logStream.write(raw);
        if (!chatId) return;
        const clean = raw.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        if (IGNORED_LOGS.some(ign => clean.includes(ign))) return;

        const codeMatch = clean.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || clean.match(/Pairing Code:\s*([A-Z0-9-]{8,})/i);
        if (codeMatch) return bot.sendMessage(chatId, `🔑 *PAIRING CODE:*\n\`${escapeMarkdown(codeMatch[1] || codeMatch[0])}\``, { parse_mode: "MarkdownV2" });

        if (clean.toLowerCase().includes("connected")) {
            bot.sendMessage(chatId, `✅ *Active:* ${escapeMarkdown(projName)}`, { parse_mode: "MarkdownV2" });
            ACTIVE_SESSIONS[pid].logging = false;
            return;
        }

        if (isError && ACTIVE_SESSIONS[pid].logging) {
            bot.sendMessage(chatId, `⚠️ *Log:*\n\`${escapeMarkdown(clean.slice(0, 300))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
        }
    };

    child.stdout.on('data', d => handleLog(d, false));
    child.stderr.on('data', d => handleLog(d, true));
    child.on('close', (code) => {
        forceStopProject(projId);
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 *Stopped* (Code ${code})`);
    });
}

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if(chatId) bot.sendMessage(chatId, `📦 *Installing Modules...*`);
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('close', (code) => code === 0 ? resolve() : reject());
    });
}

// ================= HANDLERS =================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (text && text.startsWith("/start")) {
        const args = text.split(" ");
        if (args[1]) {
            const keyDoc = await keysCol.findOne({ key: args[1], status: "active" });
            if (keyDoc) {
                await usersCol.insertOne({ user_id: userId, joined_at: new Date() });
                await keysCol.updateOne({ key: args[1] }, { $set: { status: "used", used_by: userId } });
                return bot.sendMessage(chatId, "✅ *Access Granted!*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' });
            }
        }
        if (await isAuthorized(userId)) bot.sendMessage(chatId, "👋 *Master Bot*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' });
        else bot.sendMessage(chatId, "🔒 Access Denied.");
        return;
    }

    if (USER_STATE[userId]) {
        if (text === "✅ Done / Apply Actions") {
            const projData = USER_STATE[userId].data;
            const step = USER_STATE[userId].step;
            delete USER_STATE[userId];
            const m = await bot.sendMessage(chatId, "⚙️ *Applying...*", { reply_markup: { remove_keyboard: true } });
            if (step === "update_files") await forceStopProject(projData._id);
            setTimeout(() => { startProject(userId, projData._id, chatId); bot.deleteMessage(chatId, m.message_id); }, 2000);
            return;
        }
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
});

bot.on('document', async (msg) => {
    const userId = msg.from.id;
    if (USER_STATE[userId] && USER_STATE[userId].step.includes("files")) {
        const projData = USER_STATE[userId].data;
        const dir = path.join(__dirname, 'deployments', userId.toString(), projData.name);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, msg.document.file_name);
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));
        await saveFileToStorage(userId, projData._id, msg.document.file_name, Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ *Saved:* \`${escapeMarkdown(msg.document.file_name)}\``, { parse_mode: 'MarkdownV2' });
    }
});

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
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        if (!proj) return;
        const isRunning = proj.status === "Running";
        const keyboard = [
            [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `tog_run_${projId}` }, { text: "📝 Update", callback_data: `upd_${projId}` }],
            [{ text: "📥 Logs", callback_data: `get_logs_${projId}` }, { text: "🔄 Renew Session", callback_data: `renew_${projId}` }],
            [{ text: "🗑️ Delete", callback_data: `del_${projId}` }, { text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        await safeEditMessage(chatId, messageId, `⚙️ *${escapeMarkdown(proj.name)}*`, keyboard);
    }
    else if (data.startsWith("tog_run_")) {
        const projId = getData(data, "tog_run_");
        if (ACTIVE_SESSIONS[projId]) await forceStopProject(projId);
        else startProject(userId, projId, chatId);
        setTimeout(() => bot.emit('callback_query', { ...query, data: `menu_${projId}` }), 1000);
    }
    else if (data.startsWith("upd_")) {
        const projId = getData(data, "upd_");
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        USER_STATE[userId] = { step: "update_files", data: proj };
        bot.sendMessage(chatId, `📝 *Update: ${escapeMarkdown(proj.name)}*\nSend files now.`, {
            reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2'
        });
    }
    else if (data.startsWith("del_")) {
        const projId = getData(data, "del_");
        await forceStopProject(projId);
        await projectsCol.deleteOne({ _id: new ObjectId(projId) });
        PROJECT_CACHE[userId] = PROJECT_CACHE[userId].filter(p => p._id.toString() !== projId);
        bot.sendMessage(chatId, "🗑️ Deleted.");
        bot.emit('callback_query', { ...query, data: "manage_projects" });
    }
    else if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Project Name:");
    }
    else if (data === "main_menu") {
        await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
    }
    else if (data.startsWith("get_logs_")) {
        const logFile = path.join(LOG_DIR, `${getData(data, "get_logs_")}.txt`);
        if (fs.existsSync(logFile)) bot.sendDocument(chatId, logFile);
        else bot.sendMessage(chatId, "❌ No Logs.");
    }
    else if (data === "owner_panel") {
        const keyboard = [[{ text: "🔑 Gen Key", callback_data: "gen_key" }], [{ text: "🔙 Back", callback_data: "main_menu" }]];
        await safeEditMessage(chatId, messageId, "👑 *Owner Panel*", keyboard);
    }
    else if (data === "gen_key") {
        const key = uuid.v4().split('-')[0];
        await keysCol.insertOne({ key: key, status: "active" });
        bot.sendMessage(chatId, `🔑 *New Key:* \`${key}\``, { parse_mode: 'MarkdownV2' });
    }
});
