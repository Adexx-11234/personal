const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs');
const path = require('path');

const {
    BOT_TOKEN, GROUP_ID, ADMIN_PASSWORD, CHANNEL_LINK, DEV_LINK, PORT,
    ADMIN_IDS, OTP_HISTORY_FILE,
    extractCountry, getCountryEmoji, isAdmin,
} = require('./config');

const { initBrowser, loadCookies, setSessionCookies, isSessionValid } = require('./browser');
const {
    fetchAllSms, getMyNumbers, getCountryRanges, getNumbersByRange, detectNewRanges, fetchSmsRanges,
} = require('./fetcher');

// ============================================================
// STATE
// ============================================================
let bot = null;
let userSessions = {};  // { userId: { country: rangeName, number: phoneNumber } }

const botStats = {
    startTime: new Date(),
    totalOtpsSent: 0,
    lastCheck: 'Never',
    lastError: null,
    isRunning: false,
    consecutiveFailures: 0,
};

// ============================================================
// OTP HISTORY
// ============================================================
function loadOtpHistory() {
    try {
        if (fs.existsSync(OTP_HISTORY_FILE)) return JSON.parse(fs.readFileSync(OTP_HISTORY_FILE, 'utf8'));
    } catch (e) {}
    return {};
}

function saveOtpHistory(history) {
    try { fs.writeFileSync(OTP_HISTORY_FILE, JSON.stringify(history, null, 2)); } catch (e) {}
}

function isOtpSent(msgId) {
    const history = loadOtpHistory();
    return !!history[msgId];
}

function markOtpSent(msgId, otp, fullMessage) {
    const history = loadOtpHistory();
    history[msgId] = { otp, fullMessage, timestamp: new Date().toISOString() };
    saveOtpHistory(history);
}

// ============================================================
// MESSAGE FORMATTERS
// ============================================================
function formatOtpMessage(data) {
    const masked = data.phone.length > 6
        ? data.phone.substring(0, 4) + '***' + data.phone.slice(-4)
        : data.phone;

    return `✅ <b>New ${data.service} OTP Received</b>

━━━━━━━━━━━━━━━━━━━━
⏰ <b>Time:</b> ${new Date(data.timestamp).toLocaleString()}
🌍 <b>Country:</b> ${data.country}
🛠 <b>Service:</b> ${data.service}
📱 <b>Number:</b> ${masked}
🔑 <b>OTP:</b> <code>${data.otp}</code>
━━━━━━━━━━━━━━━━━━━━
💬 <b>Message:</b>
<blockquote>${data.message}</blockquote>`;
}

function otpButtons() {
    return {
        inline_keyboard: [[
            { text: '🚀 Panel', url: `https://t.me/${BOT_TOKEN.split(':')[0]}` },
            { text: '📢 Channel', url: CHANNEL_LINK },
        ]],
    };
}

// ============================================================
// KEYBOARDS
// ============================================================
function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📱 Get Number', callback_data: 'get_number' }],
            [
                { text: '📊 Status', callback_data: 'status' },
                { text: '📈 Stats', callback_data: 'stats' },
            ],
            [{ text: '🔍 Check OTPs Now', callback_data: 'check' }],
            [{ text: '🧪 Send Test OTP', callback_data: 'test' }],
        ],
    };
}

function numberAssignedKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '🔄 Change Number', callback_data: 'change_number' }],
            [{ text: '🌍 Change Country', callback_data: 'change_country' }],
            [{ text: '🏠 Main Menu', callback_data: 'menu' }],
        ],
    };
}

// ============================================================
// SEND OTP
// ============================================================
async function sendOtpToGroup(data) {
    try {
        if (isOtpSent(data.id)) return false;

        const msg = formatOtpMessage(data);

        // Always send to group
        await bot.sendMessage(GROUP_ID, msg, {
            parse_mode: 'HTML',
            reply_markup: otpButtons(),
        });

        // Also send to user who has this number assigned
        const assignedUser = findUserWithNumber(data.phone);
        if (assignedUser) {
            try {
                await bot.sendMessage(assignedUser, msg, { parse_mode: 'HTML' });
                await bot.sendMessage(assignedUser,
                    `🔑 Your OTP: <code>${data.otp}</code>\n✅ Number session cleared.`,
                    { parse_mode: 'HTML' }
                );
                // Clear session so number is free for others
                delete userSessions[assignedUser];
                console.log(`✅ OTP forwarded to user ${assignedUser} and session cleared`);
            } catch (e) {
                console.error(`Could not DM user ${assignedUser}:`, e.message);
            }
        }

        markOtpSent(data.id, data.otp, data.message);
        botStats.totalOtpsSent++;
        console.log(`✅ OTP sent: ${data.otp} | ${data.service} | ${data.country}`);
        return true;

    } catch (err) {
        console.error('Failed to send OTP:', err.message);
        return false;
    }
}

