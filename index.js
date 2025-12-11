const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; // اپنا بوٹ ٹوکن یہاں لکھیں
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; // ریلوے والا MongoDB URL
const OWNER_IDS = [8167904992, 7134046678]; // اپنی آئی ڈیز یہاں لکھیں

// ================= SETUP =================
const bot = new TelegramBot(TOKEN, { polling: true });
const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_PROCESSES = {}; // stores running child processes
const USER_STATE = {}; // stores user steps (uploading files etc)
const INTERACTIVE_SESSIONS = {}; // stores user mapping to process for input

// Connect DB
async function connectDB() {
    try {
        await client.connect();
        db = client.db("master_node_db");
        projectsCol = db.collection("projects");
        keysCol = db.collection("access_keys");
        usersCol = db.collection("users");
        console.log("✅ Connected to MongoDB");
        restoreProjects(); // Auto Restore on Start
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

// ================= PROCESS MANAGEMENT (Terminal Logic) =================

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    if (!silent) bot.sendMessage(chatId, `⏳ **Initializing ${projName}...**`);

    // 1. Install Dependencies
    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        if (!silent) bot.sendMessage(chatId, `📦 **Installing NPM Modules...** (This may take time)`);
        
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        
        await new Promise((resolve) => {
            install.on('close', (code) => resolve(code));
        });
    }

    // 2. Start Process
    if (!silent) bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Interactive Mode Active:**\nIf the bot asks for Number/Code, just reply here.`);

    // Use 'spawn' to keep stdin/stdout open
    // Assuming main file is index.js, change if needed
    const child = spawn('node', ['index.js'], { cwd: basePath, shell: true });

    ACTIVE_PROCESSES[projectId] = child;
    
    // Map user chat to this process for Input Injection
    if (chatId) INTERACTIVE_SESSIONS[chatId] = projectId;

    // Update DB Status
    await projectsCol.updateOne(
        { user_id: userId, name: projName },
        { $set: { status: "Running", path: basePath } }
    );

    // --- HANDLE LOGS (The WhatsApp Pairing Magic) ---
    
    child.stdout.on('data', (data) => {
        const output = data.toString();
        // If interactive mode is active (user is watching), send logs to Telegram
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId) {
            // Avoid sending empty logs
            if (output.trim().length > 0) {
                bot.sendMessage(chatId, `🖥️ **Terminal:**\n\`${output}\``, { parse_mode: "Markdown" });
            }
        }
    });

    child.stderr.on('data', (data) => {
        const error = data.toString();
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId) {
            bot.sendMessage(chatId, `⚠️ **Error Log:**\n\`${error}\``, { parse_mode: "Markdown" });
        }
    });

    child.on('close', (code) => {
        delete ACTIVE_PROCESSES[projectId];
        if (INTERACTIVE_SESSIONS[chatId] === projectId) delete INTERACTIVE_SESSIONS[chatId];
        
        projectsCol.updateOne({ user_id: userId, name: projName }, { $set: { status: "Stopped" } });
        
        if (chatId && !silent) {
            bot.sendMessage(chatId, `🛑 **Process Ended** (Code: ${code})`);
        }
    });
}

// ================= MESSAGE HANDLERS =================

