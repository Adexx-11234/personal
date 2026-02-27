const cheerio = require('cheerio');
const fs = require('fs');

const {
    NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE, NUMBERS_CACHE_TTL, NUMBERS_PAGE_URL,
    extractOTP, extractService, extractCountry, getCountryEmoji, getDateRange,
} = require('./config');

const { getCsrfToken, getPage, isPageReady, ensureOnSmsPage } = require('./browser');

// ============================================================
// CORE: run fetch inside browser page context
// This avoids 403 because requests come FROM the browser
// with all real CF cookies and headers already attached
// ============================================================
async function pagePost(path, formData) {
    const page = getPage();
    if (!page) throw new Error('No browser page available');

    const token = getCsrfToken();
    if (!token) throw new Error('No CSRF token');

    const result = await page.evaluate(async (path, formData, token) => {
        const body = new URLSearchParams({ _token: token, ...formData });
        const res = await fetch(path, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
            },
            body: body.toString(),
            credentials: 'include',
        });
        return { status: res.status, text: await res.text() };
    }, path, formData, token);

    if (result.status === 403) throw new Error('403 Forbidden — session may have expired');
    if (result.status === 419) throw new Error('419 CSRF mismatch — token expired');

    return result.text;
}

async function pageGet(path) {
    const page = getPage();
    if (!page) throw new Error('No browser page available');

    const result = await page.evaluate(async (path) => {
        const res = await fetch(path, { credentials: 'include' });
        return { status: res.status, text: await res.text() };
    }, path);

    if (result.status === 403) throw new Error('403 Forbidden');
    return result.text;
}

// ============================================================
// SEMAPHORE — prevent concurrent page navigation
// ============================================================
let pageLock = false;
let pageLockQueue = [];

async function withPageLock(fn) {
    if (pageLock) {
        await new Promise(resolve => pageLockQueue.push(resolve));
    }
    pageLock = true;
    try {
        return await fn();
    } finally {
        pageLock = false;
        if (pageLockQueue.length > 0) {
            const next = pageLockQueue.shift();
            next();
        }
    }
}

// ============================================================
// FETCH SMS RANGES
// ============================================================
async function fetchSmsRanges() {
    return withPageLock(async () => {
        try {
            await ensureOnSmsPage();
            const { from, to } = getDateRange();

            // Fill date inputs and click Get SMS button via page
            const page = getPage();
            await page.evaluate((from, to) => {
                const startInput = document.querySelector('#start_date');
                const endInput = document.querySelector('#end_date');
                if (startInput) { startInput.value = from; startInput.dispatchEvent(new Event('change')); }
                if (endInput) { endInput.value = to; endInput.dispatchEvent(new Event('change')); }
            }, from, to);

            await new Promise(r => setTimeout(r, 500));

            // Click Get SMS button
            await page.evaluate(() => {
                const btn = document.querySelector('button[onclick*="GetSMS"]');
                if (btn) btn.click();
            });

            await new Promise(r => setTimeout(r, 3000));

            // Refresh CSRF token after action
            const newToken = await page.evaluate(() => {
                const meta = document.querySelector('meta[name="csrf-token"]');
                return meta ? meta.getAttribute('content') : null;
            });
            if (newToken) {
                const { setCsrfToken } = require('./browser');
                setCsrfToken(newToken);
            }

            const html = await page.content();
            const $ = cheerio.load(html);
            const ranges = [];

            // Card-based layout
            $('.card.card-body.mb-1.pointer').each((i, elem) => {
                const onclick = $(elem).attr('onclick');
                const match = onclick?.match(/getDetials\('([^']+)'\)/);
                if (match && !ranges.includes(match[1])) ranges.push(match[1]);
            });

            // Table-based fallback
            if (ranges.length === 0) {
                $('table tbody tr').each((i, row) => {
                    const cell = $(row).find('td').first().text().trim();
                    if (cell && /^[A-Z]/.test(cell) && cell.includes(' ') && !/^\d/.test(cell)) {
                        if (!ranges.includes(cell)) ranges.push(cell);
                    }
                });
            }

            console.log(`✅ Found ${ranges.length} ranges`);
            return ranges;

        } catch (err) {
            console.error('Error fetching ranges:', err.message);
            return [];
        }
    });
}

