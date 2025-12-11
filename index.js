const TelegramBot = require('node-telegram-bot-api');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ================= CONFIGURATION =================
const TOKEN = "8452280797:AAEruS20yx0YCb2T8aHIZk8xjzRlLb6GDAk"; // Bot Token
const MONGO_URL = "mongodb://mongo:AEvrikOWlrmJCQrDTQgfGtqLlwhwLuAA@crossover.proxy.rlwy.net:29609"; // Mongo URL
const OWNER_IDS = [8167904992, 7134046678]; // Owner IDs

// ================= SETUP =================
const bot = new TelegramBot(TOKEN, { polling: true });
const client = new MongoClient(MONGO_URL);
let db, projectsCol, keysCol, usersCol;

// Global Variables
const ACTIVE_PROCESSES = {}; // stores running child processes
const USER_STATE = {}; // stores user steps
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
        restoreProjects(); 
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

// Helper to run NPM INSTALL strictly
function installDependencies(basePath, chatId) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(path.join(basePath, 'package.json'))) {
            return resolve("No package.json, skipping install.");
        }

        bot.sendMessage(chatId, `📦 **Installing Dependencies...**\nPlease wait, this handles heavy libraries like Baileys.`);

        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });

        // Capture error logs for debugging
        let errorLog = "";
        install.stderr.on('data', (data) => { errorLog += data.toString(); });

        install.on('close', (code) => {
            if (code === 0) {
                resolve("Success");
            } else {
                reject(`NPM Install Failed (Code ${code})\n${errorLog.slice(0, 500)}...`);
            }
        });
    });
}

