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
console.log("[INIT] Starting Master Bot v3.0 (Session Persist)...");
const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 10 }
    }
});

const client = new MongoClient(MONGO_URL, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000
});

let db, projectsCol, keysCol, usersCol;

// 🔥 RAM CACHE (Mirror of DB)
const PROJECT_CACHE = {}; 

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

// Errors to HIDE from Chat (But save to file)
const IGNORED_LOGS = [
    'Bad MAC', 'Decrypt', 'rate-overlimit', 'pre-key', 
    'SessionEntry', 'Closing session', 'ratchet', 
    'connection closed', 'QR', 'timeout'
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

// 🔥 SYNC DB -> RAM -> DISK (On Startup)
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
            
            // Restore ALL files (Including Session)
            if (proj.files) {
                for (const file of proj.files) {
                    const filePath = path.join(dir, file.name);
                    const fileDir = path.dirname(filePath);
                    if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
                    fs.writeFileSync(filePath, file.content.buffer);
                }
            }

            if (proj.status === "Running") {
                console.log(`✅ Auto-Restarting: ${proj.name}`);
                startProject(uid, proj._id, null, true);
            }
        }
        console.log("🚀 System Ready!");
    } catch (e) { console.error("Sync Error:", e); }
}

// ================= CORE FUNCTIONS =================

// 🔥 DUAL SAVE: RAM + DB (Persistent)
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    // 1. Update RAM Cache
    if (PROJECT_CACHE[userId]) {
        const projIndex = PROJECT_CACHE[userId].findIndex(p => p._id.toString() === projId.toString());
        if (projIndex > -1) {
            if (!PROJECT_CACHE[userId][projIndex].files) PROJECT_CACHE[userId][projIndex].files = [];
            // Remove old version
            PROJECT_CACHE[userId][projIndex].files = PROJECT_CACHE[userId][projIndex].files.filter(f => f.name !== relativePath);
            // Add new version
            PROJECT_CACHE[userId][projIndex].files.push({ name: relativePath, content: contentBuffer });
        }
    }

    // 2. Update DB (Upsert Logic)
    const safeId = new ObjectId(String(projId));
    
    // Pehle remove karo (Agar exist karta hai)
    await projectsCol.updateOne(
        { _id: safeId },
        { $pull: { files: { name: relativePath } } }
    ).catch(()=>{});

    // Phir Add karo
    await projectsCol.updateOne(
        { _id: safeId },
        { $push: { files: { name: relativePath, content: contentBuffer } } }
    ).catch(()=>{});

    return true;
}

function startFullSyncWatcher(userId, projId, basePath) {
    const watcherId = projId.toString();
    if (FILE_WATCHERS[watcherId]) try { FILE_WATCHERS[watcherId].close(); } catch(e){}

    try {
        // 🔥 Watch EVERYTHING except node_modules (Sessions included)
        const watcher = fs.watch(basePath, { recursive: true }, async (eventType, filename) => {
            if (filename && !filename.includes('node_modules') && !filename.includes('.git')) {
                const fullPath = path.join(basePath, filename);
                
                // File Changed/Added
                if (fs.existsSync(fullPath)) {
                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.isFile()) {
                            const content = fs.readFileSync(fullPath);
                            const relativePath = filename.replace(/\\/g, '/');
                            // Save Session Files to DB automatically
                            saveFileToStorage(userId, projId, relativePath, content);
                        }
                    } catch (err) {}
                }
                // File Deleted Logic (Optional: We keep in DB for safety usually)
            }
        });
        FILE_WATCHERS[watcherId] = watcher;
    } catch (err) {}
}

async function forceStopProject(projId) {
    const pid = projId.toString();
    if (ACTIVE_SESSIONS[pid]) {
        try { ACTIVE_SESSIONS[pid].process.kill('SIGKILL'); } catch (e) {}
        try { ACTIVE_SESSIONS[pid].logStream.end(); } catch(e){}
        delete ACTIVE_SESSIONS[pid];
    }
    if (FILE_WATCHERS[pid]) {
        try { FILE_WATCHERS[pid].close(); } catch(e){}
        delete FILE_WATCHERS[pid];
    }
    
    // RAM Status Update
    for (const uid in PROJECT_CACHE) {
        const p = PROJECT_CACHE[uid].find(x => x._id.toString() === pid);
        if (p) p.status = "Stopped";
    }
    
    // DB Status Update
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
}