// ============================================================
// FETCH NUMBERS FOR RANGE (via fetch() in browser context)
// ============================================================
async function fetchNumbersForRange(rangeName) {
    try {
        const { to } = getDateRange();
        const html = await pagePost('/portal/sms/received/getsms/number', {
            start: '', end: to, range: rangeName,
        });

        const $ = cheerio.load(html);
        const numbers = [];

        $('.card.card-body.border-bottom.bg-100.p-2.rounded-0').each((i, elem) => {
            const onclick = $(elem).find('.col').first().attr('onclick');
            const match = onclick?.match(/'([^']+)'/);
            if (match) numbers.push(match[1]);
        });

        if (numbers.length === 0) {
            $('table tbody tr').each((i, row) => {
                const cell = $(row).find('td').first().text().trim();
                if (/^\d{7,15}$/.test(cell)) numbers.push(cell);
            });
        }

        return numbers;

    } catch (err) {
        console.error(`Error fetching numbers for ${rangeName}:`, err.message);
        return [];
    }
}

// ============================================================
// FETCH SMS FOR NUMBER (via fetch() in browser context)
// ============================================================
async function fetchSmsForNumber(number, rangeName) {
    try {
        const { to } = getDateRange();
        const html = await pagePost('/portal/sms/received/getsms/number/sms', {
            start: '', end: to, Number: number, Range: rangeName,
        });

        const $ = cheerio.load(html);
        const messages = [];

        const selectors = [
            '.col-9.col-sm-6.text-center.text-sm-start p',
            '.sms-message',
            'table tbody tr td:nth-child(3)',
            '.message-content p',
            'p',
        ];

        for (const sel of selectors) {
            $(sel).each((i, elem) => {
                const text = $(elem).text().trim();
                if (text && text.length > 5) messages.push(text);
            });
            if (messages.length > 0) break;
        }

        return messages;

    } catch (err) {
        console.error(`Error fetching SMS for ${number}:`, err.message);
        return [];
    }
}

// ============================================================
// FETCH ALL SMS — ranges parallel, SMS parallel
// ============================================================
async function fetchAllSms() {
    const messages = [];
    if (!isPageReady()) { console.log('⚠️ Page not ready'); return []; }

    try {
        const ranges = await fetchSmsRanges();
        if (ranges.length === 0) return [];

        await detectNewRanges(ranges);

        // Fetch numbers for all ranges in parallel (using browser fetch, safe)
        const rangeResults = await Promise.all(
            ranges.map(async (rangeName) => {
                try {
                    const numbers = await fetchNumbersForRange(rangeName);
                    return { rangeName, numbers };
                } catch (e) { return { rangeName, numbers: [] }; }
            })
        );

        // Fetch SMS for all numbers in parallel
        const smsJobs = [];
        for (const { rangeName, numbers } of rangeResults) {
            const country = extractCountry(rangeName);
            const countryEmoji = getCountryEmoji(country);
            for (const number of numbers) {
                smsJobs.push(
                    fetchSmsForNumber(number, rangeName)
                        .then(smsList => ({ number, rangeName, country, countryEmoji, smsList }))
                        .catch(() => ({ number, rangeName, country, countryEmoji, smsList: [] }))
                );
            }
        }

        const smsResults = await Promise.all(smsJobs);

        for (const { number, rangeName, country, countryEmoji, smsList } of smsResults) {
            for (const smsText of smsList) {
                const otp = extractOTP(smsText);
                if (!otp) continue;
                const service = extractService(smsText);
                const msgId = `${number}_${otp}_${smsText.substring(0, 30)}`;
                messages.push({
                    id: msgId, phone: number, otp, service,
                    message: smsText, timestamp: new Date().toISOString(),
                    country: `${countryEmoji} ${country}`, range: rangeName,
                });
            }
        }

    } catch (err) {
        console.error('Error in fetchAllSms:', err.message);
    }

    return messages;
}