function findUserWithNumber(phone) {
    for (const [userId, session] of Object.entries(userSessions)) {
        if (session.number === phone) return userId;
    }
    return null;
}

// ============================================================
// ALERT NEW RANGES
// ============================================================
async function alertNewRanges(newRanges) {
    try {
        const text = `🆕 <b>New Range(s) Detected!</b>\n\n` +
            newRanges.map(r => {
                const country = extractCountry(r);
                const emoji = getCountryEmoji(country);
                return `${emoji} <b>${r}</b>`;
            }).join('\n');

        await bot.sendMessage(GROUP_ID, text, { parse_mode: 'HTML' });
    } catch (e) {}
}

// ============================================================
// BOT HANDLERS
// ============================================================
function setupBotHandlers() {

    bot.onText(/\/start/, async (msg) => {
        await bot.sendMessage(msg.chat.id,
            '🏠 <b>Welcome to NEXUSBOT!</b>\n\nI monitor IVASMS for new OTPs and forward them instantly.',
            { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
        );
    });

    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const userId = query.from.id;
        const data = query.data;

        await bot.answerCallbackQuery(query.id);

        // ── MAIN MENU ──
        if (data === 'menu') {
            await bot.editMessageText('🏠 <b>Main Menu</b>\n\nChoose an option:',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );

        // ── GET NUMBER / CHANGE COUNTRY ──
        } else if (data === 'get_number' || data === 'change_country') {

            // ADMIN: send txt files per range
            if (isAdmin(userId)) {
                await bot.editMessageText('👑 <b>Admin: Fetching all numbers by range...</b>',
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
                );

                try {
                    const grouped = await getNumbersByRange();
                    const rangeNames = Object.keys(grouped);

                    if (rangeNames.length === 0) {
                        await bot.editMessageText('⚠️ No numbers found.',
                            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                        );
                        return;
                    }

                    await bot.editMessageText(`✅ Sending ${rangeNames.length} range file(s)...`,
                        { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
                    );

                    for (const rangeName of rangeNames) {
                        const numbers = grouped[rangeName];
                        const content = `Range: ${rangeName}\nTotal: ${numbers.length}\n\n` + numbers.join('\n');
                        const fileName = `${rangeName.replace(/\s+/g, '_')}.txt`;
                        const tmpPath = path.join(__dirname, fileName);
                        fs.writeFileSync(tmpPath, content);

                        await bot.sendDocument(chatId, tmpPath, {
                            caption: `${getCountryEmoji(extractCountry(rangeName))} <b>${rangeName}</b> — ${numbers.length} numbers`,
                            parse_mode: 'HTML',
                        });

                        fs.unlinkSync(tmpPath);
                        await new Promise(r => setTimeout(r, 300));
                    }

                    await bot.sendMessage(chatId, '✅ <b>All range files sent!</b>',
                        { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                    );

                } catch (err) {
                    await bot.sendMessage(chatId, `❌ Error: ${err.message}`, { parse_mode: 'HTML', reply_markup: mainMenuKeyboard() });
                }
                return;
            }

            // NORMAL USER: show country selector
            await bot.editMessageText('🌍 <b>Loading available countries...</b>',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
            );

            const ranges = await getCountryRanges();
            const rangeKeys = Object.keys(ranges);

            if (rangeKeys.length === 0) {
                await bot.editMessageText('⚠️ <b>No numbers available right now.</b>\n\nTry again later.',
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                );
                return;
            }

            const keyboard = [];
            let row = [];
            for (const rangeName of rangeKeys.slice(0, 20)) {
                const emoji = getCountryEmoji(extractCountry(rangeName));
                const safe = `country_${rangeName}`.replace(/[^\x20-\x7E]/g, '').substring(0, 64);
                if (safe === 'country_') continue;
                row.push({ text: `${emoji} ${rangeName}`, callback_data: safe });
                if (row.length === 2) { keyboard.push(row); row = []; }
            }
            if (row.length > 0) keyboard.push(row);
            keyboard.push([{ text: '🔄 Refresh Numbers', callback_data: 'refresh_numbers' }]);
            keyboard.push([{ text: '🏠 Main Menu', callback_data: 'menu' }]);

            await bot.editMessageText('🌍 <b>Select Country:</b>',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: { inline_keyboard: keyboard } }
            );

        // ── REFRESH NUMBERS ──
        } else if (data === 'refresh_numbers') {
            await bot.editMessageText('🔄 <b>Refreshing numbers cache...</b>',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
            );
            const ranges = await getCountryRanges(true);
            const count = Object.keys(ranges).length;
            await bot.editMessageText(`✅ <b>Refreshed! Found ${count} country ranges.</b>`,
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );

        // ── COUNTRY SELECTED ──
        } else if (data.startsWith('country_')) {
            const rangeName = data.replace('country_', '');
            const numbers = await getMyNumbers();

            let assignedNumber = null;
            for (const row of numbers) {
                if (row.length >= 2 && row[1].replace(/[^\x20-\x7E]/g, '') === rangeName) {
                    // Skip numbers already assigned to other users
                    const alreadyTaken = Object.values(userSessions).some(s => s.number === row[0]);
                    if (!alreadyTaken) { assignedNumber = row[0]; break; }
                }
            }

            if (!assignedNumber) {
                await bot.editMessageText('⚠️ <b>No available number for this range right now.</b>\n\nTry another country or refresh.',
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                );
                return;
            }

            userSessions[userId] = { country: rangeName, number: assignedNumber };
            const emoji = getCountryEmoji(extractCountry(rangeName));

            await bot.editMessageText(
                `🔄 <b>Number Assigned Successfully!</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `${emoji} <b>Range:</b> ${rangeName}\n` +
                `📱 <b>Number:</b> <code>${assignedNumber}</code>\n` +
                `🟢 <b>Status:</b> Ready to receive OTP\n` +
                `━━━━━━━━━━━━━━━━━━━━\n\n` +
                `Use this number to register. OTP will be sent to you automatically!`,
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: numberAssignedKeyboard() }
            );

        // ── CHANGE NUMBER (same country) ──
        } else if (data === 'change_number') {
            const session = userSessions[userId] || {};
            const rangeName = session.country;
            const currentNumber = session.number;

            if (!rangeName) {
                await bot.editMessageText('⚠️ No country selected. Please select a country first.',
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
                );
                return;
            }

            const numbers = await getMyNumbers();
            let assignedNumber = null;
            for (const row of numbers) {
                if (row.length >= 2 && row[1].replace(/[^\x20-\x7E]/g, '') === rangeName && row[0] !== currentNumber) {
                    const alreadyTaken = Object.values(userSessions).some(s => s.number === row[0]);
                    if (!alreadyTaken) { assignedNumber = row[0]; break; }
                }
            }

            if (!assignedNumber) {
                await bot.editMessageText('⚠️ <b>No other number available for this range.</b>',
                    { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: numberAssignedKeyboard() }
                );
                return;
            }

            userSessions[userId] = { country: rangeName, number: assignedNumber };
            const emoji = getCountryEmoji(extractCountry(rangeName));

            await bot.editMessageText(
                `🔄 <b>New Number Assigned!</b>\n\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `${emoji} <b>Range:</b> ${rangeName}\n` +
                `📱 <b>Number:</b> <code>${assignedNumber}</code>\n` +
                `🟢 <b>Status:</b> Ready to receive OTP\n` +
                `━━━━━━━━━━━━━━━━━━━━`,
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: numberAssignedKeyboard() }
            );

        // ── CHECK OTPs ──
        } else if (data === 'check') {
            await bot.editMessageText('🔍 <b>Checking for new OTPs...</b>',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML' }
            );
            const messages = await fetchAllSms();
            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) { await sendOtpToGroup(msg); sent++; }
            }
            await bot.editMessageText(
                sent > 0 ? `✅ <b>Found and forwarded ${sent} new OTP(s)!</b>` : '📭 <b>No new OTPs found.</b>\n\nChecking automatically every 10 seconds.',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );

        // ── STATUS ──
        } else if (data === 'status') {
            const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
            await bot.editMessageText(
                `📊 <b>NEXUSBOT Status</b>\n\n` +
                `⏱ <b>Uptime:</b> ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                `📨 <b>OTPs Sent:</b> ${botStats.totalOtpsSent}\n` +
                `🕐 <b>Last Check:</b> ${botStats.lastCheck}\n` +
                `🔐 <b>Session:</b> ${isSessionValid() ? '🟢 Valid' : '🔴 Invalid'}\n` +
                `🟢 <b>Monitor:</b> ${botStats.isRunning ? 'Running' : 'Stopped'}\n` +
                `👥 <b>Active Sessions:</b> ${Object.keys(userSessions).length}\n` +
                `❌ <b>Last Error:</b> ${botStats.lastError || 'None'}`,
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );

        // ── STATS ──
        } else if (data === 'stats') {
            const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
            await bot.editMessageText(
                `📈 <b>Detailed Statistics</b>\n\n` +
                `⏱ <b>Started:</b> ${botStats.startTime.toLocaleString()}\n` +
                `⏱ <b>Uptime:</b> ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
                `📨 <b>Total OTPs Sent:</b> ${botStats.totalOtpsSent}\n` +
                `🕐 <b>Last Check:</b> ${botStats.lastCheck}\n` +
                `🔁 <b>Check Interval:</b> Every 10 seconds\n` +
                `👥 <b>Active Sessions:</b> ${Object.keys(userSessions).length}\n` +
                `🟢 <b>Monitor Running:</b> ${botStats.isRunning ? 'Yes' : 'No'}`,
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );

        // ── TEST OTP ──
        } else if (data === 'test') {
            await sendOtpToGroup({
                id: 'test_' + Date.now(),
                phone: '5841620932',
                otp: '947444',
                service: 'WhatsApp',
                country: '🇻🇪 Venezuela',
                timestamp: new Date().toISOString(),
                message: '# Your WhatsApp code 947-444\nDont share this code with others\n4sgLq1p5sV6',
            });
            await bot.editMessageText('✅ <b>Test OTP sent to the group!</b>',
                { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'HTML', reply_markup: mainMenuKeyboard() }
            );
        }
    });
}

