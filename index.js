const TelegramBot = require('node-telegram-bot-api');
const { MongoClient, ObjectId } = require('mongodb'); 
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const uuid = require('uuid');

// ================= CONFIGURATION =================
// اپنی معلومات یہاں درج کریں
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

// لاگ ڈائریکٹری بنانا
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

async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
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
             await bot.sendMessage(chatId, `⚠️ File not found: \`${fileName}\``, { parse_mode: 'Markdown' });
             return;
        }
        if (!fs.existsSync(newDir)) await fs.promises.mkdir(newDir, { recursive: true });
        
        await fs.promises.rename(oldPath, newPath);
        const fileContent = await fs.promises.readFile(newPath); 
        const relativePath = path.join(targetFolder, fileName).replace(/\\/g, '/'); 
        
        await saveFileToStorage(userId, projData._id, relativePath, fileContent);
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
        if (!fs.existsSync(path.join(basePath, 'package.json'))) return resolve("No package.json");
        if(chatId) bot.sendMessage(chatId, `📦 *Installing Dependencies\\.\\.\\.*`, { parse_mode: 'MarkdownV2' });
        
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        install.on('close', (code) => code === 0 ? resolve("Success") : resolve("Issue"));
    });
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

// ================= MAIN START PROJECT =================

async function startProject(userId, projId, chatId, silent = false) {
    const projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
    if (!projectData) return;

    const projName = projectData.name;
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projName);
    const pid = projId.toString();

    await forceStopProject(projId);

    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });

    // فائلز کو ڈسک پر لکھنا
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        await installDependencies(basePath, chatId);
    }

    const child = spawn('node', ['index.js'], { cwd: basePath, shell: true });
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

    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running" } });

    if (!silent && chatId) bot.sendMessage(chatId, `🚀 *${escapeMarkdown(projName)} Started\\!*`, { parse_mode: 'MarkdownV2' });

    child.stdout.on('data', (data) => {
        const output = data.toString();
        logStream.write(output);
        if (chatId && ACTIVE_SESSIONS[pid].logging) {
            bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(output.trim().slice(0, 500))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
        }
    });

    child.stderr.on('data', (data) => {
        logStream.write(data.toString());
        if (chatId && ACTIVE_SESSIONS[pid].logging) {
            bot.sendMessage(chatId, `⚠️ \`${escapeMarkdown(data.toString().trim().slice(0, 500))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
        }
    });

    child.on('close', (code) => {
        forceStopProject(projId);
        if (chatId && !silent) bot.sendMessage(chatId, `🛑 *Process Exited* \\(Code: ${code}\\)`, { parse_mode: "MarkdownV2" }).catch(()=>{});
    });
}

// ================= MESSAGE HANDLERS =================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (text === "/start") {
        if (await isAuthorized(userId)) {
            bot.sendMessage(chatId, "👋 *Node\\.js Master Bot*", { reply_markup: getMainMenu(userId), parse_mode: 'MarkdownV2' });
        } else {
            bot.sendMessage(chatId, "🔒 Access Denied.");
        }
        return;
    }

    if (USER_STATE[userId]) {
        if (text === "✅ Done / Apply Actions") {
            const projData = USER_STATE[userId].data;
            delete USER_STATE[userId];
            bot.sendMessage(chatId, "⚙️ Processing...", { reply_markup: { remove_keyboard: true } });
            startProject(userId, projData._id, chatId);
            return;
        }

        if (USER_STATE[userId].step === "ask_name") {
            const res = await projectsCol.insertOne({ user_id: userId, name: text, files: [], status: "Stopped" });
            USER_STATE[userId] = { step: "wait_files", data: { _id: res.insertedId, name: text } };
            bot.sendMessage(chatId, `✅ Project *${text}* Created. Send files now or type \`Done\`.`, {
                reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }
            });
        }
    }
});

bot.on('document', async (msg) => {
    const userId = msg.from.id;
    if (USER_STATE[userId] && (USER_STATE[userId].step === "wait_files" || USER_STATE[userId].step === "update_files")) {
        const projData = USER_STATE[userId].data;
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.arrayBuffer();
        
        await saveFileToStorage(userId, projData._id, msg.document.file_name, Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `✅ Received: ${msg.document.file_name}`);
    }
});

// ================= CALLBACK HANDLING =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data === "deploy_new") {
        USER_STATE[userId] = { step: "ask_name" };
        bot.sendMessage(chatId, "📂 Enter Project Name:");
    }

    if (data === "manage_projects") {
        const projects = await projectsCol.find({ user_id: userId }).toArray();
        const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p._id}` }]);
        keyboard.push([{ text: "🔙 Back", callback_data: "main_menu" }]);
        safeEditMessage(chatId, query.message.message_id, "📂 *Your Projects*", keyboard);
    }

    if (data.startsWith("menu_")) {
        const projId = data.split('_')[1];
        const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
        const isRunning = ACTIVE_SESSIONS[projId] ? true : false;
        
        const keyboard = [
            [{ text: isRunning ? "🛑 Stop" : "▶️ Start", callback_data: `tog_run_${projId}` }],
            [{ text: "🗑️ Delete", callback_data: `del_${projId}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        safeEditMessage(chatId, query.message.message_id, `⚙️ Project: ${proj.name}`, keyboard);
    }

    if (data.startsWith("tog_run_")) {
        const projId = data.split('_')[2];
        if (ACTIVE_SESSIONS[projId]) {
            await forceStopProject(projId);
            bot.sendMessage(chatId, "🛑 Stopped.");
        } else {
            startProject(userId, projId, chatId);
        }
    }

    if (data.startsWith("del_")) {
        const projId = data.split('_')[1];
        await forceStopProject(projId);
        await projectsCol.deleteOne({ _id: new ObjectId(projId) });
        bot.sendMessage(chatId, "✅ Deleted.");
    }
});

async function restoreProjects() {
    console.log("🔄 Restoring Projects...");
    const runningOnes = await projectsCol.find({ status: "Running" }).toArray();
    for (const proj of runningOnes) {
        startProject(proj.user_id, proj._id, null, true);
    }
}

bot.on('polling_error', console.log);
