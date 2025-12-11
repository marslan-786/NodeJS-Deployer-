const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; 
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; 
const OWNER_IDS = [8167904992, 7134046678]; 

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

        if(chatId) bot.sendMessage(chatId, `📦 **Installing Dependencies...**\nPlease wait...`);

        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });

        // لاگز کو فلٹر کریں (ہر چیز نہ بھیجیں)
        install.on('error', (err) => {
            console.error(`❌ Install Error: ${err.message}`);
            reject(`System Error: ${err.message}`);
        });

        install.on('close', (code) => {
            if (code === 0) resolve("Success");
            else resolve("Warning: Install had issues, trying to run anyway..."); // Don't block execution
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
            console.error(`Install Failed for ${projName}: ${err}`);
        }
    }

    // Start Process
    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Interactive Mode Active:**\nReply with Number/OTP when asked.`);
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, shell: true });

    child.on('error', (err) => {
        console.error(`❌ Failed to spawn:`, err);
        if (chatId) bot.sendMessage(chatId, `❌ **System Error:** Failed to start process.\n${err.message}`);
    });

    ACTIVE_PROCESSES[projectId] = child;
    if (chatId) INTERACTIVE_SESSIONS[chatId] = projectId;

    await projectsCol.updateOne(
        { user_id: userId, name: projName },
        { $set: { status: "Running", path: basePath } }
    );

    // 🔥 SMART LOGGING SYSTEM 🔥
    child.stdout.on('data', (data) => {
        const output = data.toString();
        
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId) {
            
            // 1. PAIRING CODE DETECTOR (Regular Expression)
            // یہ پیٹرن ABCD-1234 جیسے کوڈز کو ڈھونڈتا ہے
            const codeMatch = output.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
            
            if (codeMatch) {
                bot.sendMessage(chatId, `🔑 **YOUR PAIRING CODE:**\n\n\`${codeMatch[0]}\``, { parse_mode: "Markdown" });
                return; // کوڈ مل گیا تو باقی لاگ نہ بھیجیں
            }

            // 2. IMPORTANT INPUT PROMPTS
            if (output.includes("Enter Number") || output.includes("Pairing Code") || output.includes("OTP")) {
                bot.sendMessage(chatId, `⌨️ **Input Required:**\n\`${output.trim()}\``, { parse_mode: "Markdown" });
                return;
            }

            // 3. IGNORE JUNK (NPM Logs, etc)
            // اگر آؤٹ پٹ میں یہ الفاظ ہیں تو اگنور کرو
            if (output.includes("npm") || output.includes("WARN") || output.includes("audit") || output.trim() === "") {
                return; 
            }

            // 4. باقی سب کچھ (لیکن چھوٹا کر کے)
            // اگر بہت ضروری ہو تو بھیجیں، ورنہ یوزر تنگ نہ ہو
            // فی الحال ہم صرف Error یا Connect میسج بھیجیں گے
            if (output.includes("Connected") || output.toLowerCase().includes("error")) {
                bot.sendMessage(chatId, `🖥️ **Log:** \`${output.trim()}\``, { parse_mode: "Markdown" });
            }
        }
    });

    child.stderr.on('data', (data) => {
        const error = data.toString();
        // Sirf Critical Errors bhejein
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId && !error.includes("npm") && !error.includes("DeprecationWarning")) {
             bot.sendMessage(chatId, `⚠️ **Error:**\n\`${error.slice(0, 200)}\``, { parse_mode: "Markdown" });
        }
    });

    child.on('close', (code) => {
        delete ACTIVE_PROCESSES[projectId];
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId) delete INTERACTIVE_SESSIONS[chatId];
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) {
            bot.sendMessage(chatId, `🛑 **Bot Stopped** (Exit Code: ${code})`);
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
        // Check if process is alive
        if (child && !child.killed) {
            try {
                child.stdin.write(text + "\n"); // Send input to terminal
            } catch (err) {
                bot.sendMessage(chatId, "⚠️ Failed to send input. Bot might be stopped.");
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
    
    // 🔥 ROBUST DELETE LOGIC 🔥
    else if (data.startsWith("del_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        
        try {
            // 1. Try to kill process (Ignore error if not running)
            if (ACTIVE_PROCESSES[projId]) {
                try { ACTIVE_PROCESSES[projId].kill(); } catch (e) {}
                delete ACTIVE_PROCESSES[projId];
            }
            
            // 2. Delete from DB (Force)
            await projectsCol.deleteOne({ user_id: userId, name: projName });
            
            // 3. Delete Files (Force)
            const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
            if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

            bot.answerCallbackQuery(query.id, { text: "Deleted Successfully!" });
            bot.deleteMessage(chatId, query.message.message_id);
        } catch (err) {
            console.error(err);
            bot.answerCallbackQuery(query.id, { text: "Error deleting (Check Logs)" });
        }
    }
    
    else if (data.startsWith("stop_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        
        if (ACTIVE_PROCESSES[projId]) {
            try { ACTIVE_PROCESSES[projId].kill(); } catch(e) {}
            delete ACTIVE_PROCESSES[projId];
            await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
            bot.answerCallbackQuery(query.id, { text: "Stopped" });
            // Refresh Menu Status
            const keyboard = [
                [{ text: "🛑 Stop", callback_data: `stop_${projName}` }, { text: "▶️ Start", callback_data: `start_${projName}` }],
                [{ text: "📝 Update Files", callback_data: `upd_${projName}` }, { text: "🗑️ Delete", callback_data: `del_${projName}` }],
                [{ text: "🔙 Back", callback_data: "manage_projects" }]
            ];
            bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: query.message.message_id });
        } else {
            bot.answerCallbackQuery(query.id, { text: "Already Stopped (or Zombie Process)" });
            // Even if it says already stopped, update DB just in case
            await projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        }
    }

    else if (data.startsWith("start_")) {
        const projName = data.split("_")[1];
        bot.deleteMessage(chatId, query.message.message_id); 
        startProject(userId, projName, chatId);
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