// ============================================================
// BACKGROUND MONITOR
// ============================================================
async function backgroundMonitor() {
    botStats.isRunning = true;
    console.log('🔍 Background OTP monitor started');

    while (botStats.isRunning) {
        try {
            console.log('Checking for new OTPs...');
            const messages = await fetchAllSms();
            botStats.lastCheck = new Date().toLocaleString();

            // Check for new ranges and alert
            const ranges = messages.map(m => m.range).filter(Boolean);
            if (ranges.length > 0) {
                const newRanges = await detectNewRanges([...new Set(ranges)]);
                if (newRanges.length > 0) await alertNewRanges(newRanges);
            }

            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) {
                    await sendOtpToGroup(msg);
                    sent++;
                }
            }

            if (sent > 0) {
                console.log(`📨 Sent ${sent} new OTPs`);
            } else {
                console.log('No new OTPs found');
            }

            botStats.consecutiveFailures = 0;
            await new Promise(r => setTimeout(r, 10000));

        } catch (err) {
            console.error('Monitor error:', err.message);
            botStats.lastError = err.message;
            botStats.consecutiveFailures++;

            if (botStats.consecutiveFailures >= 5) {
                console.warn('⚠️ 5 failures — reinitializing browser...');
                await initBrowser();
                botStats.consecutiveFailures = 0;
            } else {
                await new Promise(r => setTimeout(r, 30000));
            }
        }
    }
}

