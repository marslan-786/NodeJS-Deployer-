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
console.log("[INIT] Starting High-Speed Bot...");
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

// 🔥🔥🔥 LOCAL CACHE (THE SPEED SECRET) 🔥🔥🔥
// ہم پروجیکٹس کو یہاں میموری میں رکھیں گے تاکہ بار بار DB نہ جانا پڑے
const PROJECT_CACHE = {}; // Structure: { userId: [project1, project2] }

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

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
        
        // 🔥 STARTUP: Load DB into RAM Cache
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

// 🔥🔥 SYNC CACHE FUNCTION 🔥🔥
async function syncCacheAndRestore() {
    console.log("🔄 Syncing DB to Local Cache...");
    try {
        const allProjects = await projectsCol.find({}).toArray();
        
        // Clear Cache first
        for (const key in PROJECT_CACHE) delete PROJECT_CACHE[key];

        // Populate Cache
        for (const proj of allProjects) {
            const uid = proj.user_id;
            if (!PROJECT_CACHE[uid]) PROJECT_CACHE[uid] = [];
            PROJECT_CACHE[uid].push(proj);
            
            // Restore Files to Disk (If running or needed)
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
                console.log(`✅ Restarting: ${proj.name}`);
                startProject(uid, proj._id, null, true);
            }
        }
        console.log("🚀 Cache Synced! Bot is ready for instant speed.");
    } catch (e) { console.error("Sync Error:", e); }
}

// ================= HELPER FUNCTIONS =================

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString().replace(/[_*[\]()~\x60>#+\-=|{}.!]/g, '\\$&');
}

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    // For Auth, we still check DB to be safe, or cache users too
    try { return !!(await usersCol.findOne({ user_id: userId })); } 
    catch { return false; }
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

function getData(data, prefix) {
    return data.substring(prefix.length); 
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

// 🔥 BACKGROUND SAVE (FIRE AND FORGET)
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    // 1. Update Local Cache (Instant)
    if (PROJECT_CACHE[userId]) {
        const projIndex = PROJECT_CACHE[userId].findIndex(p => p._id.toString() === projId.toString());
        if (projIndex > -1) {
            // Remove old file from cache array if exists
            PROJECT_CACHE[userId][projIndex].files = PROJECT_CACHE[userId][projIndex].files.filter(f => f.name !== relativePath);
            // Add new file
            PROJECT_CACHE[userId][projIndex].files.push({ name: relativePath, content: contentBuffer });
        }
    }

    // 2. Update DB (Background - Don't await strictly)
    const safeId = new ObjectId(String(projId));
    projectsCol.updateOne(
        { _id: safeId },
        { $pull: { files: { name: relativePath } } }
    ).then(() => {
        projectsCol.updateOne(
            { _id: safeId },
            { $push: { files: { name: relativePath, content: contentBuffer } } }
        ).catch(err => console.error("BG Save Error:", err.message));
    }).catch(err => console.error("BG Pull Error:", err.message));
}

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json");
        }
        if(chatId) bot.sendMessage(chatId, `📦 *Installing Dependencies...*`, { parse_mode: 'Markdown' }).catch(e => {});
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('error', (err) => reject(err));
        install.on('close', (code) => resolve(code === 0 ? "Success" : "Warn"));
    });
}

// Watcher Updates Cache & DB
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
                            const relativePath = filename.replace(/\\/g, '/');
                            // Use the optimized save function
                            saveFileToStorage(userId, projId, relativePath, content);
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
        delete ACTIVE_SESSIONS[pid];
    }
    if (FILE_WATCHERS[pid]) {
        try { FILE_WATCHERS[pid].close(); } catch(e){}
        delete FILE_WATCHERS[pid];
    }
    
    // Update Local Cache Status
    for (const uid in PROJECT_CACHE) {
        const p = PROJECT_CACHE[uid].find(x => x._id.toString() === pid);
        if (p) p.status = "Stopped";
    }
    
    // Update DB
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
}

