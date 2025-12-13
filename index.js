const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; 
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; 
const OWNER_IDS = [8167904992, 7134046678, 6022286935]; 

// ================= SETUP =================
// Fix 1: Polling options added to auto-fix network lags
const bot = new TelegramBot(TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const SESSION_WATCHERS = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

// Cleanup Logs
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

// Helper for Inputs
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Connect DB
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
        process.exit(1); // Exit if DB fails so container restarts
    }
}
connectDB();

// ================= HELPER FUNCTIONS =================

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
    return data.substring(prefix.length);
}

// 🔥 SAFE MESSAGE EDITING (FIXED TO PREVENT CRASHES) 🔥
async function safeEditMessage(chatId, messageId, text, keyboard) {
    try {
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard },
            parse_mode: 'Markdown'
        });
    } catch (error) {
        const errMsg = error.message;
        // Ignore "message not modified" or "message to edit not found" errors
        if (errMsg.includes('message is not modified') || errMsg.includes('message to edit not found')) {
            return; 
        }
        
        // If edit fails completely, send a new message
        try {
            await bot.sendMessage(chatId, text, {
                reply_markup: { inline_keyboard: keyboard },
                parse_mode: 'Markdown'
            });
        } catch (e) { console.error("Send Failed:", e.message); }
    }
}

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json, skipping install.");
        }
        if(chatId) bot.sendMessage(chatId, `📦 **Installing Dependencies...**`).catch(e => {});
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
    } catch (err) {
        console.error("Watcher Error:", err.message);
    }
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
    await projectsCol.updateOne(
        { user_id: userId, name: projName }, 
        { $set: { status: "Stopped" } }
    );
}

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    await forceStopProject(userId, projName);

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ **Initializing ${projName}...**`).catch(e => {});

    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) { console.error(err); }
    }

    try { await restoreSessionFromDB(userId, projName, basePath); } catch (e) {}

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Live Logging Active:**\nWait for pairing code...`).catch(e => {});
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

    await projectsCol.updateOne(
        { user_id: userId, name: projName },
        { $set: { status: "Running", path: basePath } }
    );

    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);

        if (!ACTIVE_SESSIONS[projectId] || !ACTIVE_SESSIONS[projectId].logging || !chatId) return;

        const cleanOutput = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const codeMatch = cleanOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) {
            bot.sendMessage(chatId, `🔑 **YOUR PAIRING CODE:**\n\n\`${codeMatch[0]}\``, { parse_mode: "Markdown" }).catch(e => {});
            return;
        }

        if (cleanOutput.includes("Enter Number") || cleanOutput.includes("Pairing Code") || cleanOutput.includes("OTP")) {
            bot.sendMessage(chatId, `⌨️ **Input Required:**\n\`${cleanOutput.trim()}\``, { parse_mode: "Markdown" }).catch(e => {});
            return;
        }

        if (cleanOutput.includes("Opened connection") || 
            cleanOutput.includes("Bot Connected") || 
            cleanOutput.includes("Connected Successfully")) {
            
            bot.sendMessage(chatId, `✅ **Success! Bot is Online.**\n\n🔇 *Live Logging Disabled.*`).catch(e => {});
            if (ACTIVE_SESSIONS[projectId]) ACTIVE_SESSIONS[projectId].logging = false;
            return;
        }

        if (!cleanOutput.includes("npm") && !cleanOutput.includes("update") && cleanOutput.trim() !== "") {
             if(cleanOutput.length < 300) bot.sendMessage(chatId, `🖥️ \`${cleanOutput.trim()}\``, { parse_mode: "Markdown" }).catch(e => {});
        }
    });

    child.stderr.on('data', (data) => {
        logStream.write(data);
        const error = data.toString();
        if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging && chatId && !error.includes("npm")) {
             bot.sendMessage(chatId, `⚠️ **Error:**\n\`${error.slice(0, 200)}\``, { parse_mode: "Markdown" }).catch(e => {});
        }
    });

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[projectId]) {
            try { logStream.end(); } catch(e){}
            delete ACTIVE_SESSIONS[projectId];
        }
        if (SESSION_WATCHERS[projectId]) {
            try { SESSION_WATCHERS[projectId].close(); } catch(e){}
        }
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 **Bot Stopped** (Exit Code: ${code})`).catch(e => {});
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    try {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const text = msg.text;

        // Interactive Input
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
            const args = text.split(" ");
            if (await isAuthorized(userId)) {
                bot.sendMessage(chatId, "👋 **Node.js Master Bot**", { reply_markup: getMainMenu(userId) }).catch(e => {});
            } else if (args[1]) {
                const key = await keysCol.findOne({ key: args[1], status: "active" });
                if (key) {
                    await keysCol.updateOne({ _id: key._id }, { $set: { status: "used", used_by: userId } });
                    await usersCol.insertOne({ user_id: userId, joined_at: new Date() });
                    bot.sendMessage(chatId, "✅ **Access Granted!**", { reply_markup: getMainMenu(userId) }).catch(e => {});
                } else {
                    bot.sendMessage(chatId, "❌ Invalid Key").catch(e => {});
                }
            } else {
                bot.sendMessage(chatId, "🔒 Private Bot. Use Access Key.").catch(e => {});
            }
        }

        if (USER_STATE[userId]) {
            if (USER_STATE[userId].step === "ask_name") {
                const projName = text.trim().replace(/\s+/g, '_');
                const exists = await projectsCol.findOne({ user_id: userId, name: projName });
                if (exists) return bot.sendMessage(chatId, "❌ Name taken.").catch(e => {});

                USER_STATE[userId] = { step: "wait_files", name: projName };
                const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Start Deploy" }]] } };
                bot.sendMessage(chatId, `✅ Name: **${projName}**\n\nSend files.`, opts).catch(e => {});
            }
            else if (text === "✅ Done / Start Deploy" && USER_STATE[userId].step === "wait_files") {
                const projName = USER_STATE[userId].name;
                delete USER_STATE[userId];
                bot.sendMessage(chatId, "⚙️ Processing...", { reply_markup: { remove_keyboard: true } }).catch(e => {});
                startProject(userId, projName, chatId);
            }
        }
    } catch (err) { console.error("Message Handler Error:", err); }
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

            if (USER_STATE[userId].step === "update_files") {
                bot.sendMessage(msg.chat.id, `🔄 **Updated:** \`${fileName}\`\n\n🛑 Restarting Bot...`).catch(e => {});
                await forceStopProject(userId, projName);
                startProject(userId, projName, msg.chat.id);
                delete USER_STATE[userId];
            } else {
                bot.sendMessage(msg.chat.id, `📥 Received: \`${fileName}\``).catch(e => {});
            }
        }
    } catch (err) { console.error("Doc Handler Error:", err); }
});

