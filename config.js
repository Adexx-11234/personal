require('dotenv').config();

// ============================================================
// ENVIRONMENT
// ============================================================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GROUP_ID = process.env.TELEGRAM_GROUP_ID;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme123';
const CHANNEL_LINK = process.env.CHANNEL_LINK || 'https://t.me/yourchannel';
const DEV_LINK = process.env.DEV_LINK || 'https://t.me/yourdev';
const PORT = process.env.PORT || 5000;

// ============================================================
// ADMIN IDs (can add more)
// ============================================================
const ADMIN_IDS = [1774315698];

// ============================================================
// URLS
// ============================================================
const BASE_URL = 'https://www.ivasms.com';
const PORTAL_URL = `${BASE_URL}/portal/sms/received`;
const NUMBERS_PAGE_URL = `${BASE_URL}/portal/numbers`;

// ============================================================
// FILE PATHS
// ============================================================
const path = require('path');
const COOKIES_FILE = path.join(__dirname, 'cookies.json');
const OTP_HISTORY_FILE = path.join(__dirname, 'otp_history.json');
const NUMBERS_CACHE_FILE = path.join(__dirname, 'numbers_cache.json');
const KNOWN_RANGES_FILE = path.join(__dirname, 'known_ranges.json');

// ============================================================
// TIMING
// ============================================================
const OTP_CHECK_INTERVAL = 10000;       // 10 seconds
const NUMBERS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const DATE_RANGE_DAYS_BACK = 7;          // How many days back to fetch SMS

// ============================================================
// SERVICE DETECTION PATTERNS
// ============================================================
const SERVICE_PATTERNS = {
    WhatsApp:  /whatsapp|wa\.me|verify|wassap|whtsapp/i,
    Facebook:  /facebook|fb\.me|fb\-|meta/i,
    Telegram:  /telegram|t\.me|tg|telegrambot/i,
    Google:    /google|gmail|goog|g\.co|accounts\.google/i,
    Twitter:   /twitter|x\.com|twtr/i,
    Instagram: /instagram|insta|ig/i,
    Apple:     /apple|icloud|appleid/i,
    Amazon:    /amazon|amzn/i,
    Microsoft: /microsoft|msft|outlook|hotmail/i,
    PayPal:    /paypal/i,
    Netflix:   /netflix/i,
    Uber:      /uber/i,
    TikTok:    /tiktok/i,
    LinkedIn:  /linkedin/i,
    Spotify:   /spotify/i,
    Lalamove:  /lalamove/i,
};

