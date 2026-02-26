require('dotenv').config();
const puppeteer = require('puppeteer');
const fs = require('fs');
const { BASE_URL, PORTAL_URL, COOKIES_FILE } = require('./config');
const IVAS_EMAIL = process.env.IVAS_EMAIL || '';
const IVAS_PASSWORD = process.env.IVAS_PASSWORD || '';
const LOGIN_URL = `${BASE_URL}/login`;

let browser = null;
let page = null;
let csrfToken = null;
let sessionCookies = [];
let sessionValid = false;

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

function getCookies() { return sessionCookies; }
function getCsrfToken() { return csrfToken; }
function isSessionValid() { return sessionValid; }
function getCookieHeader() { return sessionCookies.map(c => `${c.name}=${c.value}`).join('; '); }

async function waitForCloudflare(pg, maxWaitMs = 60000) {
    console.log('⏳ Waiting for Cloudflare...');
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
        try {
            const isCf = await pg.evaluate(() => {
                const body = document.body?.innerText?.toLowerCase() || '';
                return (
                    body.includes('performing security verification') ||
                    body.includes('checking your browser') ||
                    body.includes('verify you are human') ||
                    document.title.toLowerCase().includes('just a moment')
                );
            });

            if (!isCf) { console.log('✅ Cloudflare cleared!'); return true; }

            // Find the CF iframe and click inside it with human-like mouse movement
            const frames = pg.frames();
            for (const frame of frames) {
                try {
                    const frameUrl = frame.url();
                    if (!frameUrl.includes('cloudflare') && !frameUrl.includes('challenges')) continue;

                    // Get checkbox position in the iframe
                    const checkbox = await frame.$('input[type="checkbox"], .ctp-checkbox-label, #cf-stage');
                    if (checkbox) {
                        const box = await checkbox.boundingBox();
                        if (box) {
                            // Move mouse to checkbox with human-like curve
                            await humanMouseMove(pg, box.x + box.width / 2, box.y + box.height / 2);
                            await new Promise(r => setTimeout(r, 200 + Math.random() * 300));
                            await pg.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                            console.log('🖱️ Clicked CF checkbox in iframe');
                            await new Promise(r => setTimeout(r, 3000));
                        }
                    }
                } catch (e) {}
            }

            // Also try clicking the turnstile widget directly on the page
            try {
                const cfWidget = await pg.$('iframe[src*="cloudflare"], iframe[src*="challenges"]');
                if (cfWidget) {
                    const box = await cfWidget.boundingBox();
                    if (box) {
                        // Click roughly where the checkbox is (left side of widget)
                        const clickX = box.x + 30;
                        const clickY = box.y + box.height / 2;
                        await humanMouseMove(pg, clickX, clickY);
                        await new Promise(r => setTimeout(r, 150 + Math.random() * 200));
                        await pg.mouse.click(clickX, clickY);
                        console.log('🖱️ Clicked CF iframe widget');
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            } catch (e) {}

        } catch (e) {}

        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('⚠️ CF timeout — please click manually');
    return false;
}

// Human-like mouse movement (bezier curve)
async function humanMouseMove(pg, targetX, targetY) {
    const startX = Math.random() * 400 + 100;
    const startY = Math.random() * 300 + 100;
    const steps = 20 + Math.floor(Math.random() * 15);

    await pg.mouse.move(startX, startY);

    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        // Bezier curve with random control point
        const cpX = (startX + targetX) / 2 + (Math.random() - 0.5) * 100;
        const cpY = (startY + targetY) / 2 + (Math.random() - 0.5) * 100;
        const x = (1 - t) * (1 - t) * startX + 2 * (1 - t) * t * cpX + t * t * targetX;
        const y = (1 - t) * (1 - t) * startY + 2 * (1 - t) * t * cpY + t * t * targetY;
        await pg.mouse.move(x + (Math.random() - 0.5) * 2, y + (Math.random() - 0.5) * 2);
        await new Promise(r => setTimeout(r, 10 + Math.random() * 20));
    }
}

async function doLogin(pg) {
    if (!IVAS_EMAIL || !IVAS_PASSWORD) {
        console.log('⚠️ No IVAS_EMAIL/IVAS_PASSWORD in .env — skipping auto login');
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

        if (!hasForm) {
            console.log('⚠️ Login form not visible');
            return false;
        }

        // Fill email
        await pg.click('input[type="email"], input[name="email"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_EMAIL, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        // Fill password
        await pg.click('input[type="password"], input[name="password"]', { clickCount: 3 });
        await pg.keyboard.type(IVAS_PASSWORD, { delay: 60 });
        await new Promise(r => setTimeout(r, 400));

        console.log('📝 Credentials entered — clicking Log in...');

       // Click login button
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
            console.log('❌ Still on login page. Error:', error);
            return false;
        }

        console.log('✅ Auto-login successful!');
        return true;

    } catch (err) {
        console.error('❌ Login error:', err.message);
        return false;
    }
}

async function initBrowser() {
    try {
        console.log('🚀 Launching Puppeteer Real Browser...');

        if (browser) { try { await browser.close(); } catch (e) {} browser = null; page = null; }

        const { connect } = require('puppeteer-real-browser');

        const { browser: rb, page: rp } = await connect({
            headless: true,
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
            customConfig: {},
            turnstile: true,
            connectOption: { defaultViewport: null },
            disableXvfb: false,   // true for Windows, false for Linux
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

        // Wait for CF to auto-solve (turnstile:true handles it)
        await new Promise(r => setTimeout(r, 5000));

        // Check if logged in
        let isLoggedIn = await page.evaluate(() =>
            !!(document.querySelector('.user-panel') &&
               (document.querySelector('#spa-content') || document.querySelector('.content-wrapper')) &&
               window.location.href.includes('/portal'))
        ).catch(() => false);

        // Not logged in — try auto login
        if (!isLoggedIn) {
            console.log('🔒 Not logged in, trying auto login...');
            const loginOk = await doLogin(page);

            if (loginOk) {
                await page.goto(BASE_URL + '/portal', { waitUntil: 'networkidle2', timeout: 30000 });
                await new Promise(r => setTimeout(r, 3000));

                isLoggedIn = await page.evaluate(() =>
                    !!(document.querySelector('.user-panel') && window.location.href.includes('/portal'))
                ).catch(() => false);
            }

            // Wait for manual login if auto failed
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

        // Get CSRF token
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
        console.log('✅ CSRF token extracted, session ready!');

        // Close browser — HTTP takes over
        await new Promise(r => setTimeout(r, 500));
        try { await browser.close(); } catch (e) {}
        browser = null;
        page = null;
        console.log('🔒 Browser closed — switching to HTTP mode');

        return true;

    } catch (err) {
        console.error('❌ Browser init error:', err.message);
        sessionValid = false;
        return false;
    }
}

function setSessionCookies(cookies) {
    sessionCookies = cookies;
    saveCookies(cookies);
    csrfToken = null;
    sessionValid = false;
}

function setCsrfToken(token) { csrfToken = token; }

module.exports = {
    initBrowser, loadCookies, saveCookies,
    getCookies, getCsrfToken, setCsrfToken,
    isSessionValid, getCookieHeader, setSessionCookies,
};