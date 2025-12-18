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
const bot = new TelegramBot(TOKEN, { polling: true });
const client = new MongoClient(MONGO_URL);

let db, projectsCol, keysCol, usersCol;
const ACTIVE_SESSIONS = {}; 
const USER_STATE = {}; 
const LOG_DIR = path.join(__dirname, 'temp_logs');

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

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
        setTimeout(connectDB, 5000);
    }
}
connectDB();

// ================= HELPER FUNCTIONS =================

function escapeMarkdown(text) {
    if (!text) return "";
    return text.toString().replace(/[_*[\]()~\x60>#+\-=|{}.!]/g, '\\$&');
}

async function isAuthorized(userId) {
    if (OWNER_IDS.includes(userId)) return true;
    const user = await usersCol.findOne({ user_id: userId });
    return !!user;
}

// 🔥 فائل ری پلیسمنٹ لاجک
async function saveFileToStorage(userId, projId, relativePath, contentBuffer) {
    try {
        const safeId = new ObjectId(String(projId));
        // پہلے سے موجود اسی نام کی فائل ہٹائیں
        await projectsCol.updateOne({ _id: safeId }, { $pull: { files: { name: relativePath } } });
        // نئی فائل ڈالیں
        await projectsCol.updateOne({ _id: safeId }, { $push: { files: { name: relativePath, content: contentBuffer } } });
        return true;
    } catch (e) { return false; }
}

// 🔥 فائلز کو فولڈر میں موو کرنا (e.g. plugins tools.js settings.js)
async function moveFilesToFolder(userId, projData, inputLine, chatId) {
    const parts = inputLine.split(/\s+/);
    if (parts.length < 2) return;

    const folderName = parts[0];
    const filesToMove = parts.slice(1);
    const basePath = path.join(__dirname, 'deployments', userId.toString(), projData.name);
    const targetDir = path.join(basePath, folderName);

    if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

    for (const fileName of filesToMove) {
        const oldPath = path.join(basePath, fileName);
        if (fs.existsSync(oldPath)) {
            const newPath = path.join(targetDir, fileName);
            const relativeNewPath = path.join(folderName, fileName).replace(/\\/g, '/');
            
            const content = fs.readFileSync(oldPath);
            await saveFileToStorage(userId, projData._id, relativeNewPath, content);
            await projectsCol.updateOne({ _id: new ObjectId(String(projData._id)) }, { $pull: { files: { name: fileName } } });
            fs.renameSync(oldPath, newPath);
            bot.sendMessage(chatId, `📂 Moved \`${fileName}\` to \`${folderName}/\``, { parse_mode: 'Markdown' });
        }
    }
}

// ================= PROCESS MANAGEMENT =================

async function forceStopProject(projId) {
    const pid = projId.toString();
    if (ACTIVE_SESSIONS[pid]) {
        const session = ACTIVE_SESSIONS[pid];
        try {
            // پورٹ اور میموری خالی کرنے کے لیے مکمل کِل (Force Kill Tree)
            if (process.platform === 'win32') {
                spawn("taskkill", ["/pid", session.process.pid, "/f", "/t"]);
            } else {
                process.kill(-session.process.pid, 'SIGKILL');
            }
        } catch (e) {
            session.process?.kill('SIGKILL');
        }
        if (session.logStream) session.logStream.end();
        delete ACTIVE_SESSIONS[pid];
    }
    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
    // پورٹ فری ہونے کے لیے چھوٹا وقفہ
    await new Promise(resolve => setTimeout(resolve, 1500));
}

async function startProject(userId, projId, chatId, silent = false) {
    // 1. پہلے سے چلنے والے بوٹ کو جڑ سے ختم کریں
    await forceStopProject(projId);

    const projectData = await projectsCol.findOne({ _id: new ObjectId(String(projId)) });
    if (!projectData) return;

    const basePath = path.join(__dirname, 'deployments', userId.toString(), projectData.name);
    const pid = projId.toString();

    if (!fs.existsSync(basePath)) fs.mkdirSync(basePath, { recursive: true });

    // 2. فائلز لکھنا (Overwriting)
    if (projectData.files) {
        for (const file of projectData.files) {
            const fullPath = path.join(basePath, file.name);
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.content.buffer);
        }
    }

    if (!silent && chatId) bot.sendMessage(chatId, `⏳ Starting *${escapeMarkdown(projectData.name)}*...`, { parse_mode: 'MarkdownV2' });

    // 3. dependencies چیک کریں
    if (fs.existsSync(path.join(basePath, 'package.json'))) {
        const install = spawn('npm', ['install'], { cwd: basePath, shell: true });
        await new Promise(resolve => install.on('close', resolve));
    }

    // 4. بوٹ چلائیں (Detached Mode تاکہ کِل کرنا آسان ہو)
    const child = spawn('node', ['index.js'], { 
        cwd: basePath, 
        shell: true,
        detached: process.platform !== 'win32' 
    });

    const logStream = fs.createWriteStream(path.join(LOG_DIR, `${pid}.txt`), { flags: 'w' });

    ACTIVE_SESSIONS[pid] = {
        process: child,
        logging: true,
        logStream: logStream,
        chatId: chatId,
        name: projectData.name
    };

    await projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Running" } });

    child.stdout.on('data', (data) => {
        const out = data.toString();
        logStream.write(out);
        if (chatId && ACTIVE_SESSIONS[pid]?.logging) {
            // Pairing Code کی صورت میں فورا میسج
            const codeMatch = out.match(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
            if (codeMatch) bot.sendMessage(chatId, `🔑 *Pairing Code:* \`${codeMatch[0]}\``, { parse_mode: 'Markdown' });
            else bot.sendMessage(chatId, `🖥️ \`${escapeMarkdown(out.trim().slice(0, 400))}\``, { parse_mode: "MarkdownV2" }).catch(()=>{});
        }
    });

    child.on('close', () => {
        if (ACTIVE_SESSIONS[pid]) delete ACTIVE_SESSIONS[pid];
        projectsCol.updateOne({ _id: new ObjectId(String(projId)) }, { $set: { status: "Stopped" } });
    });
}

// ================= HANDLERS =================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    const text = msg.text;

    if (text === "/start") {
        if (await isAuthorized(userId)) {
            bot.sendMessage(chatId, "👋 *Node Master Bot*", { 
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "🚀 Deploy Project", callback_data: "deploy_new" }],
                        [{ text: "📂 Manage Projects", callback_data: "manage_projects" }],
                        [{ text: "👑 Owner Panel", callback_data: "owner_panel" }]
                    ]
                }, parse_mode: 'Markdown' 
            });
        }
        return;
    }

    if (USER_STATE[userId]) {
        const state = USER_STATE[userId];

        if (text === "✅ Done / Apply Actions") {
            const projId = state.data._id;
            delete USER_STATE[userId];
            bot.sendMessage(chatId, "⚙️ Applying changes and restarting...", { reply_markup: { remove_keyboard: true } });
            startProject(userId, projId, chatId);
            return;
        }

        // آٹو موو فنکشن یہاں کال ہوگا
        if ((state.step === "wait_files" || state.step === "update_files") && text && !text.startsWith('/')) {
            await moveFilesToFolder(userId, state.data, text, chatId);
        }

        if (state.step === "ask_name") {
            const res = await projectsCol.insertOne({ user_id: userId, name: text, files: [], status: "Stopped" });
            USER_STATE[userId] = { step: "wait_files", data: { _id: res.insertedId, name: text } };
            bot.sendMessage(chatId, `✅ Project *${text}* Created.\n\n1. Send files.\n2. To move: \`folder_name file.js\`\n3. Click Done.`, {
                reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }
            });
        }
    }
});

