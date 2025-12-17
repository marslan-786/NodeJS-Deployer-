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

// 🔥 Connection Options (Keep Alive removed to fix MongoParseError)
const client = new MongoClient(MONGO_URL, {
    connectTimeoutMS: 30000,
    socketTimeoutMS: 45000
});

let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const FILE_WATCHERS = {}; 
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
        
        startDBKeepAlive();
        setTimeout(restoreProjects, 3000); 
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

// 🔥 FIX: ROBUST SAVE FUNCTION (Handles IDs correctly)
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
        // Convert to String first to avoid "ObjectId(ObjectId)" crash
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
        console.error(`DB Save Error:`, e.message); 
        return false;
    }
}

async function moveFile(userId, projData, basePath, fileName, targetFolder, chatId) {
    const oldPath = path.join(basePath, fileName);
    const newDir = path.join(basePath, targetFolder);
    const newPath = path.join(newDir, fileName);

    try {
        if (!fs.existsSync(oldPath)) {
             await bot.sendMessage(chatId, `⚠️ File not found: \`${fileName}\`\nUpload it first!`, { parse_mode: 'Markdown' });
             return;
        }
        if (!fs.existsSync(newDir)) await fs.promises.mkdir(newDir, { recursive: true });
        
        await fs.promises.rename(oldPath, newPath);
        const fileContent = await fs.promises.readFile(newPath); 
        const relativePath = path.join(targetFolder, fileName).replace(/\\/g, '/'); 
        
        // Pass ID correctly
        await saveFileToStorage(userId, projData._id, relativePath, fileContent);
        
        // Remove old file
        await projectsCol.updateOne(
            { _id: new ObjectId(String(projData._id)) }, 
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

function startFullSyncWatcher(userId, projId, basePath) {
    const watcherId = projId.toString();
    if (FILE_WATCHERS[watcherId]) try { FILE_WATCHERS[watcherId].close(); } catch(e){}

    try {
        const watcher = fs.watch(basePath, { recursive: true }, async (eventType, filename) => {
            if (filename) {
                if (filename.includes('node_modules') || filename.includes('.git') || filename.includes('package-lock.json')) return;
                const fullPath = path.join(basePath, filename);
                if (fs.existsSync(fullPath)) {
                    try {
                        const stats = fs.statSync(fullPath);
                        if (stats.isFile()) {
                            const content = fs.readFileSync(fullPath);
                            const relativePath = filename.replace(/\\/g, '/');
                            await projectsCol.updateOne(
                                { _id: new ObjectId(String(projId)) },
                                { $pull: { files: { name: relativePath } } }
                            );
                            await projectsCol.updateOne(
                                { _id: new ObjectId(String(projId)) },
                                { $push: { files: { name: relativePath, content: content } } }
                            );
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
    if (ACTIVE_SESSIONS[pid] && ACTIVE_SESSIONS[pid].process) {
        try { ACTIVE_SESSIONS[pid].process.kill('SIGKILL'); } catch (e) {}
        if(ACTIVE_SESSIONS[pid].logStream) ACTIVE_SESSIONS[pid].logStream.end();
        delete ACTIVE_SESSIONS[pid];
    }
    if (FILE_WATCHERS[pid]) {
        try { FILE_WATCHERS[pid].close(); } catch(e){}
        delete FILE_WATCHERS[pid];
    }
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
}

async function renewSession(userId, projId, chatId, basePath) {
    try {
        await forceStopProject(projId);
        const safeId = new ObjectId(String(projId));
        
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: { $regex: /^session\// } } } });
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: { $regex: /^auth_info_baileys\// } } } });

        const sessionPath = path.join(basePath, 'session');
        const authPath = path.join(basePath, 'auth_info_baileys');
        if (fs.existsSync(sessionPath)) fs.rmSync(sessionPath, { recursive: true, force: true });
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true });

        if(chatId) bot.sendMessage(chatId, `🔄 *Session Renewed/Cleared.*\nStarting fresh...`, { parse_mode: 'Markdown' }).catch(e => {});
        setTimeout(() => startProject(userId, projId, chatId), 2000);
    } catch (e) {}
}

// ================= 🔥 MAIN START PROJECT 🔥 =================

async function startProject(userId, projId, chatId, silent = false) {
    const projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
    if (!projectData) return;

    const projName = projectData.name;
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const pid = projId.toString();

    await forceStopProject(projId);
    const safeName = escapeMarkdown(projName);

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ *Initializing ${safeName}\\.\\.\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});

    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });

    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.content.buffer);
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
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running", path: basePath } });

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 *${safeName} Started\\.*\nWaiting for Output\\.\\.\\.`, { parse_mode: 'MarkdownV2' }).catch(e => {});
    }

    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);

        if (!chatId) return;

        const cleanOutput = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');
        const lowerOut = cleanOutput.toLowerCase();

        const codeMatch = cleanOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/) || cleanOutput.match(/Pairing Code:\s*([A-Z0-9-]{8,})/i);
        if (codeMatch) {
            let code = codeMatch[1] || codeMatch[0];
            bot.sendMessage(chatId, `🔑 *YOUR PAIRING CODE:*\n\n\`${code}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            return;
        }

        if ((lowerOut.includes("enter") || lowerOut.includes("input") || lowerOut.includes("provide") || lowerOut.includes("number?")) && cleanOutput.includes(":")) {
             bot.sendMessage(chatId, `⌨️ *Input Requested:*\n\`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
             return;
        }

        const successKeywords = [
            "connection open", "bot connected", "authenticated", "bot is live", "open: true", "success: true", "connected to whatsapp", "polling", "webhook", "bot started", "launched", "listening on port"
        ];

        if (successKeywords.some(k => lowerOut.includes(k)) && !lowerOut.includes("pairing")) {
            bot.sendMessage(chatId, `✅ *Status Update:*\n\`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
            if (ACTIVE_SESSIONS[pid].logging) {
                ACTIVE_SESSIONS[pid].logging = false;
                bot.sendMessage(chatId, `🔇 *Auto-Mute Active:* Bot is Live! Logs disabled.`).catch(()=>{});
            }
            return;
        }

        if (ACTIVE_SESSIONS[pid].logging) {
             if(cleanOutput.trim().length > 0 && cleanOutput.length < 800) {
                 bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(cleanOutput.trim())}\``, { parse_mode: "MarkdownV2" }).catch(e => {});
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
        if(ACTIVE_SESSIONS[pid]) {
            try { logStream.end(); } catch(e){}
            delete ACTIVE_SESSIONS[pid];
        }
        if (FILE_WATCHERS[pid]) try { FILE_WATCHERS[pid].close(); } catch(e){}
        projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
        if (chatId && !silent && ACTIVE_SESSIONS[pid]?.logging) { 
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
            // 🔥 FIX: DONE BUTTON LOGIC (Handles ID properly)
            if (text === "✅ Done / Apply Actions") {
                if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                    const projData = USER_STATE[userId].data;
                    const isUpdate = USER_STATE[userId].step === "update_files";
                    
                    delete USER_STATE[userId]; 
                    
                    const statusMsg = await bot.sendMessage(chatId, "⚙️ *Processing Actions\\.\\.\\.*", { reply_markup: { remove_keyboard: true }, parse_mode: 'MarkdownV2' });
                    
                    // Stop first if updating, to release file locks
                    if (isUpdate) await forceStopProject(projData._id);
                    
                    setTimeout(() => {
                        // Restart using the correct ID
                        startProject(userId, projData._id, chatId);
                        bot.deleteMessage(chatId, statusMsg.message_id).catch(e=>{});
                    }, 1500);
                    return;
                }
            }

            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim(); 
                if (projName.length > 50) return bot.sendMessage(chatId, "❌ Name too long.");

                const exists = await projectsCol.findOne({ user_id: userId, name: projName });
                if (exists) return bot.sendMessage(chatId, "❌ Name taken.").catch(e => {});
                
                const res = await projectsCol.insertOne({
                    user_id: userId,
                    name: projName,
                    files: [],
                    status: "Stopped"
                });
                
                USER_STATE[userId] = { step: "wait_files", data: { _id: res.insertedId, name: projName } };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }, parse_mode: 'MarkdownV2' };
                bot.sendMessage(chatId, `✅ Created: *${escapeMarkdown(projName)}*\n\n1️⃣ Send files now\\.\n2️⃣ To move: \`folder/file.js\`\n3️⃣ Click Done when finished\\.`, opts).catch(e => {});
            }

            else if (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files") {
                if (!text) return;
                const projData = USER_STATE[userId].data;
                const basePath = path.join(__dirname, 'deployments', userId.toString(), projData.name);
                if (text.includes('/')) {
                    const parts = text.split('/');
                    const fileName = parts.pop();
                    const folderPath = parts.join('/');
                    await moveFile(userId, projData, basePath, fileName, folderPath, chatId);
                } 
                else if (text.includes(' ')) {
                    const args = text.split(/\s+/);
                    const folderName = args[0];
                    const filesToMove = args.slice(1);
                    for (const f of filesToMove) await moveFile(userId, projData, basePath, f, folderName, chatId);
                }
            }
        } 
        
        else {
             let targetPid = null;
             for (const [pid, session] of Object.entries(ACTIVE_SESSIONS)) {
                 if (session.chatId === chatId) { targetPid = pid; break; }
             }
             if (targetPid && text && !text.startsWith("/")) {
                 const session = ACTIVE_SESSIONS[targetPid];
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

// 🔥 FIX: ROBUST FILE HANDLER (Catches errors & gives feedback)
bot.on('document', async (msg) => {
    try {
        const userId = msg.from.id;
        if (USER_STATE[userId] && (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files")) {
            const projData = USER_STATE[userId].data;
            const fileName = msg.document.file_name;
            const dir = path.join(__dirname, 'deployments', userId.toString(), projData.name);
            
            // 1. Feedback: Uploading
            const loadingMsg = await bot.sendMessage(msg.chat.id, `📥 *Uploading:* \`${escapeMarkdown(fileName)}\``, { parse_mode: 'MarkdownV2' });

            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const filePath = path.join(dir, fileName);
            const fileLink = await bot.getFileLink(msg.document.file_id);
            const response = await fetch(fileLink);
            const buffer = await response.arrayBuffer();
            
            // Save to Disk
            fs.writeFileSync(filePath, Buffer.from(buffer));
            
            // Save to DB (Uses Safe String ID)
            const saved = await saveFileToStorage(userId, projData._id, fileName, Buffer.from(buffer));

            // 2. Feedback: Success or Fail
            if (saved) {
                bot.editMessageText(`✅ *Saved:* \`${escapeMarkdown(fileName)}\``, { chat_id: msg.chat.id, message_id: loadingMsg.message_id, parse_mode: 'MarkdownV2' }).catch(e=>{});
            } else {
                bot.sendMessage(msg.chat.id, `❌ Failed to save to DB: ${fileName}`);
            }
        }
    } catch (err) {
        console.error("Document Upload Error:", err);
        bot.sendMessage(msg.chat.id, `❌ Upload Error: ${err.message}`);
    }
});

// ================= CALLBACK HANDLING =================

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
            const keyStr = getData(data, "view_key_");
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
            const keyStr = getData(data, "tog_key_");
            const keyDoc = await keysCol.findOne({ key: keyStr });
            if (keyDoc) {
                const newStatus = keyDoc.status === 'active' ? 'inactive' : 'active';
                await keysCol.updateOne({ key: keyStr }, { $set: { status: newStatus } });
                bot.emit('callback_query', { ...query, data: `view_key_${keyStr}` });
            }
        }

        else if (data.startsWith("del_key_")) {
            const keyStr = getData(data, "del_key_");
            await keysCol.deleteOne({ key: keyStr });
            bot.emit('callback_query', { ...query, data: "list_keys" });
        }
        
        else if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            bot.sendMessage(chatId, "📂 Enter Project Name (Spaces allowed):").catch(e => {});
        }
        
        else if (data === "manage_projects") {
            try {
                const projects = await projectsCol.find({ user_id: userId }).toArray();
                const keyboard = projects.map(p => [{ 
                    text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, 
                    callback_data: `menu_${p._id.toString()}` 
                }]);
                
                keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
                await safeEditMessage(chatId, messageId, "📂 *Your Projects*", keyboard);
            } catch (dbErr) {
                 connectDB(); 
            }
        }
        
        else if (data.startsWith("menu_")) {
            const projId = getData(data, "menu_");
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            if (!proj) return bot.sendMessage(chatId, "❌ Project not found");

            const isRunning = ACTIVE_SESSIONS[projId] ? true : false;
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
                bot.sendMessage(chatId, `🛑 *Stopped\\.*`, { parse_mode: 'MarkdownV2' }).catch(e => {});
            } else {
                try { await bot.deleteMessage(chatId, messageId); } catch(e){}
                startProject(userId, projId, chatId);
                return; 
            }
            bot.emit('callback_query', { ...query, data: `menu_${projId}` });
        }

        else if (data.startsWith("renew_")) {
            const projId = getData(data, "renew_");
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            const basePath = path.join(__dirname, 'deployments', userId.toString(), proj.name);
            await renewSession(userId, projId, chatId, basePath);
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
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            try {
                await forceStopProject(projId); 
                await projectsCol.deleteOne({ _id: new ObjectId(projId) });
                const dir = path.join(__dirname, 'deployments', userId.toString(), proj.name);
                if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
                await bot.deleteMessage(chatId, messageId).catch(e => {});
                bot.sendMessage(chatId, "✅ Project Deleted!").catch(e => {});
            } catch (e) { bot.sendMessage(chatId, "❌ Delete Error").catch(e => {}); }
        }
        
        else if (data.startsWith("upd_")) {
            const projId = getData(data, "upd_");
            const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
            USER_STATE[userId] = { step: "update_files", data: proj }; 
            const escapedName = escapeMarkdown(proj.name);
            const opts = { parse_mode: 'MarkdownV2', reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] } };
            await bot.sendMessage(chatId, `📝 *Update Mode: ${escapedName}*\n\n1️⃣ Send new files\\.\n2️⃣ To move: \`folder/file.js\`\n3️⃣ Click Done to restart\\.`, opts);
        }

        else if (data === "main_menu") {
            await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
        }
    } catch (err) { }
});

async function restoreProjects() {
    console.log("🔄 Restoring Projects from MongoDB...");
    try {
        const allProjects = await projectsCol.find({}).toArray();
        for (const proj of allProjects) {
            if (proj.status === "Running" || true) {
                const dir = path.join(__dirname, 'deployments', proj.user_id.toString(), proj.name);
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
                    startProject(proj.user_id, proj._id, null, true);
                }
            }
        }
    } catch (e) { console.error("Restore Error:", e); }
}

bot.on('polling_error', (error) => console.log(`[Polling Error] ${error.code}: ${error.message}`));
