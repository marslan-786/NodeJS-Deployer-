const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; // اپنا بوٹ ٹوکن یہاں لکھیں
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; // MongoDB URL
const OWNER_IDS = [8167904992, 7134046678]; // Owner IDs

// ================= SETUP =================
const bot = new TelegramBot(TOKEN, { polling: true });
const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_PROCESSES = {}; 
const USER_STATE = {}; 
const INTERACTIVE_SESSIONS = {}; 

// Connect DB
async function connectDB() {
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        console.log("✅ Connected to MongoDB");
        // تھوڑا انتظار کریں تاکہ سسٹم سیٹ ہو جائے
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

// ================= PROCESS MANAGEMENT =================

function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json, skipping install.");
        }

        if(chatId) bot.sendMessage(chatId, `📦 **Installing Dependencies...**\nRunning npm install...`);

        // 🔥 IMPORTANT FIX: Shell handling & Error Listeners
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });

        let errorLog = "";
        install.stderr.on('data', (data) => { errorLog += data.toString(); });

        // ماسٹر بوٹ کریش سے بچانے کے لیے
        install.on('error', (err) => {
            console.error(`❌ Spawn Error in Install: ${err.message}`);
            reject(`System Error: ${err.message}`);
        });

        install.on('close', (code) => {
            if (code === 0) {
                resolve("Success");
            } else {
                reject(`NPM Install Failed (Code ${code})\n${errorLog.slice(0, 300)}...`);
            }
        });
    });
}

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    if (ACTIVE_PROCESSES[projectId]) {
        if (!silent && chatId) bot.sendMessage(chatId, "⚠️ Bot is already running.");
        return;
    }

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ **Initializing ${projName}...**`);

    // Install Dependencies Logic
    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId); 
            }
        } catch (err) {
            if (chatId) bot.sendMessage(chatId, `❌ **Installation Error:**\n\`${err}\``, { parse_mode: "Markdown" });
            console.error(`Install Failed for ${projName}: ${err}`);
            return; 
        }
    }

    // Start Process
    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Interactive Mode Active:**\nReply here to send input.`);
    }

    // 🔥 CRITICAL FIX: Add 'error' listener to prevent crash on spawn fail
    const child = spawn('node', ['index.js'], { cwd: basePath, shell: true });

    child.on('error', (err) => {
        console.error(`❌ Failed to spawn process for ${projName}:`, err);
        if (chatId) bot.sendMessage(chatId, `❌ **System Error:** Failed to start process.\n${err.message}`);
    });

    ACTIVE_PROCESSES[projectId] = child;
    if (chatId) INTERACTIVE_SESSIONS[chatId] = projectId;

    await projectsCol.updateOne(
        { user_id: userId, name: projName },
        { $set: { status: "Running", path: basePath } }
    );

    child.stdout.on('data', (data) => {
        const output = data.toString();
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId && output.trim().length > 0) {
            bot.sendMessage(chatId, `🖥️ **Terminal:**\n\`${output}\``, { parse_mode: "Markdown" });
        }
    });

    child.stderr.on('data', (data) => {
        const error = data.toString();
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId && error.trim().length > 0) {
            bot.sendMessage(chatId, `⚠️ **Log:**\n\`${error}\``, { parse_mode: "Markdown" });
        }
    });

    child.on('close', (code) => {
        delete ACTIVE_PROCESSES[projectId];
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId) delete INTERACTIVE_SESSIONS[chatId];
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) {
            bot.sendMessage(chatId, `🛑 **Process Ended** (Code: ${code})`);
        }
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // A. Interactive Input
    if (INTERACTIVE_SESSIONS[chatId] && text && !text.startsWith("/")) {
        const projectId = INTERACTIVE_SESSIONS[chatId];
        const child = ACTIVE_PROCESSES[projectId];
        if (child && child.stdin && !child.killed) {
            try {
                child.stdin.write(text + "\n");
            } catch (err) {
                bot.sendMessage(chatId, "⚠️ Failed to send input. Process might be dead.");
            }
            return;
        }
    }

    if (!text) return;

    // B. Start Command
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

    // C. Deploy Logic
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

// File Uploads
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
            bot.sendMessage(msg.chat.id, `🔄 **Updated:** \`${fileName}\`\nRestart bot to apply changes.`);
        } else {
            bot.sendMessage(msg.chat.id, `📥 Received: \`${fileName}\``);
        }
    }
});

// Callbacks
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
    else if (data.startsWith("menu_")) {
        const projName = data.split("_")[1];
        const keyboard = [
            [{ text: "🛑 Stop", callback_data: `stop_${projName}` }, { text: "▶️ Start", callback_data: `start_${projName}` }],
            [{ text: "📝 Update Files", callback_data: `upd_${projName}` }, { text: "🗑️ Delete", callback_data: `del_${projName}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        bot.editMessageText(`⚙️ Manage: **${projName}**`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }
    else if (data.startsWith("stop_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        if (ACTIVE_PROCESSES[projId]) {
            ACTIVE_PROCESSES[projId].kill();
            bot.answerCallbackQuery(query.id, { text: "Stopped" });
        } else {
            bot.answerCallbackQuery(query.id, { text: "Already Stopped" });
        }
    }
    else if (data.startsWith("start_")) {
        const projName = data.split("_")[1];
        bot.deleteMessage(chatId, query.message.message_id); 
        startProject(userId, projName, chatId);
    }
    else if (data.startsWith("del_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        if (ACTIVE_PROCESSES[projId]) ACTIVE_PROCESSES[projId].kill();
        await projectsCol.deleteOne({ user_id: userId, name: projName });
        const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        bot.answerCallbackQuery(query.id, { text: "Project Deleted!" });
        bot.deleteMessage(chatId, query.message.message_id);
    }
    else if (data.startsWith("upd_")) {
        const projName = data.split("_")[1];
        USER_STATE[userId] = { step: "update_files", name: projName };
        bot.editMessageText(`📝 **Update Mode: ${projName}**\n\nSend new files.`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "manage_projects" }]] } });
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
            if (proj.files) {
                for (const file of proj.files) fs.writeFileSync(path.join(dir, file.name), file.content.buffer);
            }
            startProject(proj.user_id, proj.name, null, true);
        }
    }
}