bot.on('document', async (msg) => {
    const userId = msg.from.id;
    const state = USER_STATE[userId];
    if (state && (state.step === "wait_files" || state.step === "update_files")) {
        const fileLink = await bot.getFileLink(msg.document.file_id);
        const response = await fetch(fileLink);
        const buffer = await response.arrayBuffer();
        await saveFileToStorage(userId, state.data._id, msg.document.file_name, Buffer.from(buffer));
        bot.sendMessage(msg.chat.id, `📥 File Replaced/Saved: \`${msg.document.file_name}\``, { parse_mode: 'Markdown' });
    }
});

// ================= CALLBACKS =================

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;

    if (data === "manage_projects") {
        const projects = await projectsCol.find({ user_id: userId }).toArray();
        const keyboard = projects.map(p => [{ text: `${p.status === "Running" ? "🟢" : "🔴"} ${p.name}`, callback_data: `menu_${p._id}` }]);
        keyboard.push([{ text: "🏠 Main Menu", callback_data: "main_menu" }]);
        bot.editMessageText("📂 *Select Project:*", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown' });
    }

    if (data.startsWith("menu_")) {
        const projId = data.split('_')[1];
        const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
        const isRunning = ACTIVE_SESSIONS[projId] ? true : false;
        const isLogging = ACTIVE_SESSIONS[projId]?.logging;

        const keyboard = [
            [{ text: isRunning ? "🛑 Stop Board" : "▶️ Start Board", callback_data: `tog_run_${projId}` }, 
             { text: isLogging ? "🔇 Mute Logs" : "🔊 Unmute Logs", callback_data: `tog_log_${projId}` }],
            [{ text: "📝 Update Files", callback_data: `upd_${projId}` }, 
             { text: "📥 Download Logs", callback_data: `dl_log_${projId}` }],
            [{ text: "🔄 Renew Session", callback_data: `renew_${projId}` }],
            [{ text: "🗑️ Delete", callback_data: `del_${projId}` }],
            [{ text: "🔙 Back", callback_data: "manage_projects" }]
        ];
        bot.editMessageText(`⚙️ *Project:* ${proj.name}\nStatus: ${isRunning ? 'Running' : 'Stopped'}`, {
            chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: keyboard }, parse_mode: 'Markdown'
        });
    }

    if (data.startsWith("tog_run_")) {
        const projId = data.split('_')[2];
        if (ACTIVE_SESSIONS[projId]) {
            await forceStopProject(projId);
            bot.answerCallbackQuery(query.id, { text: "Forced Stopped!" });
        } else {
            startProject(userId, projId, chatId);
            bot.answerCallbackQuery(query.id, { text: "Initializing..." });
        }
        setTimeout(() => bot.emit('callback_query', { ...query, data: `menu_${projId}` }), 2000);
    }

    if (data.startsWith("upd_")) {
        const projId = data.split('_')[1];
        const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
        await forceStopProject(projId); // فائلز اپڈیٹ سے پہلے اسٹاپ لازمی ہے
        USER_STATE[userId] = { step: "update_files", data: proj };
        bot.sendMessage(chatId, `📝 *Update Mode:* Send new files for ${proj.name}. Click Done to restart.`, {
            reply_markup: { resize_keyboard: true, keyboard: [[{ text: "✅ Done / Apply Actions" }]] }
        });
    }

    if (data.startsWith("renew_")) {
        const projId = data.split('_')[1];
        const proj = await projectsCol.findOne({ _id: new ObjectId(projId) });
        const basePath = path.join(__dirname, 'deployments', userId.toString(), proj.name);
        await forceStopProject(projId);
        const sPath = path.join(basePath, 'session');
        if (fs.existsSync(sPath)) fs.rmSync(sPath, { recursive: true, force: true });
        bot.sendMessage(chatId, "🔄 Session Cleared. Restarting...");
        startProject(userId, projId, chatId);
    }

    if (data === "main_menu") {
        bot.editMessageText("🏠 *Main Menu*", { chat_id: chatId, message_id: query.message.message_id, reply_markup: { inline_keyboard: [[{ text: "🚀 Deploy Project", callback_data: "deploy_new" }], [{ text: "📂 Manage Projects", callback_data: "manage_projects" }]] }, parse_mode: 'Markdown' });
    }
});

async function restoreProjects() {
    const running = await projectsCol.find({ status: "Running" }).toArray();
    for (const proj of running) {
        startProject(proj.user_id, proj._id, null, true);
    }
}

bot.on('polling_error', console.log);