async function renewSession(userId, projId, chatId, basePath) {
    try {
        await forceStopProject(projId);
        const safeId = new ObjectId(String(projId));
        
        // 🔥 ONLY HERE we delete session from DB
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: { $regex: /^session\// } } } });
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: { $regex: /^auth_info_baileys\// } } } });

        const sessionPath = path.join(basePath, 'session');
        const authPath = path.join(basePath, 'auth_info_baileys');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        // Cache clear logic
        if(PROJECT_CACHE[userId]) {
            const p = PROJECT_CACHE[userId].find(x => x._id.toString() === String(projId));
            if(p) p.files = p.files.filter(f => !f.name.includes('session/') && !f.name.includes('auth_info_baileys/'));
        }

        if(chatId) bot.sendMessage(chatId, `🔄 *Session Reset Done.*\nStarting fresh...`, { parse_mode: 'Markdown' }).catch(e => {});
        setTimeout(() => startProject(userId, projId, chatId), 2000);
    } catch (e) {}
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

    // 1. Kill Old Process
    await forceStopProject(projId);
    
    const safeName = escapeMarkdown(projName);
    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Starting ${safeName}...*`, { parse_mode: 'Markdown' }).catch(e => {});

    // 2. Ensure Files Exist (RAM -> Disk)
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
    
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            // Only overwrite if size differs or missing (Optimization)
            if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    // 3. Dependencies
    const pkgPath = path.join(basePath, 'package.json');
    const modulesPath = path.join(basePath, 'node_modules');
    if (fs.existsSync(pkgPath) && !fs.existsSync(modulesPath)) {
        try { await installDependencies(basePath, chatId); } 
        catch (err) { 
            if(chatId) bot.sendMessage(chatId, "❌ Dependency Error."); 
            return; 
        }
    }

    // 4. Launch
    const child = spawn('node', ['index.js'], { cwd: basePath, stdio: ['pipe', 'pipe', 'pipe'] });
    const logFilePath = path.join(LOG_DIR, `${pid}.txt`);
    const logStream = fs.createWriteStream(logFilePath, { flags: 'w' });

    ACTIVE_SESSIONS[pid] = {
        process: child,
        logging: true,
        logStream: logStream,
        chatId: chatId,
        basePath: basePath,
        name: projName
    };

    // 5. Watch for Session Changes
    startFullSyncWatcher(userId, projId, basePath);
    
    // Update Status
    projectData.status = "Running";
    projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running", path: basePath } });

    // --- LOG FILTERING ---
    const handleLog = (data, isError) => {
        const raw = data.toString();
        logStream.write(raw); // Always save to file
        if (!chatId) return;

        const clean = raw.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        
        // 🔥 FILTER: Don't show spam logs
        if (IGNORED_LOGS.some(ign => clean.includes(ign))) return;

        // Pairing Code Logic
        const codeMatch = clean.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || clean.match(/Pairing Code:\s*([A-Z0-9-]{8,})/i);
        if (codeMatch) {
            let code = codeMatch[1] || codeMatch[0];
            bot.sendMessage(chatId, `🔑 *PAIRING CODE:*\n\`${code}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
            return;
        }

        // Success Logic
        if (clean.toLowerCase().includes("connected") || clean.toLowerCase().includes("success")) {
            bot.sendMessage(chatId, `✅ *Active:* ${escapeMarkdown(projName)}`, { parse_mode: "MarkdownV2" }).catch(()=>{});
            if (ACTIVE_SESSIONS[pid].logging) {
                ACTIVE_SESSIONS[pid].logging = false;
                bot.sendMessage(chatId, `🔇 Logs muted (Running)`).catch(()=>{});
            }
            return;
        }

        // Critical Errors only
        if (isError && ACTIVE_SESSIONS[pid].logging) {
             bot.sendMessage(chatId, `⚠️ *Log:*\n\`${escapeMarkdown(clean.slice(0, 200))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
        }
    };

    child.stdout.on('data', d => handleLog(d, false));
    child.stderr.on('data', d => handleLog(d, true));

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[pid]) delete ACTIVE_SESSIONS[pid];
        if (FILE_WATCHERS[pid]) try { FILE_WATCHERS[pid].close(); } catch(e){}
        
        projectData.status = "Stopped";
        projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } }).catch(()=>{});
        
        if (chatId && !silent && ACTIVE_SESSIONS[pid]?.logging) { 
             bot.sendMessage(chatId, `🛑 *Stopped* (Code ${code})`).catch(()=>{});
        }
    });
}

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if(chatId) bot.sendMessage(chatId, `📦 *Installing Modules...*`, { parse_mode: 'Markdown' }).catch(e => {});
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('close', (code) => code === 0 ? resolve("Success") : reject("Failed"));
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
                bot.sendMessage(chatId, "👋 *Master Bot v3.0*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' });
            } else {
                bot.sendMessage(chatId, "🔒 Access Denied");
            }
            return;
        }

        if (USER_STATE[userId]) {
            // 🔥 RESTART ON DONE
            if (text === "✅ Done / Apply Actions") {
                if (USER_STATE[userId].step.includes("files")) {
                    const projData = USER_STATE[userId].data;
                    const isUpdate = USER_STATE[userId].step === "update_files";
                    delete USER_STATE[userId]; 
                    
                    const m = await bot.sendMessage(chatId, "⚙️ *Applying & Restarting...*", { reply_markup: { remove_keyboard: true }, parse_mode: 'Markdown' });
                    
                    // Kill first, then Start (ensures DB is updated)
                    if (isUpdate) await forceStopProject(projData._id);
                    setTimeout(() => {
                        startProject(userId, projData._id, chatId);
                        bot.deleteMessage(chatId, m.message_id).catch(()=>{});
                    }, 2000);
                    return;
                }
            }

            // ... (Name creation logic same as before) ...
            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim(); 
                if (PROJECT_CACHE[userId] && PROJECT_CACHE[userId].find(p => p.name === projName)) {
                    return bot.sendMessage(chatId, "❌ Name taken.");
                }
                const res = await projectsCol.insertOne({ user_id: userId, name: projName, files: [], status: "Stopped" });
                const newProj = { _id: res.insertedId, user_id: userId, name: projName, files: [], status: "Stopped" };
                if (!PROJECT_CACHE[userId]) PROJECT_CACHE[userId] = [];
                PROJECT_CACHE[userId].push(newProj);
                USER_STATE[userId] = { step: "wait_files", data: newProj };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2' };
                bot.sendMessage(chatId, `✅ Created: *${escapeMarkdown(projName)}*\n\n1️⃣ Send files now.`, opts);
            }
        } 
    } catch (err) { }
});

bot.on('document', async (msg) => {
    try {
        const userId = msg.from.id;
        if (USER_STATE[userId] && USER_STATE[userId].step.includes("files")) {
            const projData = USER_STATE[userId].data;
            const fileName = msg.document.file_name;
            const dir = path.join(__dirname, 'deployments', userId.toString(), projData.name);
            
            const loadingMsg = await bot.sendMessage(msg.chat.id, `📥 *Uploading:* \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' });

            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const filePath = path.join(dir, fileName);
            const fileLink = await bot.getFileLink(msg.document.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer();
            
            // Write to Disk (Instant)
            fs.writeFileSync(filePath, Buffer.from(buffer));
            
            // Save to DB & Cache (Background)
            await saveFileToStorage(userId, projData._id, fileName, Buffer.from(buffer));

            bot.editMessageText(`✅ *Updated:* \`${escapeMarkdown(fileName)}\``, { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'MarkdownV2' }).catch(()=>{});
        }
    } catch (err) { }
});