// ============================================================
// GET MY NUMBERS (with pagination, via page navigation)
// ============================================================
async function getMyNumbers(forceRefresh = false) {
    try {
        if (!forceRefresh && fs.existsSync(NUMBERS_CACHE_FILE)) {
            const cache = JSON.parse(fs.readFileSync(NUMBERS_CACHE_FILE, 'utf8'));
            if (Date.now() - cache.timestamp < NUMBERS_CACHE_TTL) {
                console.log(`✅ Using cached numbers (${cache.numbers.length})`);
                return cache.numbers;
            }
        }
    } catch (e) {}

    return withPageLock(async () => {
        console.log('📥 Fetching numbers from portal...');
        const page = getPage();
        if (!page) return [];

        const allNumbers = [];

        try {
            await page.goto(NUMBERS_PAGE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await new Promise(r => setTimeout(r, 2000));

            // Set table to show 100 per page
            try {
                await page.select('select[name*="length"]', '100');
                await new Promise(r => setTimeout(r, 1500));
            } catch (e) {}

            async function scrapePage() {
                const html = await page.content();
                const $ = cheerio.load(html);
                $('table tbody tr').each((i, row) => {
                    const cells = [];
                    $(row).find('td').each((j, cell) => cells.push($(cell).text().trim()));
                    // cells[0]=checkbox, cells[1]=Number, cells[2]=Range
                    if (cells.length >= 3 && /^\d{7,15}$/.test(cells[1]) && cells[2]?.trim()) {
                        allNumbers.push([cells[1].trim(), cells[2].trim()]);
                    }
                });
            }

            await scrapePage();
            console.log(`📄 Page 1: ${allNumbers.length} numbers`);

            // Paginate
            let pageNum = 1;
            while (pageNum < 20) {
                const nextDisabled = await page.$('#MyNumber_next.disabled');
                if (nextDisabled) break;
                const nextBtn = await page.$('#MyNumber_next');
                if (!nextBtn) break;
                await nextBtn.click();
                await new Promise(r => setTimeout(r, 1500));
                await scrapePage();
                pageNum++;
                console.log(`📄 Page ${pageNum}: ${allNumbers.length} total`);
            }

        } catch (err) {
            console.error('Error fetching numbers page:', err.message);
        }

        // Navigate back to SMS page
        await page.goto(require('./config').PORTAL_URL, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

        if (allNumbers.length > 0) {
            fs.writeFileSync(NUMBERS_CACHE_FILE, JSON.stringify({ timestamp: Date.now(), numbers: allNumbers }, null, 2));
            console.log(`✅ Cached ${allNumbers.length} numbers`);
        }

        return allNumbers;
    });
}

// ============================================================
// GET COUNTRY RANGES
// ============================================================
async function getCountryRanges(forceRefresh = false) {
    const numbers = await getMyNumbers(forceRefresh);
    const ranges = {};
    for (const row of numbers) {
        if (row.length >= 2 && row[1] && !ranges[row[1]]) ranges[row[1]] = row[0];
    }
    return ranges;
}

// ============================================================
// GET NUMBERS BY RANGE (for admin txt files)
// ============================================================
async function getNumbersByRange() {
    const numbers = await getMyNumbers(true);
    const grouped = {};
    for (const [num, range] of numbers) {
        if (!grouped[range]) grouped[range] = [];
        grouped[range].push(num);
    }
    return grouped;
}

// ============================================================
// NEW RANGE DETECTION
// ============================================================
async function detectNewRanges(currentRanges) {
    try {
        let known = [];
        if (fs.existsSync(KNOWN_RANGES_FILE)) known = JSON.parse(fs.readFileSync(KNOWN_RANGES_FILE, 'utf8'));
        const newRanges = currentRanges.filter(r => !known.includes(r));
        if (newRanges.length > 0 || known.length === 0) {
            fs.writeFileSync(KNOWN_RANGES_FILE, JSON.stringify([...new Set([...known, ...currentRanges])], null, 2));
        }
        return newRanges;
    } catch (e) { return []; }
}

module.exports = {
    fetchSmsRanges, fetchNumbersForRange, fetchSmsForNumber,
    fetchAllSms, getMyNumbers, getCountryRanges,
    getNumbersByRange, detectNewRanges,
};
