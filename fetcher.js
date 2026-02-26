const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

const {
    BASE_URL, PORTAL_URL, NUMBERS_PAGE_URL,
    NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE, NUMBERS_CACHE_TTL,
    extractOTP, extractService, extractCountry, getCountryEmoji, getDateRange,
} = require('./config');

const { getCsrfToken, getCookieHeader } = require('./browser');

// ============================================================
// HTTP CLIENT (reused across all requests)
// ============================================================
function makeAxios() {
    const cookieHeader = getCookieHeader();
    return axios.create({
        baseURL: BASE_URL,
        timeout: 30000,
        headers: {
            'Cookie': cookieHeader,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': PORTAL_URL,
            'Origin': BASE_URL,
        },
    });
}

function buildForm(extra = {}) {
    const params = new URLSearchParams();
    params.set('_token', getCsrfToken());
    for (const [k, v] of Object.entries(extra)) params.set(k, v);
    return params.toString();
}

// ============================================================
// FETCH SMS RANGES (click Get SMS equivalent)
// ============================================================
async function fetchSmsRanges() {
    try {
        const { from, to } = getDateRange();
        const http = makeAxios();

        const res = await http.post('/portal/sms/received/getsms', buildForm({ from, to }));
        const $ = cheerio.load(res.data);
        const ranges = [];

        // Card-based layout
        $('.card.card-body.mb-1.pointer').each((i, elem) => {
            const onclick = $(elem).attr('onclick');
            const match = onclick?.match(/getDetials\('([^']+)'\)/);
            if (match && !ranges.includes(match[1])) ranges.push(match[1]);
        });

        // Table-based layout fallback
        if (ranges.length === 0) {
            $('table tbody tr').each((i, row) => {
                const firstCell = $(row).find('td').first().text().trim();
                if (firstCell && /^[A-Z]/.test(firstCell) && firstCell.includes(' ') && !/^\d{7,15}$/.test(firstCell)) {
                    if (!ranges.includes(firstCell)) ranges.push(firstCell);
                }
            });
        }

        console.log(`✅ Found ${ranges.length} ranges`);
        return ranges;

    } catch (err) {
        console.error('Error fetching ranges:', err.message);
        return [];
    }
}

