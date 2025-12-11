const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURATION =================
// یہ ویری ایبلز یہیں ڈیفائن ہیں، کسی اور فائل کی ضرورت نہیں
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; 
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; 
const OWNER_IDS = [8167904992, 7134046678, 6022286935]; 

// ================= SETUP =================
const bot = new TelegramBot(TOKEN, { polling: true });
const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const SESSION_WATCHERS = {}; 

// Temp Logs Directory (RAM/Ephemeral)
const LOG_DIR = path.join(__dirname, 'temp_logs');
if (fs.existsSync(LOG_DIR)) fs.rmSync(LOG_DIR, { recursive: true, force: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

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
    }
}
connectDB();

// ================= HELPER FUNCTIONS =================

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    const user = await usersCol.findOne({ user_id: userId });
    return !!user;
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

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json, skipping install.");
        }
        if(chatId) bot.sendMessage(chatId, `📦 **Installing Dependencies...**`);
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
                } catch (err) { console.error(`Session Save Error:`, err.message); }
            }
        }
    });
    SESSION_WATCHERS[watcherId] = watcher;
}

async function restoreSessionFromDB(userId, projName, basePath) {
    const project = await projectsCol.findOne({ user_id: userId, name: projName });
    if (project && project.session_data) {
        const sessionDir = path.join(basePath, 'session');
        if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
        
        for (const [safeKey, content] of Object.entries(project.session_data)) {
            const filename = safeKey.replace(/_DOT_/g, '.');
            fs.writeFileSync(path.join(sessionDir, filename), content.buffer);
        }
    }
}

// 🔥 FORCE STOP FUNCTION 🔥
async function forceStopProject(userId, projName) {
    const projectId = `${userId}_${projName}`;
    
    if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].process) {
        try { ACTIVE_SESSIONS[projectId].process.kill('SIGKILL'); } catch (e) {}
        if(ACTIVE_SESSIONS[projectId].logStream) ACTIVE_SESSIONS[projectId].logStream.end();
        delete ACTIVE_SESSIONS[projectId];
    }

    if (SESSION_WATCHERS[projectId]) {
        SESSION_WATCHERS[projectId].close();
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

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ **Initializing ${projName}...**`);

    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) { console.error(err); }
    }

    try { await restoreSessionFromDB(userId, projName, basePath); } catch (e) {}

    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Live Logging Active:**\nWait for pairing code...`);
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

    // 🔥 LOGGING SYSTEM 🔥
    child.stdout.on('data', (data) => {
        const rawOutput = data.toString();
        logStream.write(rawOutput);

        if (!ACTIVE_SESSIONS[projectId] || !ACTIVE_SESSIONS[projectId].logging || !chatId) return;

        const cleanOutput = rawOutput.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '');

        const codeMatch = cleanOutput.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
        if (codeMatch) {
            bot.sendMessage(chatId, `🔑 **YOUR PAIRING CODE:**\n\n\`${codeMatch[0]}\``, { parse_mode: "Markdown" });
            return;
        }

        if (cleanOutput.includes("Enter Number") || cleanOutput.includes("Pairing Code") || cleanOutput.includes("OTP")) {
            bot.sendMessage(chatId, `⌨️ **Input Required:**\n\`${cleanOutput.trim()}\``, { parse_mode: "Markdown" });
            return;
        }

        if (cleanOutput.includes("Opened connection") || 
            cleanOutput.includes("Bot Connected") || 
            cleanOutput.includes("Connected Successfully")) {
            
            bot.sendMessage(chatId, `✅ **Success! Bot is Online.**\n\n🔇 *Live Logging Disabled Automatically.*`);
            if (ACTIVE_SESSIONS[projectId]) ACTIVE_SESSIONS[projectId].logging = false;
            return;
        }

        if (!cleanOutput.includes("npm") && !cleanOutput.includes("update") && cleanOutput.trim() !== "") {
             if(cleanOutput.length < 300) bot.sendMessage(chatId, `🖥️ \`${cleanOutput.trim()}\``, { parse_mode: "Markdown" });
        }
    });

    child.stderr.on('data', (data) => {
        logStream.write(data);
        const error = data.toString();
        if (ACTIVE_SESSIONS[projectId] && ACTIVE_SESSIONS[projectId].logging && chatId && !error.includes("npm") && !error.includes("ExperimentalWarning")) {
             bot.sendMessage(chatId, `⚠️ **Error:**\n\`${error.slice(0, 200)}\``, { parse_mode: "Markdown" });
        }
    });

    child.on('close', (code) => {
        if(ACTIVE_SESSIONS[projectId]) {
            logStream.end();
            delete ACTIVE_SESSIONS[projectId];
        }
        if (SESSION_WATCHERS[projectId]) SESSION_WATCHERS[projectId].close();
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 **Bot Stopped** (Exit Code: ${code})`);
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
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
        const args = text.split(" ");
        if (await isAuthorized(userId)) {
            bot.sendMessage(chatId, "👋 **Node.js Master Bot**\nTerminal Manager Ready.", { reply_markup: getMainMenu(userId) });
        } else if (args[1]) {
            const key = await keysCol.findOne({ key: args[1], status: "active" });
            if (key) {
                await keysCol.updateOne({ _id: key._id }, { $set: { status: "used", used_by: userId } });
                await usersCol.insertOne({ user_id: userId, joined_at: new Date() });
                bot.sendMessage(chatId, "✅ **Access Granted!**", { reply_markup: getMainMenu(userId) });
            } else {
                bot.sendMessage(chatId, "❌ Invalid Key");
            }
        } else {
            bot.sendMessage(chatId, "🔒 Private Bot. Use Access Key.");
        }
    }

    if (USER_STATE[userId]) {
        if (USER_STATE[userId].step === "ask_name") {
            const projName = text.trim().replace(/\s+/g, '_');
            const exists = await projectsCol.findOne({ user_id: userId, name: projName });
            if (exists) return bot.sendMessage(chatId, "❌ Name taken. Try another.");

            USER_STATE[userId] = { step: "wait_files", name: projName };
            const opts = { reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Start Deploy" }]] } };
            bot.sendMessage(chatId, `✅ Name: **${projName}**\n\nSend files (index.js, package.json).\nPress Done when finished.`, opts);
        }
        else if (text === "✅ Done / Start Deploy" && USER_STATE[userId].step === "wait_files") {
            const projName = USER_STATE[userId].name;
            delete USER_STATE[userId];
            bot.sendMessage(chatId, "⚙️ Processing...", { reply_markup: { remove_keyboard: true } });
            startProject(userId, projName, chatId);
        }
    }
});

bot.on('document', async (msg) => {
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
            bot.sendMessage(msg.chat.id, `🔄 **Updated:** \`${fileName}\`\n\n🛑 Restarting Bot...`);
            await forceStopProject(userId, projName);
            startProject(userId, projName, msg.chat.id);
            delete USER_STATE[userId];
        } else {
            bot.sendMessage(msg.chat.id, `📥 Received: \`${fileName}\``);
        }
    }
});