// ================= CALLBACK HANDLING =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const messageId = query.message.message_id;

    try {
        // Fix 3: Wrap answerCallbackQuery to prevent crash on timeout
        await bot.answerCallbackQuery(query.id).catch(err => console.log("Callback Answer Error:", err.message));

        if (data === "deploy_new") {
            USER_STATE[userId] = { step: "ask_name" };
            bot.sendMessage(chatId, "📂 Enter Project Name (No spaces):").catch(e => {});
        }
        else if (data === "manage_projects") {
            const projects = await projectsCol.find({ user_id: userId }).toArray();
            const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p.name}` }]);
            keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
            await safeEditMessage(chatId, messageId, "📂 **Your Projects**", keyboard);
        }
        
        else if (data.startsWith("menu_")) {
            const projName = getProjNameFromData(data, "menu_");
            const projectId = `${userId}_${projName}`;
            
            const isRunning = ACTIVE_SESSIONS[projectId] ? true : false;
            const isLogging = (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging) ? true : false;

            const runBtnText = isRunning ? "🛑 Stop" : "▶️ Start";
            const runCallback = `toggle_run_${projName}`; 

            const logBtnText = isLogging ? "🔴 Disable Logs" : "🟢 Enable Logs";
            const logCallback = `toggle_log_${projName}`; 

            const keyboard = [
                [{ text: runBtnText, callback_data: runCallback }, { text: logBtnText, callback_data: logCallback }],
                [{ text: "📝 Update Files", callback_data: `upd_${projName}` }, { text: "📥 Download Logs", callback_data: `get_logs_${projName}` }],
                [{ text: "🗑️ Delete", callback_data: `del_${projName}` }],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            await safeEditMessage(chatId, messageId, `⚙️ Manage: **${projName}**\n\nStatus: ${isRunning ? 'Running 🟢' : 'Stopped 🔴'}`, keyboard);
        }
        
        else if (data.startsWith("toggle_run_")) {
            const projName = getProjNameFromData(data, "toggle_run_");
            const projectId = `${userId}_${projName}`;
            
            if (ACTIVE_SESSIONS[projectId]) {
                await forceStopProject(userId, projName);
                bot.sendMessage(chatId, `🛑 **${projName} Stopped.**`).catch(e => {});
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
            
            if (ACTIVE_SESSIONS[projectId]) {
                ACTIVE_SESSIONS[projectId].logging = !ACTIVE_SESSIONS[projectId].logging;
            } else {
                bot.sendMessage(chatId, "⚠️ Bot is not running!").catch(e => {});
            }
            bot.emit('callback_query', { ...query, data: `menu_${projName}` });
        }

        else if (data.startsWith("get_logs_")) {
            const projName = getProjNameFromData(data, "get_logs_");
            const projectId = `${userId}_${projName}`;
            const logFile = path.join(LOG_DIR, `${projectId}.txt`);

            if (fs.existsSync(logFile)) {
                bot.sendDocument(chatId, logFile, { caption: `📄 Logs for ${projName}` }).catch(e => {});
            } else {
                bot.sendMessage(chatId, "❌ No logs found.").catch(e => {});
            }
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
            await safeEditMessage(chatId, messageId, `📝 **Update Mode: ${projName}**\n\nSend new files.`, [[{ text: "🔙 Cancel", callback_data: "manage_projects" }]]);
        }

        else if (data === "main_menu") {
            await safeEditMessage(chatId, messageId, "🏠 Main Menu", getMainMenu(userId).inline_keyboard);
        }
    } catch (err) {
        console.error("Callback Error:", err.message);
    }
});

// Auto Restore
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

// Fix 4: Fix 'Polling' and 'Unhandled Rejection' Errors
bot.on('polling_error', (error) => {
    console.log(`[Polling Error] ${error.code}: ${error.message}`);
});

process.on('uncaughtException', (err) => {
    console.error('[Uncaught Exception]:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[Unhandled Rejection] at:', promise, 'reason:', reason);
});