// ============================================================
// FETCH NUMBERS FOR A RANGE
// ============================================================
async function fetchNumbersForRange(rangeName) {
    try {
        const { to } = getDateRange();
        const http = makeAxios();

        const res = await http.post('/portal/sms/received/getsms/number',
            buildForm({ start: '', end: to, range: rangeName })
        );

        const $ = cheerio.load(res.data);
        const numbers = [];

        $('.card.card-body.border-bottom.bg-100.p-2.rounded-0').each((i, elem) => {
            const onclick = $(elem).find('.col').first().attr('onclick');
            const match = onclick?.match(/'([^']+)'/);
            if (match) numbers.push(match[1]);
        });

        // Fallback: table rows
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
// FETCH SMS FOR A NUMBER
// ============================================================
async function fetchSmsForNumber(number, rangeName) {
    try {
        const { to } = getDateRange();
        const http = makeAxios();

        const res = await http.post('/portal/sms/received/getsms/number/sms',
            buildForm({ start: '', end: to, Number: number, Range: rangeName })
        );

        const $ = cheerio.load(res.data);
        const messages = [];

        // Try multiple selectors
        const selectors = [
            '.col-9.col-sm-6.text-center.text-sm-start p',
            '.sms-message',
            'table tbody tr td:nth-child(3)',
            '.message-content',
        ];

        for (const sel of selectors) {
            $(sel).each((i, elem) => {
                const text = $(elem).text().trim();
                if (text && text.length > 3) messages.push(text);
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
// PARALLEL: FETCH ALL SMS ACROSS ALL RANGES
// ============================================================
async function fetchAllSms() {
    const messages = [];

    try {
        const ranges = await fetchSmsRanges();
        if (ranges.length === 0) return [];

        // Check for new ranges
        await detectNewRanges(ranges);

        // Fetch numbers for ALL ranges in parallel
        const rangeResults = await Promise.all(
            ranges.map(async (rangeName) => {
                try {
                    const numbers = await fetchNumbersForRange(rangeName);
                    return { rangeName, numbers };
                } catch (e) {
                    return { rangeName, numbers: [] };
                }
            })
        );

        // For each range, fetch SMS for all numbers in parallel
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
                    id: msgId,
                    phone: number,
                    otp,
                    service,
                    message: smsText,
                    timestamp: new Date().toISOString(),
                    country: `${countryEmoji} ${country}`,
                    range: rangeName,
                });
            }
        }

    } catch (err) {
        console.error('Error in fetchAllSms:', err.message);
    }

    return messages;
}

// ============================================================
// GET MY NUMBERS (numbers page with pagination)
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

    console.log('📥 Fetching numbers via HTTP...');
    const http = makeAxios();
    const allNumbers = [];

    try {
        // Fetch with large page size via DataTables AJAX
        const res = await http.get('/portal/numbers', {
            params: { draw: 1, start: 0, length: 500 },
            headers: { 'Accept': 'application/json, text/javascript, */*' }
        });

        // Try JSON response first (DataTables)
        if (res.data && res.data.data) {
            for (const row of res.data.data) {
                const num = row[1]?.replace(/<[^>]+>/g, '').trim();
                const range = row[2]?.replace(/<[^>]+>/g, '').trim();
                if (num && range && /^\d{7,15}$/.test(num)) {
                    allNumbers.push([num, range]);
                }
            }
        }

        // Fallback: parse HTML table
        if (allNumbers.length === 0) {
            const $ = cheerio.load(res.data);
            $('table tbody tr').each((i, row) => {
                const cells = [];
                $(row).find('td').each((j, cell) => cells.push($(cell).text().trim()));
                // cells[0]=checkbox, cells[1]=Number, cells[2]=Range
                if (cells.length >= 3 && /^\d{7,15}$/.test(cells[1]) && cells[2].trim()) {
                    allNumbers.push([cells[1].trim(), cells[2].trim()]);
                }
            });
        }

    } catch (err) {
        console.error('Error fetching numbers page:', err.message);
    }

    if (allNumbers.length > 0) {
        fs.writeFileSync(NUMBERS_CACHE_FILE, JSON.stringify({
            timestamp: Date.now(),
            numbers: allNumbers,
        }, null, 2));
        console.log(`✅ Cached ${allNumbers.length} numbers`);
    } else {
        console.log('⚠️ No numbers found');
    }

    return allNumbers;
}

// ============================================================
// GET COUNTRY RANGES (unique ranges from numbers)
// ============================================================
async function getCountryRanges(forceRefresh = false) {
    const numbers = await getMyNumbers(forceRefresh);
    const ranges = {};
    for (const row of numbers) {
        if (row.length >= 2 && row[1] && !ranges[row[1]]) {
            ranges[row[1]] = row[0];
        }
    }
    return ranges;
}

// ============================================================
// GET NUMBERS FOR ADMIN (group by range, return txt content)
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
        let knownRanges = [];
        if (fs.existsSync(KNOWN_RANGES_FILE)) {
            knownRanges = JSON.parse(fs.readFileSync(KNOWN_RANGES_FILE, 'utf8'));
        }

        const newRanges = currentRanges.filter(r => !knownRanges.includes(r));

        if (newRanges.length > 0) {
            // Save updated list
            fs.writeFileSync(KNOWN_RANGES_FILE, JSON.stringify([...knownRanges, ...newRanges], null, 2));
            console.log(`🆕 New ranges detected: ${newRanges.join(', ')}`);
            return newRanges;
        }

        // Update known ranges if this is the first run
        if (knownRanges.length === 0) {
            fs.writeFileSync(KNOWN_RANGES_FILE, JSON.stringify(currentRanges, null, 2));
        }

        return [];

    } catch (e) {
        return [];
    }
}

module.exports = {
    fetchSmsRanges,
    fetchNumbersForRange,
    fetchSmsForNumber,
    fetchAllSms,
    getMyNumbers,
    getCountryRanges,
    getNumbersByRange,
    detectNewRanges,
};