// 1. Handle Text Input (Terminal Input & Menus)
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    // A. Check for Interactive Terminal Input
    // اگر کوئی پروسیس چل رہا ہے اور ان پٹ مانگ رہا ہے
    if (INTERACTIVE_SESSIONS[chatId] && text && !text.startsWith("/")) {
        const projectId = INTERACTIVE_SESSIONS[chatId];
        const child = ACTIVE_PROCESSES[projectId];
        if (child) {
            // Send user text to the running script
            child.stdin.write(text + "\n"); 
            return; // Don't process other logic
        }
    }

    // B. Standard Logic
    if (!text) return;

    if (text.startsWith("/start")) {
        // Auth Logic
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

    // C. Project Creation Logic
    if (USER_STATE[userId]) {
        if (USER_STATE[userId].step === "ask_name") {
            const projName = text.trim().replace(/\s+/g, '_');
            const exists = await projectsCol.findOne({ user_id: userId, name: projName });
            
            if (exists) return bot.sendMessage(chatId, "❌ Name taken. Try another.");

            USER_STATE[userId] = { step: "wait_files", name: projName };
            
            const opts = {
                reply_markup: {
                    resize_keyboard: true,
                    keyboard: [[{ text: "✅ Done / Start Deploy" }]]
                }
            };
            bot.sendMessage(chatId, `✅ Name: **${projName}**\n\nSend your files (index.js, package.json etc).\nPress Done when finished.`, opts);
        }
        else if (text === "✅ Done / Start Deploy" && USER_STATE[userId].step === "wait_files") {
            // Finish Upload
            const projName = USER_STATE[userId].name;
            delete USER_STATE[userId];
            
            bot.sendMessage(chatId, "⚙️ Starting Deployment...", { reply_markup: { remove_keyboard: true } });
            startProject(userId, projName, chatId);
        }
    }
});

// 2. Handle File Uploads
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    if (USER_STATE[userId] && USER_STATE[userId].step === "wait_files") {
        const projName = USER_STATE[userId].name;
        const fileName = msg.document.file_name;
        
        const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const filePath = path.join(dir, fileName);
        
        // Download
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.arrayBuffer();
        fs.writeFileSync(filePath, Buffer.from(buffer));

        // Save to DB (Persistence)
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $push: { files: { name: fileName, content: Buffer.from(buffer) } } },
            { upsert: true }
        );

        bot.sendMessage(msg.chat.id, `📥 Received: \`${fileName}\``);
    }
});

// ================= CALLBACK QUERIES (Menus) =================

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
        const keyboard = projects.map(p => {
            const status = p.status === "Running" ? "🟢" : "🔴";
            return [{ text: `${status} ${p.name}`, callback_data: `menu_${p.name}` }];
        });
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        bot.editMessageText("📂 **Your Projects**", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }

    else if (data.startsWith("menu_")) {
        const projName = data.split("_")[1];
        const keyboard = [
            [
                { text: "🛑 Stop", callback_data: `stop_${projName}` },
                { text: "▶️ Start (Live)", callback_data: `start_${projName}` }
            ],
            [{ text: "🗑️ Delete", callback_data: `del_${projName}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        bot.editMessageText(`⚙️ Manage: **${projName}**`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }

    else if (data.startsWith("stop_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        if (ACTIVE_PROCESSES[projId]) {
            ACTIVE_PROCESSES[projId].kill();
            bot.answerCallbackQuery(query.id, { text: "Process Stopped" });
        } else {
            bot.answerCallbackQuery(query.id, { text: "Already Stopped" });
        }
    }

    else if (data.startsWith("start_")) {
        const projName = data.split("_")[1];
        bot.deleteMessage(chatId, query.message.message_id); // Clear menu to make space for logs
        startProject(userId, projName, chatId);
    }

    else if (data === "main_menu") {
        bot.editMessageText("🏠 Main Menu", { chat_id: chatId, message_id: query.message.message_id, reply_markup: getMainMenu(userId) });
    }
});

// ================= AUTO RESTORE =================
async function restoreProjects() {
    console.log("🔄 Restoring Projects...");
    const runningProjs = await projectsCol.find({ status: "Running" }).toArray();
    
    for (const proj of runningProjs) {
        const dir = path.join(__dirname, 'deployments', proj.user_id.toString(), proj.name);
        
        if (!fs.existsSync(dir)) {
            console.log(`♻️ Rebuilding: ${proj.name}`);
            fs.mkdirSync(dir, { recursive: true });
            
            if (proj.files) {
                for (const file of proj.files) {
                    fs.writeFileSync(path.join(dir, file.name), file.content.buffer);
                }
            }
            // Start quietly without Telegram logs initially
            startProject(proj.user_id, proj.name, null, true);
        }
    }
}