// ============================================================
// COUNTRY FLAGS
// ============================================================
const COUNTRY_FLAGS = {
    'Nigeria':     '🇳🇬', 'Benin':      '🇧🇯', 'Ghana':      '🇬🇭',
    'Kenya':       '🇰🇪', 'USA':        '🇺🇸', 'UK':         '🇬🇧',
    'France':      '🇫🇷', 'Germany':    '🇩🇪', 'India':      '🇮🇳',
    'China':       '🇨🇳', 'Brazil':     '🇧🇷', 'Canada':     '🇨🇦',
    'Ivory':       '🇨🇮', 'Cote':       '🇨🇮', "Cote d'Ivoire": '🇨🇮',
    'Algeria':     '🇩🇿', 'Madagascar': '🇲🇬', 'Senegal':    '🇸🇳',
    'Cameroon':    '🇨🇲', 'Tanzania':   '🇹🇿', 'Uganda':     '🇺🇬',
    'Ethiopia':    '🇪🇹', 'Egypt':      '🇪🇬', 'Morocco':    '🇲🇦',
    'Russia':      '🇷🇺', 'Ukraine':    '🇺🇦', 'Poland':     '🇵🇱',
    'Indonesia':   '🇮🇩', 'Philippines':'🇵🇭', 'Vietnam':    '🇻🇳',
    'Thailand':    '🇹🇭', 'Malaysia':   '🇲🇾', 'Pakistan':   '🇵🇰',
    'Bangladesh':  '🇧🇩', 'Mexico':     '🇲🇽', 'Colombia':   '🇨🇴',
    'Argentina':   '🇦🇷', 'Chile':      '🇨🇱', 'Peru':       '🇵🇪',
    'Venezuela':   '🇻🇪', 'South Africa':'🇿🇦','Sudan':      '🇸🇩',
    'Mozambique':  '🇲🇿', 'Angola':     '🇦🇴', 'Zimbabwe':   '🇿🇼',
    'Zambia':      '🇿🇲', 'Rwanda':     '🇷🇼', 'Malawi':     '🇲🇼',
    'Togo':        '🇹🇬', 'Mali':       '🇲🇱', 'Niger':      '🇳🇪',
    'Burkina':     '🇧🇫', 'Guinea':     '🇬🇳', 'Gabon':      '🇬🇦',
    'Congo':       '🇨🇬', 'Chad':       '🇹🇩', 'Somalia':    '🇸🇴',
    'Libya':       '🇱🇾', 'Tunisia':    '🇹🇳', 'Saudi':      '🇸🇦',
    'UAE':         '🇦🇪', 'Iraq':       '🇮🇶', 'Iran':       '🇮🇷',
    'Turkey':      '🇹🇷', 'Israel':     '🇮🇱', 'Jordan':     '🇯🇴',
    'Lebanon':     '🇱🇧', 'Syria':      '🇸🇾', 'Yemen':      '🇾🇪',
    'Afghanistan': '🇦🇫', 'Nepal':      '🇳🇵', 'Myanmar':    '🇲🇲',
    'Cambodia':    '🇰🇭', 'Sri Lanka':  '🇱🇰', 'Taiwan':     '🇹🇼',
    'South Korea': '🇰🇷', 'Japan':      '🇯🇵', 'Australia':  '🇦🇺',
    'New Zealand': '🇳🇿', 'Spain':      '🇪🇸', 'Italy':      '🇮🇹',
    'Portugal':    '🇵🇹', 'Netherlands':'🇳🇱', 'Belgium':    '🇧🇪',
    'Sweden':      '🇸🇪', 'Norway':     '🇳🇴', 'Denmark':    '🇩🇰',
    'Finland':     '🇫🇮', 'Switzerland':'🇨🇭', 'Austria':    '🇦🇹',
    'Romania':     '🇷🇴', 'Hungary':    '🇭🇺', 'Czech':      '🇨🇿',
    'Slovakia':    '🇸🇰', 'Bulgaria':   '🇧🇬', 'Serbia':     '🇷🇸',
    'Croatia':     '🇭🇷', 'Greece':     '🇬🇷', 'Bolivia':    '🇧🇴',
    'Ecuador':     '🇪🇨', 'Paraguay':   '🇵🇾', 'Uruguay':    '🇺🇾',
    'Cuba':        '🇨🇺', 'Haiti':      '🇭🇹', 'Dominican':  '🇩🇴',
    'Guatemala':   '🇬🇹', 'Honduras':   '🇭🇳', 'Nicaragua':  '🇳🇮',
    'Costa':       '🇨🇷', 'Panama':     '🇵🇦', 'Jamaica':    '🇯🇲',
};

// ============================================================
// HELPERS
// ============================================================
function extractCountry(rangeName) {
    if (!rangeName) return 'Unknown';
    return rangeName.trim().split(' ')[0] || 'Unknown';
}

function getCountryEmoji(countryName) {
    for (const [key, emoji] of Object.entries(COUNTRY_FLAGS)) {
        if (countryName.toLowerCase().includes(key.toLowerCase())) return emoji;
    }
    return '🌍';
}

function extractService(message) {
    for (const [service, pattern] of Object.entries(SERVICE_PATTERNS)) {
        if (pattern.test(message)) return service;
    }
    return 'Unknown';
}

function extractOTP(text) {
    const match = text.match(/\b(\d{4,8})\b/);
    return match ? match[1] : null;
}

function isAdmin(userId) {
    return ADMIN_IDS.includes(Number(userId));
}

function getDateRange() {
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - DATE_RANGE_DAYS_BACK);
    const end = new Date(today);
    end.setDate(end.getDate() + 1);
    return {
        from: start.toISOString().split('T')[0],
        to: end.toISOString().split('T')[0],
    };
}

module.exports = {
    BOT_TOKEN, GROUP_ID, ADMIN_PASSWORD, CHANNEL_LINK, DEV_LINK, PORT,
    ADMIN_IDS, BASE_URL, PORTAL_URL, NUMBERS_PAGE_URL,
    COOKIES_FILE, OTP_HISTORY_FILE, NUMBERS_CACHE_FILE, KNOWN_RANGES_FILE,
    OTP_CHECK_INTERVAL, NUMBERS_CACHE_TTL,
    SERVICE_PATTERNS, COUNTRY_FLAGS,
    extractCountry, getCountryEmoji, extractService, extractOTP, isAdmin, getDateRange,
};