// ================= CALLBACK HANDLING (DYNAMIC TOGGLES) =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Project Name (No spaces):");
    }
    else if (data === "manage_projects") {
        const projects = await projectsCol.find({ user_id: userId }).toArray();
        const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p.name}` }]);
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        bot.editMessageText("📂 **Your Projects**", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }
    
    // --- MANAGE MENU ---
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
        bot.editMessageText(`⚙️ Manage: **${projName}**\n\nStatus: ${isRunning ? 'Running 🟢' : 'Stopped 🔴'}`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }
    
    // --- TOGGLE RUN ---
    else if (data.startsWith("toggle_run_")) {
        const projName = getProjNameFromData(data, "toggle_run_");
        const projectId = `${userId}_${projName}`;
        
        if (ACTIVE_SESSIONS[projectId]) {
            await forceStopProject(userId, projName);
            bot.answerCallbackQuery(query.id, { text: "Stopped!" });
        } else {
            bot.deleteMessage(chatId, query.message.message_id); 
            startProject(userId, projName, chatId);
            bot.answerCallbackQuery(query.id, { text: "Starting..." });
            return; 
        }
        bot.emit('callback_query', { ...query, data: `menu_${projName}` });
    }

    // --- TOGGLE LOGS ---
    else if (data.startsWith("toggle_log_")) {
        const projName = getProjNameFromData(data, "toggle_log_");
        const projectId = `${userId}_${projName}`;
        
        if (ACTIVE_SESSIONS[projectId]) {
            ACTIVE_SESSIONS[projectId].logging = !ACTIVE_SESSIONS[projectId].logging;
            bot.answerCallbackQuery(query.id, { text: `Logs ${ACTIVE_SESSIONS[projectId].logging ? 'Enabled' : 'Disabled'}` });
        } else {
            bot.answerCallbackQuery(query.id, { text: "Bot is not running!" });
        }
        bot.emit('callback_query', { ...query, data: `menu_${projName}` });
    }

    // --- DOWNLOAD LOGS ---
    else if (data.startsWith("get_logs_")) {
        const projName = getProjNameFromData(data, "get_logs_");
        const projectId = `${userId}_${projName}`;
        const logFile = path.join(LOG_DIR, `${projectId}.txt`);

        if (fs.existsSync(logFile)) {
            bot.sendDocument(chatId, logFile, { caption: `📄 Logs for ${projName}` });
        } else {
            bot.answerCallbackQuery(query.id, { text: "No logs found (RAM Cleared or New Bot)", show_alert: true });
        }
    }
    
    else if (data.startsWith("del_")) {
        const projName = getProjNameFromData(data, "del_");
        try {
            await forceStopProject(userId, projName); 
            await projectsCol.deleteOne({ user_id: userId, name: projName });
            const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
            bot.answerCallbackQuery(query.id, { text: "Deleted!" });
            bot.deleteMessage(chatId, query.message.message_id);
        } catch (e) { bot.answerCallbackQuery(query.id, { text: "Error deleting" }); }
    }
    
    else if (data.startsWith("upd_")) {
        const projName = getProjNameFromData(data, "upd_");
        USER_STATE[userId] = { step: "update_files", name: projName };
        bot.editMessageText(`📝 **Update Mode: ${projName}**\n\nSend new files.\nBot will Auto-Restart after upload.`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "manage_projects" }]] } });
    }

    else if (data === "main_menu") {
        bot.editMessageText("🏠 Main Menu", { chat_id: chatId, message_id: query.message.message_id, reply_markup: getMainMenu(userId) });
    }
});

// Auto Restore
async function restoreProjects() {
    console.log("🔄 Restoring Projects...");
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
}