// ================= 🔥 MAIN START PROJECT 🔥 =================

async function startProject(userId, projId, chatId, silent = false) {
    // 1. Get from Cache (Instant)
    let projectData = null;
    if (PROJECT_CACHE[userId]) {
        projectData = PROJECT_CACHE[userId].find(p => p._id.toString() === projId.toString());
    }
    
    // Fallback to DB if cache empty (Safety)
    if (!projectData) {
        projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
    }

    if (!projectData) return;

    const projName = projectData.name;
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const pid = projId.toString();

    await forceStopProject(projId);
    const safeName = escapeMarkdown(projName);

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Starting ${safeName}...*`, { parse_mode: 'Markdown' }).catch(e => {});

    // Ensure files exist (Local cache might be right, but disk might be empty on restart)
    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });
    
    // We assume files are already restored by startup sync. 
    // But if this is a fresh manual start, verify critical files.
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (!fs.existsSync(fullPath)) fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) { }
    }

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

    startFullSyncWatcher(userId, projId, basePath);
    
    // Update Cache Status
    projectData.status = "Running";
    
    // Update DB Status
    projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running", path: basePath } });

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 *${safeName} Started!*`, { parse_mode: 'Markdown' }).catch(e => {});
    }

    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);
        if (!chatId) return;

        const clean = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        const lower = clean.toLowerCase();

        const codeMatch = clean.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || clean.match(/Pairing Code:\s*([A-Z0-9-]{8,})/i);
        if (codeMatch) {
            let code = codeMatch[1] || codeMatch[0];
            bot.sendMessage(chatId, `🔑 *YOUR PAIRING CODE:*\n\n\`${code}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            return;
        }

        if ((lower.includes("enter") || lower.includes("number")) && clean.includes(":")) {
             bot.sendMessage(chatId, `⌨️ *Input Requested:*\n\`${escapeMarkdown(clean.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             return;
        }

        const successKeywords = ["connected", "bot is live", "success", "polling", "webhook", "launched"];
        if (successKeywords.some(k => lower.includes(k)) && !lower.includes("pairing")) {
            bot.sendMessage(chatId, `✅ *Status Update:*\n\`${escapeMarkdown(clean.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            if (ACTIVE_SESSIONS[pid].logging) {
                ACTIVE_SESSIONS[pid].logging = false;
                bot.sendMessage(chatId, `🔇 *Auto-Mute Active*`).catch(()=>{});
            }
            return;
        }

        if (ACTIVE_SESSIONS[pid].logging) {
             if(clean.trim().length > 0 && clean.length < 800) {
                 bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(clean.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             }
        }
    });

    child.stderr.on('data', (data) => {
        logStream.write(data);
        const error = data.toString();
        if (chatId && ACTIVE_SESSIONS[pid].logging) {
             if (!error.includes("npm notice") && !error.includes("ExperimentalWarning")) {
                 bot.sendMessage(chatId, `⚠️ *Error:*\n\`${escapeMarkdown(error.slice(0, 300))}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             }
        }
    });

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[pid]) delete ACTIVE_SESSIONS[pid];
        if (FILE_WATCHERS[pid]) try { FILE_WATCHERS[pid].close(); } catch(e){}
        
        // Update Cache & DB Status
        projectData.status = "Stopped";
        projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } }).catch(()=>{});
        
        if (chatId && !silent && ACTIVE_SESSIONS[pid]?.logging) { 
             bot.sendMessage(chatId, `🛑 *Bot Stopped*`, { parse_mode: "Markdown" }).catch(e => {});
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
                    const projData = USER_STATE[userId].data;
                    const isUpdate = USER_STATE[userId].step === "update_files";
                    
                    delete USER_STATE[userId]; 
                    
                    const statusMsg = await bot.sendMessage(chatId, "⚙️ *Processing Actions...*", { reply_markup: { remove_keyboard: true }, parse_mode: 'Markdown' });
                    
                    if (isUpdate) await forceStopProject(projData._id);
                    
                    setTimeout(() => {
                        startProject(userId, projData._id, chatId);
                        bot.deleteMessage(chatId, statusMsg.message_id).catch(e=>{});
                    }, 1000);
                    return;
                }
            }

            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim(); 
                // Local Check first
                if (PROJECT_CACHE[userId] && PROJECT_CACHE[userId].find(p => p.name === projName)) {
                    return bot.sendMessage(chatId, "❌ Name taken.");
                }

                // Create DB Entry (We need ID)
                const res = await projectsCol.insertOne({
                    user_id: userId,
                    name: projName,
                    files: [],
                    status: "Stopped"
                });
                
                // Add to Cache Immediately
                const newProj = { _id: res.insertedId, user_id: userId, name: projName, files: [], status: "Stopped" };
                if (!PROJECT_CACHE[userId]) PROJECT_CACHE[userId] = [];
                PROJECT_CACHE[userId].push(newProj);

                USER_STATE[userId] = { step: "wait_files", data: newProj };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2' };
                bot.sendMessage(chatId, `✅ Created: *${escapeMarkdown(projName)}*\n\n1️⃣ Send files now\\.`, opts).catch(e => {});
            }
        } 
        
        // Console Input
        else {
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
    try {
        const userId = msg.from.id;
        if (USER_STATE[userId] && (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files")) {
            const projData = USER_STATE[userId].data;
            const fileName = msg.document.file_name;
            const dir = path.join(__dirname, 'deployments', userId.toString(), projData.name);
            
            // 🔥 INSTANT FEEDBACK
            const loadingMsg = await bot.sendMessage(msg.chat.id, `📥 *Uploading:* \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' });

            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const filePath = path.join(dir, fileName);
            const fileLink = await bot.getFileLink(msg.document.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer();
            
            // 1. Write to Disk (Fastest)
            fs.writeFileSync(filePath, Buffer.from(buffer));
            
            // 2. Fire & Forget DB Save (Background)
            saveFileToStorage(userId, projData._id, fileName, Buffer.from(buffer));

            // 3. Update User UI Immediately
            bot.editMessageText(`✅ *Saved:* \`${escapeMarkdown(fileName)}\``, { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'MarkdownV2' }).catch(e=>{});
        }
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Upload Error`);
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try { await bot.answerCallbackQuery(query.id); } catch(e) {}

    try {
        if (data === "owner_panel") {
            if (!OWNER_IDS.includes(userId)) return bot.sendMessage(chatId, "⛔ Access Denied");
            const keyboard = [
                [{ text: "🔑 Generate Key", callback_data: "gen_key" }],
                [{ text: "📜 List Keys", callback_data: "list_keys" }],
                [{ text: "🔙 Back", callback_data: "main_menu" }]
            ];
            await safeEditMessage(chatId, messageId, "👑 *Owner Panel*", keyboard);
        }

        // ... (Keys Logic omitted for brevity, logic remains same)

        else if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            bot.sendMessage(chatId, "📂 Enter Project Name (Spaces allowed):").catch(e => {});
        }
        
        else if (data === "manage_projects") {
            // 🔥🔥 FETCH FROM RAM CACHE (INSTANT) 🔥🔥
            const projects = PROJECT_CACHE[userId] || [];
            
            const keyboard = projects.map(p => [{ 
                text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, 
                callback_data: `menu_${p._id.toString()}` 
            }]);
            
            keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
            await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
        }
        
        else if (data.startsWith("menu_")) {
            const projId = getData(data, "menu_");
            // Find in RAM
            const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
            
            if (!proj) return bot.sendMessage(chatId, "❌ Project not found in cache.");

            const isRunning = proj.status === "Running";
            const isLogging = (ACTIVE_SESSIONS[projId] && ACTIVE_SESSIONS[projId].logging) ? true : false;

            const keyboard = [
                [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `tog_run_${projId}` }, { text: isLogging ? "🔴 Disable Logs" : "🟢 Enable Logs", callback_data: `tog_log_${projId}` }],
                [{ text: "📝 Update Files", callback_data: `upd_${projId}` }, { text: "📥 Download Logs", callback_data: `get_logs_${projId}` }],
                [{ text: "🔄 Renew Session", callback_data: `renew_${projId}` }], 
                [{ text: "🗑️ Delete", callback_data: `del_${projId}` }],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            await safeEditMessage(chatId, messageId, `⚙️ Manage: *${escapeMarkdown(proj.name)}*\n\nStatus: ${isRunning ? 'Running 🟢' : 'Stopped 🔴'}`, keyboard);
        }
        
        else if (data.startsWith("tog_run_")) {
            const projId = getData(data, "tog_run_");
            if (ACTIVE_SESSIONS[projId]) {
                await forceStopProject(projId);
                bot.sendMessage(chatId, `🛑 *Stopped*`).catch(e => {});
            } else {
                startProject(userId, projId, chatId);
                return; 
            }
            // Refresh Menu
            bot.emit('callback_query', { ...query, data: `menu_${projId}` });
        }

        else if (data.startsWith("renew_")) {
            const projId = getData(data, "renew_");
            const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
            if(proj) {
                const basePath = path.join(__dirname, 'deployments', userId.toString(), proj.name);
                await renewSession(userId, projId, chatId, basePath);
            }
        }

        else if (data.startsWith("tog_log_")) {
            const projId = getData(data, "tog_log_");
            if (ACTIVE_SESSIONS[projId]) ACTIVE_SESSIONS[projId].logging = !ACTIVE_SESSIONS[projId].logging;
            bot.emit('callback_query', { ...query, data: `menu_${projId}` });
        }

        else if (data.startsWith("get_logs_")) {
            const projId = getData(data, "get_logs_");
            const logFile = path.join(LOG_DIR, `${projId}.txt`);
            if (fs.existsSync(logFile)) bot.sendDocument(chatId, logFile, { caption: `Logs` }).catch(e => {});
            else bot.sendMessage(chatId, "❌ No logs found.").catch(e => {});
        }
        
        else if (data.startsWith("del_")) {
            const projId = getData(data, "del_");
            const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
            try {
                await forceStopProject(projId); 
                await projectsCol.deleteOne({ _id: new ObjectId(projId) });
                
                const dir = path.join(__dirname, 'deployments', userId.toString(), proj.name);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
                
                // Update Cache
                PROJECT_CACHE[userId] = PROJECT_CACHE[userId].filter(p => p._id.toString() !== projId);

                await bot.deleteMessage(chatId, messageId).catch(e => {});
                bot.sendMessage(chatId, "✅ Project Deleted!");
            } catch (e) { bot.sendMessage(chatId, "❌ Delete Error").catch(e => {}); }
        }
        
        else if (data.startsWith("upd_")) {
            const projId = getData(data, "upd_");
            const proj = (PROJECT_CACHE[userId] || []).find(p => p._id.toString() === projId);
            
            USER_STATE[userId] = { step: "update_files", data: proj }; 
            const escapedName = escapeMarkdown(proj.name);
            const opts = { parse_mode: 'MarkdownV2', reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] } };
            await bot.sendMessage(chatId, `📝 *Update Mode: ${escapedName}*\n\n1️⃣ Send new files\\.\n2️⃣ To move: \`folder/file.js\`\n3️⃣ Click Done to restart\\.`, opts);
        }

        else if (data === "main_menu") {
            await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
        }
    } catch (err) { console.error("Callback Error:", err); }
});

bot.on('polling_error', (error) => console.log(`[Polling Error] ${error.code}: ${error.message}`));
