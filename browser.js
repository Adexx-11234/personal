const fs = require('fs');
const { BASE_URL, PORTAL_URL, COOKIES_FILE } = require('./config');

const IVAS_EMAIL = process.env.IVAS_EMAIL || '';
const IVAS_PASSWORD = process.env.IVAS_PASSWORD || '';
const LOGIN_URL = `${BASE_URL}/login`;

// ============================================================
// STATE — browser stays open so fetcher can use page.evaluate
// ============================================================
let browser = null;
let page = null;
let csrfToken = null;
let sessionCookies = [];
let sessionValid = false;
let pageReady = false;  // true when page is idle and safe to use

// ============================================================
// COOKIE HELPERS
// ============================================================
function loadCookies() {
    try {
        if (fs.existsSync(COOKIES_FILE)) {
            sessionCookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
            console.log(`✅ Loaded ${sessionCookies.length} cookies from file`);
            return true;
        }
    } catch (err) { console.error('Error loading cookies:', err.message); }
    return false;
}

function saveCookies(cookies) {
    try {
        fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
        sessionCookies = cookies;
        console.log(`✅ Saved ${cookies.length} cookies to file`);
    } catch (err) { console.error('Error saving cookies:', err.message); }
}

function getCookies()      { return sessionCookies; }
function getCsrfToken()    { return csrfToken; }
function isSessionValid()  { return sessionValid; }
function isPageReady()     { return pageReady; }
function getPage()         { return page; }
function getBrowser()      { return browser; }

function getCookieHeader() {
    return sessionCookies.map(c => `${c.name}=${c.value}`).join('; ');
}

// ============================================================
// CLOUDFLARE WAIT — just waits, turnstile:true auto-clicks
// ============================================================
async function waitForCloudflare(pg, maxWaitMs = 40000) {
    console.log('⏳ Waiting for Cloudflare to clear...');
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const isCf = await pg.evaluate(() => {
                const body = document.body?.innerText?.toLowerCase() || '';
                const title = document.title.toLowerCase();
                return (
                    title.includes('just a moment') ||
                    body.includes('performing security verification') ||
                    body.includes('checking your browser') ||
                    body.includes('verify you are human')
                );
            });

            if (!isCf) { console.log('✅ Cloudflare cleared!'); return true; }
        } catch (e) {}

        process.stdout.write('.');
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('\n⚠️ CF wait timeout — continuing anyway');
    return false;
}

// ============================================================
// AUTO LOGIN
// ============================================================
async function doLogin(pg) {
    if (!IVAS_EMAIL || !IVAS_PASSWORD) {
        console.log('⚠️ No IVAS_EMAIL/IVAS_PASSWORD — skipping auto login');
        return false;
    }

    try {
        console.log('🔑 Navigating to login page...');
        await pg.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 2000));
        await waitForCloudflare(pg, 20000);
        await new Promise(r => setTimeout(r, 1000));

        const hasForm = await pg.evaluate(() =>
            !!(document.querySelector('input[type="email"], input[name="email"]'))
        );

        if (!hasForm) { console.log('⚠️ Login form not visible'); return false; }

        // Fill email
        await pg.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_EMAIL, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        // Fill password
        await pg.click('input[type="password"], input[name="password"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_PASSWORD, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        console.log('📝 Credentials entered — clicking Log in...');

        // Click with realClick (puppeteer-real-browser), fallback to evaluate
        try {
            await pg.realClick('button[type="submit"]');
        } catch (e) {
            await pg.evaluate(() => {
                const submit = document.querySelector('button[type="submit"], input[type="submit"]');
                if (submit) submit.click();
            });
        }

        await pg.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        await waitForCloudflare(pg, 15000);

        const currentUrl = pg.url();
        console.log('📍 Post-login URL:', currentUrl);

        if (currentUrl.includes('/login')) {
            const error = await pg.evaluate(() => {
                const err = document.querySelector('.alert-danger, .error-message, .invalid-feedback');
                return err ? err.textContent.trim() : 'Unknown error';
            });
            console.log('❌ Still on login page:', error);
            return false;
        }

        console.log('✅ Auto-login successful!');
        return true;

    } catch (err) {
        console.error('❌ Login error:', err.message);
        return false;
    }
}