// ============================================================
// EXPRESS SERVER
// ============================================================
function setupExpress() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.get('/', (req, res) => {
        const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
        res.json({
            status: 'running', bot: 'NEXUSBOT',
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            totalOtpsSent: botStats.totalOtpsSent,
            lastCheck: botStats.lastCheck,
            sessionValid: isSessionValid(),
        });
    });

    app.get('/status', (req, res) => {
        const uptime = Math.floor((Date.now() - botStats.startTime.getTime()) / 1000);
        res.json({
            uptime: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
            totalOtpsSent: botStats.totalOtpsSent,
            lastCheck: botStats.lastCheck,
            isRunning: botStats.isRunning,
            sessionValid: isSessionValid(),
            lastError: botStats.lastError,
            activeSessions: Object.keys(userSessions).length,
        });
    });

    app.post('/update-cookies', (req, res) => {
        const { password, cookies } = req.body;
        if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Invalid password' });
        if (!cookies || !Array.isArray(cookies)) return res.status(400).json({ error: 'Invalid cookies format' });

        setSessionCookies(cookies);
        initBrowser().then(() => {
            res.json({ success: true, message: `Updated ${cookies.length} cookies`, sessionValid: isSessionValid() });
        });
    });

    app.get('/check', async (req, res) => {
        try {
            const messages = await fetchAllSms();
            let sent = 0;
            for (const msg of messages) {
                if (!isOtpSent(msg.id)) { await sendOtpToGroup(msg); sent++; }
            }
            res.json({ success: true, found: messages.length, sent });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/relogin', async (req, res) => {
        try {
            const result = await initBrowser();
            res.json({ success: result, sessionValid: isSessionValid() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/refresh-numbers', async (req, res) => {
        try {
            const numbers = await getMyNumbers(true);
            res.json({ success: true, count: numbers.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.get('/admin', (req, res) => {
        res.send(`<!DOCTYPE html>
<html>
<head>
    <title>NEXUSBOT Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: -apple-system, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height:100vh; padding:20px; display:flex; align-items:center; justify-content:center; }
        .container { background:white; border-radius:16px; box-shadow:0 20px 60px rgba(0,0,0,0.3); max-width:800px; width:100%; padding:40px; }
        h1 { color:#333; margin-bottom:30px; }
        .status { background:#f8f9fa; padding:15px; border-radius:8px; margin-bottom:20px; line-height:1.8; }
        input, textarea { width:100%; padding:12px; margin:10px 0; border:2px solid #e0e0e0; border-radius:8px; font-size:14px; }
        button { background:linear-gradient(135deg,#667eea 0%,#764ba2 100%); color:white; border:none; padding:14px; border-radius:8px; width:100%; cursor:pointer; font-size:16px; margin-top:5px; }
        button:hover { opacity:0.9; }
        .btn-red { background:linear-gradient(135deg,#f093fb 0%,#f5576c 100%); margin-top:10px; }
        .alert { padding:15px; margin-top:20px; border-radius:8px; display:none; }
        .success { background:#d4edda; color:#155724; }
        .error { background:#f8d7da; color:#721c24; }
    </style>
</head>
<body>
<div class="container">
    <h1>🤖 NEXUSBOT Admin</h1>
    <div class="status" id="status">Loading...</div>
    <form id="form">
        <input type="password" id="password" placeholder="Admin Password" required>
        <textarea id="cookies" rows="10" placeholder='Paste cookies JSON array here...' required></textarea>
        <button type="submit">🔄 Update Cookies</button>
    </form>
    <button class="btn-red" onclick="relogin()">🔁 Force Re-Login</button>
    <div class="alert" id="alert"></div>
</div>
<script>
    async function loadStatus() {
        const res = await fetch('/status');
        const d = await res.json();
        document.getElementById('status').innerHTML =
            'Session: ' + (d.sessionValid ? '✅ Valid' : '❌ Invalid') +
            '<br>OTPs Sent: ' + d.totalOtpsSent +
            '<br>Last Check: ' + d.lastCheck +
            '<br>Active Sessions: ' + d.activeSessions;
    }
    document.getElementById('form').onsubmit = async (e) => {
        e.preventDefault();
        const alertEl = document.getElementById('alert');
        try {
            const res = await fetch('/update-cookies', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ password: document.getElementById('password').value, cookies: JSON.parse(document.getElementById('cookies').value) })
            });
            const data = await res.json();
            alertEl.className = 'alert ' + (res.ok ? 'success' : 'error');
            alertEl.textContent = res.ok ? '✅ ' + data.message : '❌ ' + data.error;
            alertEl.style.display = 'block';
            if (res.ok) setTimeout(loadStatus, 3000);
        } catch(err) {
            alertEl.className = 'alert error';
            alertEl.textContent = '❌ ' + err.message;
            alertEl.style.display = 'block';
        }
    };
    async function relogin() {
        const alertEl = document.getElementById('alert');
        alertEl.className = 'alert success';
        alertEl.textContent = '🔁 Re-login started...';
        alertEl.style.display = 'block';
        const res = await fetch('/relogin');
        const data = await res.json();
        alertEl.textContent = data.success ? '✅ Re-login successful!' : '❌ Re-login failed';
        setTimeout(loadStatus, 2000);
    }
    loadStatus();
    setInterval(loadStatus, 10000);
</script>
</body>
</html>`);
    });

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server running on port ${PORT}`);
        console.log(`📝 Admin panel: http://localhost:${PORT}/admin`);
    });

    return app;
}

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
    setupBotHandlers,
    backgroundMonitor,
    setupExpress,
    initBot: () => {
        bot = new TelegramBot(BOT_TOKEN, { polling: true });
        return bot;
    },
    getBot: () => bot,
    sendOtpToGroup,
    alertNewRanges,
    botStats,
};