async function startProject(userId, projName, chatId, silent = false) {
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const projectId = `${userId}_${projName}`;

    // 1. Check if process is already running
    if (ACTIVE_PROCESSES[projectId]) {
        if (!silent) bot.sendMessage(chatId, "⚠️ Bot is already running.");
        return;
    }

    if (!silent) bot.sendMessage(chatId, `⏳ **Initializing ${projName}...**`);

    // 2. Strict Dependency Installation
    // اگر فولڈر میں node_modules نہیں ہے یا یہ نئی ڈپلائمنٹ ہے تو انسٹال کرو
    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        try {
             // اگر silent (auto restore) ہے تو ہم دوبارہ انسٹال نہیں کرتے تاکہ ٹائم بچے، 
             // مگر اگر node_modules غائب ہے (Railway Restart) تو کرنا پڑے گا۔
            if (!silent || !fs.existsSync(path.join(basePath, 'node_modules'))) {
                await installDependencies(basePath, chatId || OWNER_IDS[0]); 
            }
        } catch (err) {
            if (chatId) bot.sendMessage(chatId, `❌ **Installation Error:**\n\`${err}\``, { parse_mode: "Markdown" });
            return; // Stop here, do not run index.js
        }
    }

    // 3. Start Process
    if (!silent && chatId) {
        bot.sendMessage(chatId, `🚀 **Starting App...**\n\n🔴 **Interactive Mode Active:**\nReply here to send input to terminal.`);
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, shell: true });
    ACTIVE_PROCESSES[projectId] = child;
    
    if (chatId) INTERACTIVE_SESSIONS[chatId] = projectId;

    // Update DB Status
    await projectsCol.updateOne(
        { user_id: userId, name: projName },
        { $set: { status: "Running", path: basePath } }
    );

    // --- LOGS HANDLER ---
    child.stdout.on('data', (data) => {
        const output = data.toString();
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId && output.trim().length > 0) {
            bot.sendMessage(chatId, `🖥️ **Terminal:**\n\`${output}\``, { parse_mode: "Markdown" });
        }
    });

    child.stderr.on('data', (data) => {
        const error = data.toString();
        // Baileys often prints info logs in stderr, so filter real errors or show all
        if (chatId && INTERACTIVE_SESSIONS[chatId] === projectId && error.trim().length > 0) {
            // Optional: Filter out "Buffer" warnings or known non-fatal errors
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

    // A. Interactive Terminal Input
    if (INTERACTIVE_SESSIONS[chatId] && text && !text.startsWith("/")) {
        const projectId = INTERACTIVE_SESSIONS[chatId];
        const child = ACTIVE_PROCESSES[projectId];
        if (child) {
            child.stdin.write(text + "\n"); 
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

// 2. Handle File Uploads (Deploy & Update)
bot.on('document', async (msg) => {
    const userId = msg.from.id;
    
    // Check if user is in 'wait_files' (New Deploy) OR 'update_files' (Manage)
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

        // DB Persistence Logic (Handles updates too)
        // Remove old file entry if exists
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $pull: { files: { name: fileName } } }
        );
        // Push new file entry
        await projectsCol.updateOne(
            { user_id: userId, name: projName },
            { $push: { files: { name: fileName, content: Buffer.from(buffer) } } },
            { upsert: true }
        );

        if (USER_STATE[userId].step === "update_files") {
            bot.sendMessage(msg.chat.id, `🔄 **Updated:** \`${fileName}\`\nRestart bot to apply changes.`);
        } else {
            bot.sendMessage(msg.chat.id, `📥 Received: \`${fileName}\``);
        }
    }
});

// ================= CALLBACK QUERIES =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    // 1. Deploy New
    if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Project Name (No spaces):");
    }
    
    // 2. List Projects
    else if (data === "manage_projects") {
        const projects = await projectsCol.find({ user_id: userId }).toArray();
        const keyboard = projects.map(p => {
            const status = p.status === "Running" ? "🟢" : "🔴";
            return [{ text: `${status} ${p.name}`, callback_data: `menu_${p.name}` }];
        });
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        bot.editMessageText("📂 **Your Projects**", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }

    // 3. Project Menu
    else if (data.startsWith("menu_")) {
        const projName = data.split("_")[1];
        const keyboard = [
            [
                { text: "🛑 Stop", callback_data: `stop_${projName}` },
                { text: "▶️ Start", callback_data: `start_${projName}` }
            ],
            [{ text: "📝 Update Files", callback_data: `upd_${projName}` }],
            [{ text: "🗑️ Delete", callback_data: `del_${projName}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        bot.editMessageText(`⚙️ Manage: **${projName}**`, { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard } });
    }

    // 4. Actions
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

    // --- FIX: DELETE LOGIC ---
    else if (data.startsWith("del_")) {
        const projName = data.split("_")[1];
        const projId = `${userId}_${projName}`;
        
        // Stop if running
        if (ACTIVE_PROCESSES[projId]) ACTIVE_PROCESSES[projId].kill();

        // Delete from DB
        await projectsCol.deleteOne({ user_id: userId, name: projName });

        // Delete from Disk
        const dir = path.join(__dirname, 'deployments', userId.toString(), projName);
        if (fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
        }

        bot.answerCallbackQuery(query.id, { text: "Project Deleted!" });
        // Go back to list
        bot.deleteMessage(chatId, query.message.message_id);
    }

    // --- FIX: UPDATE FILES LOGIC ---
    else if (data.startsWith("upd_")) {
        const projName = data.split("_")[1];
        USER_STATE[userId] = { step: "update_files", name: projName };
        
        bot.editMessageText(
            `📝 **Update Mode: ${projName}**\n\nSend new files (e.g. updated \`index.js\` or \`package.json\`).\nThey will replace existing ones automatically.`, 
            { 
                chat_id: chatId, 
                message_id: query.message.message_id, 
                reply_markup: { inline_keyboard: [[{ text: "🔙 Cancel", callback_data: "manage_projects" }]] } 
            }
        );
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
            // Start quietly but ensure install happens if modules missing
            startProject(proj.user_id, proj.name, null, true);
        }
    }
}