// ... (Callback handlers same as before - just ensure buttons call startProject/forceStopProject) ...
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;
    try { await bot.answerCallbackQuery(query.id); } catch(e) {}

    // ... (Previous logic for menus, just ensure safeEditMessage is used) ...
    if (data === "manage_projects") {
        const projects = PROJECT_CACHE[userId] || [];
        const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p._id.toString()}` }]);
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
    }
    // ... Copy remaining handlers (menu_, tog_run_, del_, upd_, etc.) from previous robust code ...
    else if (data.startsWith("menu_")) {
        const projId = getData(data, "menu_");
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        if (!proj) return bot.sendMessage(chatId, "❌ Not Found");
        const isRunning = proj.status === "Running";
        const keyboard = [
            [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `tog_run_${projId}` }, { text: "📝 Update Files", callback_data: `upd_${projId}` }],
            [{ text: "📥 Logs", callback_data: `get_logs_${projId}` }, { text: "🔄 Renew Session", callback_data: `renew_${projId}` }],
            [{ text: "🗑️ Delete", callback_data: `del_${projId}` }, { text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        await safeEditMessage(chatId, messageId, `⚙️ *${escapeMarkdown(proj.name)}*`, keyboard);
    }
    else if (data.startsWith("tog_run_")) {
        const projId = getData(data, "tog_run_");
        if (ACTIVE_SESSIONS[projId.toString()]) {
            await forceStopProject(projId);
            bot.sendMessage(chatId, "🛑 Stopped");
        } else {
            startProject(userId, projId, chatId);
        }
        bot.emit('callback_query', { ...query, data: `menu_${projId}` });
    }
    else if (data.startsWith("upd_")) {
        const projId = getData(data, "upd_");
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        USER_STATE[userId] = { step: "update_files", data: proj };
        const opts = { parse_mode: 'MarkdownV2', reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] } };
        bot.sendMessage(chatId, `📝 *Update Mode: ${escapeMarkdown(proj.name)}*\n\n1️⃣ Send files.\n2️⃣ Click Done to restart.`, opts);
    }
    else if (data.startsWith("renew_")) {
        const projId = getData(data, "renew_");
        const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
        if(proj) renewSession(userId, projId, chatId, path.join(__dirname, 'deployments', userId.toString(), proj.name));
    }
    else if (data.startsWith("del_")) {
        const projId = getData(data, "del_");
        try {
            await forceStopProject(projId);
            await projectsCol.deleteOne({ _id: new ObjectId(projId) });
            fs.rmSync(path.join(__dirname, 'deployments', userId.toString()), { recursive: true, force: true });
            PROJECT_CACHE[userId] = PROJECT_CACHE[userId].filter(p => p._id.toString() !== projId);
            bot.sendMessage(chatId, "🗑️ Deleted");
        } catch(e) {}
    }
    else if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Name:");
    }
    else if (data === "main_menu") {
        await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
    }
    else if (data.startsWith("get_logs_")) {
        const projId = getData(data, "get_logs_");
        const logFile = path.join(LOG_DIR, `${projId}.txt`);
        if (fs.existsSync(logFile)) bot.sendDocument(chatId, logFile);
        else bot.sendMessage(chatId, "❌ No Logs");
    }
});

// Helper imports
function escapeMarkdown(text) { if (!text) return ""; return text.toString().replace(/[_*[\]()~\x60>#+\-=|{}.!]/g, '\\$&'); }
async function isAuthorized(userId) { if (OWNER_IDS.includes(userId)) return true; try { return !!(await usersCol.findOne({ user_id: userId })); } catch { return false; } }
function getMainMenu(userId) { let k = [[{ text: "🚀 Deploy", callback_data: "deploy_new" }], [{ text: "📂 Manage", callback_data: "manage_projects" }]]; if (OWNER_IDS.includes(userId)) k.push([{ text: "👑 Panel", callback_data: "owner_panel" }]); return { inline_keyboard: k }; }
function getData(d, p) { return d.substring(p.length); }
async function safeEditMessage(chatId, messageId, text, keyboard) { try { await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2' }); } catch (e) { await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: keyboard }, parse_mode: 'MarkdownV2' }); } }

bot.on('polling_error', (e) => console.log(e.message));