// ============================================================
// INIT BROWSER
// Note: browser stays OPEN — fetcher uses page.evaluate()
// to make POST requests in the browser context, avoiding 403
// ============================================================
async function initBrowser() {
    try {
        console.log('🚀 Launching Puppeteer Real Browser...');
        pageReady = false;

        if (browser) {
            try { await browser.close(); } catch (e) {}
            browser = null; page = null;
        }

        const { connect } = require('puppeteer-real-browser');

        const { browser: rb, page: rp } = await connect({
            headless: false,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            customConfig: {
                chromePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            },
            turnstile: true,
            connectOption: { defaultViewport: null },
            disableXvfb: process.platform === 'win32',
            ignoreAllFlags: false,
        });

        browser = rb;
        page = rp;

        await page.setDefaultNavigationTimeout(90000);
        await page.setDefaultTimeout(60000);

        // Load saved cookies
        if (sessionCookies.length > 0) {
            await page.setCookie(...sessionCookies);
            console.log('✅ Loaded cookies into browser');
        }

        // Navigate to portal
        console.log('🌐 Navigating to portal...');
        try {
            await page.goto(BASE_URL + '/portal', { waitUntil: 'load', timeout: 90000 });
        } catch (e) { console.log('⚠️ Page load timeout, continuing...'); }

        // Wait for CF (turnstile:true auto-handles it)
        await waitForCloudflare(page, 40000);
        await new Promise(r => setTimeout(r, 2000));

        // Check if logged in
        let isLoggedIn = await page.evaluate(() =>
            !!(document.querySelector('.user-panel') &&
               (document.querySelector('#spa-content') || document.querySelector('.content-wrapper')) &&
               window.location.href.includes('/portal'))
        ).catch(() => false);

        if (!isLoggedIn) {
            console.log('🔒 Not logged in — trying auto login...');
            const loginOk = await doLogin(page);

            if (loginOk) {
                await page.goto(BASE_URL + '/portal', { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000));
                await waitForCloudflare(page, 10000);

                isLoggedIn = await page.evaluate(() =>
                    !!(document.querySelector('.user-panel') && window.location.href.includes('/portal'))
                ).catch(() => false);
            }

            if (!isLoggedIn) {
                console.log('\n⚠️ Auto login failed — waiting for manual login (90s)...');
                let waited = 0;
                while (waited < 90000) {
                    await new Promise(r => setTimeout(r, 3000));
                    waited += 3000;
                    isLoggedIn = await page.evaluate(() =>
                        !!(document.querySelector('.user-panel') && window.location.href.includes('/portal'))
                    ).catch(() => false);
                    if (isLoggedIn) break;
                    process.stdout.write(`\r⏳ Waiting for manual login... (${Math.floor(waited / 1000)}s)`);
                }
            }
        }

        if (!isLoggedIn) {
            console.log('\n❌ Could not authenticate');
            sessionValid = false;
            return false;
        }

        console.log('\n✅ Portal authenticated!');

        // Navigate to SMS page and extract CSRF token
        await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));

        const token = await page.evaluate(() => {
            const meta = document.querySelector('meta[name="csrf-token"]');
            return meta ? meta.getAttribute('content') : null;
        });

        if (!token) {
            console.log('⚠️ No CSRF token found');
            sessionValid = false;
            return false;
        }

        csrfToken = token;
        saveCookies(await page.cookies());
        sessionValid = true;
        pageReady = true;

        console.log('✅ CSRF token extracted — browser staying open for HTTP requests');
        return true;

    } catch (err) {
        console.error('❌ Browser init error:', err.message);
        sessionValid = false;
        return false;
    }
}

// ============================================================
// Navigate page back to SMS received (used by fetcher)
// ============================================================
async function ensureOnSmsPage() {
    if (!page) return false;
    try {
        const url = page.url();
        if (!url.includes('/portal/sms/received')) {
            await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 1500));
            // Refresh CSRF
            const token = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="csrf-token"]');
                return meta ? meta.getAttribute('content') : null;
            });
            if (token) csrfToken = token;
        }
        return true;
    } catch (e) { return false; }
}

function setSessionCookies(cookies) {
    sessionCookies = cookies;
    saveCookies(cookies);
    csrfToken = null;
    sessionValid = false;
    pageReady = false;
}

function setCsrfToken(token) { csrfToken = token; }

module.exports = {
    initBrowser,
    loadCookies,
    saveCookies,
    getCookies,
    getCsrfToken,
    setCsrfToken,
    isSessionValid,
    isPageReady,
    getCookieHeader,
    setSessionCookies,
    getPage,
    getBrowser,
    ensureOnSmsPage,
};
