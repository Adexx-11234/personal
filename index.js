const { BOT_TOKEN, GROUP_ID } = require('./config');
const { initBrowser, loadCookies } = require('./browser');
const { setupBotHandlers, backgroundMonitor, setupExpress, initBot, getBot, botStats } = require('./bot');

async function main() {
    console.log('🚀 Starting NEXUSBOT...');

    if (!BOT_TOKEN || !GROUP_ID) {
        console.error('❌ Missing BOT_TOKEN or GROUP_ID in .env!');
        process.exit(1);
    }

    // Load saved cookies
    loadCookies();

    // Init Telegram bot
    const bot = initBot();
    setupBotHandlers();
    console.log('✅ Telegram bot initialized');

    // Init browser (login + get CSRF, then closes)
    const sessionReady = await initBrowser();

    // Start Express server
    setupExpress();

    // Send startup message to group
    setTimeout(async () => {
        try {
            await bot.sendMessage(GROUP_ID,
                `🚀 <b>NEXUSBOT Started!</b>\n\n` +
                `${sessionReady ? '✅ Session ready — monitoring active' : '⚠️ Session invalid — visit /admin to update cookies'}\n` +
                `🔁 Checking every 10 seconds`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            console.error('Startup message error:', err.message);
        }
    }, 3000);

    // Start background OTP monitor
    backgroundMonitor();
}

process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    const bot = getBot();
    if (bot) bot.stopPolling();
    process.exit(0);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason?.message || reason);
});

main().catch(console.error);