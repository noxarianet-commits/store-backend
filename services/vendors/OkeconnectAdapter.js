const VendorAdapter = require('./VendorAdapter');
const axios = require('axios');
const EventEmitter = require('events');
const cacheService = require('../cacheService');
const { normalizePhoneNumber } = require('../../utils/phoneUtils');
const { logger } = require('../../utils/logger');
const { parseBillInquiry } = require('../billInquiryParser');

const okeLog = logger.child({ job: 'okeconnect' });

/**
 * Promise-based delay used for retry backoff.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper to slugify text for external_id generation.
 */
function slugify(text) {
    return text
        .toString()
        .toLowerCase()
        .trim()
        .replace(/\s+/g, '-')
        .replace(/[^\w\-]+/g, '')
        .replace(/\-\-+/g, '-');
}

/**
 * Helper to extract SN from OkeConnect response/callback message.
 * Handles single codes as well as full formatted strings with spaces and slashes (e.g. DNID NAME/1000/REF or NOMOR:.../NAMA:.../LIMIT:...).
 */
function extractSN(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/SN:\s*([^\n\r]+?)(?:\.\s*Saldo|\s*@\d{2}\/\d{2}|\s*@\d{2}:\d{2}|\s*R#|$|\.\s*$)/i);
    if (match) {
        return match[1].trim().replace(/\.$/, '');
    }
    return null;
}

/**
 * Helper to extract customer name / player nickname from OkeConnect inquiry response/SN.
 */
function extractCustomerName(text, fallback = '') {
    if (!text || typeof text !== 'string') return fallback;

    const sn = extractSN(text) || text;

    // 1. Format NOMOR:.../NAMA:XYZ/LIMIT:... or /NAMA:XYZ/ or NAMA:XYZ
    const slashNameMatch = sn.match(/(?:^|\/)(?:NAMA|NAME|NICKNAME)\s*[:=]\s*([^/,\n\r]+)/i);
    if (slashNameMatch) {
        return slashNameMatch[1].trim();
    }

    // 2. Format a/n XYZ or Nama: XYZ or Nickname: XYZ
    const nameMatch = text.match(/(?:Nama|NAMA|Name|A\/N|a\/n|A\.N|a\.n|Nickname|NICKNAME|\bAn\b|\ban\b)\s*[:=.]?\s*([^/.,\n\r]+)/i);
    if (nameMatch) {
        return nameMatch[1].replace(/^(?:a\/n|a\.n|\ban\b|nama|name|nickname)\s*[:=.]?\s*/i, '').trim();
    }

    // 3. Format SUKSES. XYZ. Saldo
    const suksesMatch = text.match(/SUKSES\.\s*([^.]+)\./i);
    if (suksesMatch && !suksesMatch[1].toLowerCase().includes('saldo') && !suksesMatch[1].toLowerCase().includes('sn:')) {
        return suksesMatch[1].replace(/^(?:a\/n|a\.n|\ban\b|nama|name|nickname)\s*[:=.]?\s*/i, '').trim();
    }

    return fallback;
}

/**
 * Helper to extract failure error reason from OkeConnect response (e.g. PAYEE_USER_STATUS_DISABLE).
 */
function extractErrorMessage(text) {
    if (!text || typeof text !== 'string') return 'Validasi akun gagal';
    const match = text.match(/GAGAL[.:\s]+([^\n\r]+?)(?:\.\s*Saldo|\s*@\d{2}\/\d{2}|\s*@\d{2}:\d{2}|$|\.\s*$)/i);
    if (match) {
        return match[1].trim().replace(/\.$/, '');
    }
    return text.trim();
}

/**
 * Helper to parse status and serial number (SN) from OkeConnect plain text response.
 */
function parseStatusAndSn(text) {
    if (!text || typeof text !== 'string') {
        return { status: 'unknown', sn: null, message: '' };
    }

    const trimmed = text.trim();

    let status = 'pending';
    if (/status\s+Sukses/i.test(trimmed) || /\bSUKSES\b/i.test(trimmed)) {
        status = 'success';
    } else if (/status\s+Gagal/i.test(trimmed) || /\bGAGAL\b/i.test(trimmed) || /TIDAK ADA transaksi/i.test(trimmed)) {
        status = 'failed';
    } else if (/Menunggu Jawaban/i.test(trimmed) || /akan diproses/i.test(trimmed) || /\bPENDING\b/i.test(trimmed)) {
        status = 'pending';
    }

    const sn = extractSN(trimmed);

    return { status, sn, message: trimmed };
}



/**
 * Mapping of inquiry (Cek ID) codes in OkeConnect for pre-checkout account validation.
 */
const INQUIRY_CODE_MAP = {
    // Games
    'mobile-legends': 'CEKML',
    'mobile legend': 'CEKML',
    'magic chess': 'CEKML',
    'ml': 'CEKML',
    'free-fire': 'CEKFF',
    'free fire': 'CEKFF',
    'ff': 'CEKFF',
    'arena-of-valor': 'CEKAOV',
    'arena of valor': 'CEKAOV',
    'aov': 'CEKAOV',
    'call-of-duty': 'CEKCODM',
    'call of duty': 'CEKCODM',
    'codm': 'CEKCODM',
    'honor of kings': 'CEKHOK',
    'honor of king': 'CEKHOK',
    'hok': 'CEKHOK',
    'point-blank': 'CEKPB',
    'point blank': 'CEKPB',
    'pb': 'CEKPB',
    'genshin': 'CEKGI',
    'genshin impact': 'CEKGI',
    'honkai': 'CEKHSR',
    'honkai star rail': 'CEKHSR',
    'valorant': 'CEKVALO',
    'pubg': 'CEKPUBG',

    // E-Wallets
    'dana': 'CEKD',
    'ovo': 'CEKOVO',
    'gopay': 'CEKGJK',
    'gojek': 'CEKGJK',
    'go-jek': 'CEKGJK',
    'shopee': 'CEKSHP',
    'shopeepay': 'CEKSHP',
    'linkaja': 'CEKLINK',
    'link aja': 'CEKLINK',
    'grab': 'CEKGRB',
    'isaku': 'CEKISAKU',
    'i.saku': 'CEKISAKU',
    'maxim': 'CEKMAXIM',
    'astrapay': 'CEKASTRA',
    'kaspro': 'CEKKASPRO',
    'pln': 'CEKPLN',
};


// ── PLN prepaid token helpers ──────────────────────────────────────────────

// The vendor sells prepaid electricity tokens (PLNxxx codes) in their own
// price-list category. The same nominal is sold through several H2H routes at
// different prices, so every route becomes a variant of one product.
const PLN_TOKEN_CATEGORY = 'TOKEN PLN';
const PLN_TOKEN_PRODUCT_ID = 'okc-token-pln';
const PLN_TOKEN_PRODUCT_NAME = 'Token PLN (OkeConnect)';
const PLN_TOKEN_CATEGORY_NAME = 'Token PLN';
const PLN_TOKEN_BRAND = 'PLN';

// Price-list slug of the token category, appended to the prepaid slug list.
const PLN_PRICE_LIST_CATEGORY = 'token_pln';

// Price-list slugs of the prepaid catalog: e-wallet, digital topups and the
// PLN token category.
const PRICE_LIST_CATEGORIES = `saldo_gojek,digital,${PLN_PRICE_LIST_CATEGORY}`;

// Short route labels per vendor group. Unknown groups fall back to a cleaned
// version of the group name.
const PLN_TOKEN_ROUTE_LABELS = {
    'Token PLN Prabayar': 'Reguler',
    'H2H Token PLN Terbaik': 'H2H Terbaik',
    'H2H Token PLN Promo': 'Promo',
    'H2H Token PLN Full Reply': 'Full Reply',
    'H2H PLN PRODUK DIRECT': 'Direct',
    'H2H PLN RACIKAN': 'Racikan',
};

// Words that describe the route instead of the nominal.
const PLN_TOKEN_NOISE_WORDS = [
    'h2h', 'token', 'pln', 'promo', 'full', 'reply', 'terbaik',
    'produk', 'direct', 'racikan', 'biller', 'baru',
];

// The buyer identifies the customer by meter / customer number, never by a
// phone number. The value must reach the vendor exactly as typed, so it is
// marked as a meter target and never phone-normalized.
const PLN_TOKEN_REQUIRED_FIELDS = [
    {
        key: 'customer_id',
        label: 'No. Meter / ID Pelanggan',
        type: 'text',
        required: true,
        placeholder: 'Contoh: 51234567890',
    },
];

/**
 * Is this row part of the vendor token category?
 */
function isPlnTokenCategory(item) {
    return String(item?.kategori || '').trim().toUpperCase() === PLN_TOKEN_CATEGORY;
}

/**
 * Is this row an electricity token?
 *
 * The token category also holds e-money cards (Tapcash, BRIzzi, Flazz, Tol
 * Mandiri). Only groups that mention PLN are electricity tokens.
 */
function isPlnTokenItem(item) {
    if (!isPlnTokenCategory(item)) return false;
    return /\bpln\b/i.test(String(item?.produk || ''));
}

/**
 * Is this row an inquiry instead of a sellable token?
 *
 * The token group carries its own check product ("CPLN" - CEK NAMA ID
 * PELANGGAN). It is used to look up the customer name, never sold.
 */
function isPlnInquiryRow(item) {
    const description = String(item?.keterangan || '').trim();
    const code = String(item?.kode || '').trim();

    if (/^cek\b/i.test(description)) return true;
    // Sellable token codes are all prefixed with PLN.
    if (/^c/i.test(code)) return true;

    return false;
}

/**
 * Short route label of a token group, e.g. "H2H PLN RACIKAN" -> "Racikan".
 */
function plnRouteLabel(groupName) {
    const raw = String(groupName || '').trim();
    if (PLN_TOKEN_ROUTE_LABELS[raw]) return PLN_TOKEN_ROUTE_LABELS[raw];

    const cleaned = raw
        .replace(/^h2h\s+/i, '')
        .replace(/\btoken\b/gi, '')
        .replace(/\bpln\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();

    return cleaned || 'Token PLN';
}

/**
 * Extract the nominal from a token description.
 * "Token PLN 20.000" -> "20.000", "Promo Token PLN 20 Ribu" -> "20 Ribu".
 */
function plnDenomLabel(description) {
    const words = String(description || '').trim().split(/\s+/).filter(Boolean);
    const kept = words.filter(word => {
        const clean = word.toLowerCase().replace(/[.,]/g, '');
        return clean && !PLN_TOKEN_NOISE_WORDS.includes(clean);
    });

    return kept.join(' ').trim();
}

/**
 * Numeric value of a nominal label, used to sort variants by denomination.
 */
function plnDenomValue(label) {
    const text = String(label || '').trim().toLowerCase();
    const match = text.match(/[\d][\d.,]*/);
    if (!match) return 0;

    const digits = match[0].replace(/[^\d]/g, '');
    let value = digits ? parseInt(digits, 10) : 0;
    if (!Number.isFinite(value)) return 0;

    if (/\bjuta\b/.test(text)) value *= 1000000;
    else if (/\bribu\b/.test(text)) value *= 1000;

    return value;
}

/**
 * Extract the customer name from a CEKPLN inquiry response.
 * OkeConnect answers with a plain-text row, e.g.
 * "51234567890 - BUDI SANTOSO / R1/1300VA".
 */
function extractPlnCustomerName(text, fallback = '') {
    if (!text || typeof text !== 'string') return fallback;

    const labeled = text.match(/(?:nama pelanggan|atas nama|a\/n|pelanggan|nama)\s*[:=.-]?\s*([^\n\r,/;|]+)/i);
    if (labeled) {
        const name = labeled[1].replace(/\s+/g, ' ').trim();
        if (name) return name;
    }

    const line = text
        .split(/[\n\r]/)
        .map(l => l.trim())
        .find(l => l && !/^SN:/i.test(l));
    if (!line) return fallback;

    const name = line
        .replace(/^T#\S+\s*/i, '')
        .replace(/^R#\S+\s*/i, '')
        .replace(/^\d{6,20}\s*[-.:]?\s*/, '')
        // Trailing tariff / daya block with its separator, e.g. " / R1/1300VA".
        .replace(/\s*[\/|,]?\s*[A-Za-z]{1,2}\d{1,2}\s*\/\s*\d{2,5}\s*VA/gi, '')
        .replace(/\b(tarif|daya|golongan|sewa)\b.*$/i, '')
        .replace(/\b(SUKSES|GAGAL|SUCCESS|FAILED)\b/gi, '')
        .replace(/[\/|,;.]+\s*$/, '')
        .replace(/^[\s\-:.,|]+/, '')
        .trim();

    return name || fallback;
}

/**
 * Extract the tariff/daya of a CEKPLN inquiry response, e.g. "R1/1300VA".
 */
function extractPlnTariff(text) {
    const match = String(text || '').match(/([A-Za-z]{1,2}\d{1,2})\s*\/\s*(\d{2,5}\s*VA)/i);
    if (!match) return null;
    return `${match[1].toUpperCase()}/${match[2].replace(/\s+/g, '').toUpperCase()}`;
}


// ── Postpaid bill helpers ──────────────────────────────────────────────────

const POSTPAID_GROUP_EXCLUDE = [
    'token pln', 'prabayar', 'top up', 'topup', 'saldo', 'voucher',
    'paket data', 'pulsa', 'masa aktif', 'kuota', 'bulk', 'cetak',
];

// Vendor categories that are always prepaid / topup products. Rows in these
// categories must never land in the bill catalog even when their description
// says "Bayar ..." (e.g. "Bayar Paket Combo Sakti Omni").
const POSTPAID_CATEGORY_EXCLUDE = [
    'kuota', 'bulk', 'sms', 'digital', 'nominal bebas',
];

const POSTPAID_MANUAL_PAIRS = {
    BYRPGN: 'CEKPGN',
    BYRGAS: 'CEKGAS',
    PAYOMNITSEL: 'INQOMNITSEL',
    BPLA: 'CPLA',
};

const POSTPAID_CATEGORY_RULES = [
    { test: /pln|listrik/i, category: 'Tagihan Listrik' },
    { test: /pdam|\bpam\b|air minum/i, category: 'Tagihan Air' },
    { test: /bpjs/i, category: 'BPJS' },
    { test: /gas|pgn|pertagas/i, category: 'Tagihan Gas' },
    { test: /tv|vision|mnc|indovision|okevision|topas|transvision|yes/i, category: 'Tagihan TV' },
    { test: /pbb|pajak|samsat|tilang|retribusi/i, category: 'Pajak & Retribusi' },
    { test: /telkom|indihome|speedy|internet|pascabayar telepon|fren|telkomsel|indosat|smartfren|\btri\b|\bxl\b/i, category: 'Tagihan Telepon & Internet' },
    { test: /finance|kredit|bpr|koperasi|asuransi|home credit|multifinance|cicilan/i, category: 'Tagihan Finansial' },
];

function isPostpaidPayItem(item) {
    const group = String(item?.produk || '').toLowerCase();
    const description = String(item?.keterangan || '').toLowerCase();
    const category = String(item?.kategori || '').toLowerCase();

    if (POSTPAID_GROUP_EXCLUDE.some(keyword => group.includes(keyword))) return false;
    if (POSTPAID_GROUP_EXCLUDE.some(keyword => description.includes(keyword))) return false;
    if (POSTPAID_CATEGORY_EXCLUDE.some(keyword => category.includes(keyword))) return false;

    // Inquiry rows are the "Cek ..." half of the pair, never the payment row.
    if (/^(cek|cek tagihan|cek pascabayar|inq)\b/i.test(description)) return false;

    if (category.includes('tagihan') || category.includes('pascabayar')) return true;

    // Only treat a "Bayar ..." row as postpaid when it belongs to a known
    // biller family. This prevents prepaid rows such as "Bayar Paket Data"
    // from leaking into the bill catalog.
    return /tagihan|pascabayar|pdam|\bpam\b|\bpln\b|bpjs|pbb|samsat|tilang|gas pgn|pertagas|telkom|indihome|speedy|mnc|indovision|okevision|topas|transvision|yes tv|finance|kredit|bpr|koperasi|asuransi|home credit|multifinance|cicilan|listrik|air minum/i
        .test(`${group} ${description}`);
}

function findPostpaidInquiryItem(payItem, rawItems, byCode) {
    const code = String(payItem?.kode || '').toUpperCase();
    if (!code) return null;

    const candidates = [];
    if (POSTPAID_MANUAL_PAIRS[code]) candidates.push(POSTPAID_MANUAL_PAIRS[code]);
    if (code.startsWith('BYR')) candidates.push(`CEK${code.slice(3)}`);
    if (code.startsWith('PAY')) candidates.push(`INQ${code.slice(3)}`);
    candidates.push(`C${code.slice(1)}`);

    for (const candidate of candidates) {
        const found = byCode.get(candidate);
        if (found) return found;
    }

    // Fallback: match by description suffix, e.g. "Cek PDAM Kota Batam" for
    // "Bayar PDAM Kota Batam" when the code prefix is irregular.
    const suffix = String(payItem.keterangan || '')
        .replace(/^(bayar|pembayaran|tagihan|cicilan)\s+/i, '')
        .trim()
        .toLowerCase();

    if (suffix) {
        return rawItems.find(item => {
            if (String(item.produk || '').toLowerCase() !== String(payItem.produk || '').toLowerCase()) {
                return false;
            }
            const desc = String(item.keterangan || '').toLowerCase();
            return /^(cek|cek tagihan|cek pascabayar|inq)\b/i.test(desc) && desc.includes(suffix);
        }) || null;
    }

    return null;
}

/**
 * Normalize common Indonesian biller wording for display.
 * "Bayar Pdam Kabupaten Bandung" -> "PDAM Kabupaten Bandung".
 */
function normalizeBillerText(text) {
    return String(text || '')
        .replace(/\bpdam\b/gi, 'PDAM')
        .replace(/\bpln\b/gi, 'PLN')
        .replace(/\bbpjs\b/gi, 'BPJS')
        .replace(/\bpbb\b/gi, 'PBB')
        .replace(/\bpgn\b/gi, 'PGN')
        .replace(/\bpertagas\b/gi, 'Pertagas')
        .replace(/\bipl\b/gi, 'IPL')
        .replace(/\bkabupaten\b/gi, 'Kabupaten')
        .replace(/\bkota\b/gi, 'Kota')
        .trim();
}

/**
 * Clean an OkeConnect price-list group name into a product display name.
 * "Tagihan PBB Sumatera" -> "PBB Sumatera", "Bayar PLN Bulanan" -> "PLN Bulanan".
 */
function cleanPostpaidGroupName(groupName) {
    const raw = String(groupName || '').trim();
    const cleaned = raw.replace(/^(tagihan|bayar|pembayaran|cicilan)\s+/i, '').trim();
    return normalizeBillerText(cleaned || raw) || 'Tagihan';
}

function cleanPostpaidBillerName(payItem) {
    let name = String(payItem?.keterangan || payItem?.kode || 'Tagihan')
        .replace(/^(bayar|pembayaran|tagihan|cicilan)\s+/i, '')
        .trim();

    // Only the plain PLN bill collapses to the display alias. Every other PLN
    // product ("PLN Non Tagihan Listrik", ...) must stay distinct so a grouped
    // product keeps one variant per service.
    if (/^tagihan listrik$/i.test(name)) return 'PLN Pascabayar';
    if (/^bpjs kesehatan$/i.test(name)) return 'BPJS Kesehatan';

    return normalizeBillerText(name) || String(payItem?.kode || 'Tagihan');
}

function postpaidCategoryFor(text) {
    const haystack = String(text || '');
    for (const rule of POSTPAID_CATEGORY_RULES) {
        if (rule.test.test(haystack)) return rule.category;
    }
    return 'Tagihan & PPOB';
}

/**
 * Resolve the display category for a whole biller group. The group name is the
 * primary signal; biller names only fill in groups the rules cannot classify,
 * so a single odd biller name can never reclassify the whole group.
 */
function resolvePostpaidCategory(rawGroup, candidates) {
    const groupName = cleanPostpaidGroupName(rawGroup);
    const direct = postpaidCategoryFor(`${rawGroup} ${groupName}`);
    if (direct !== 'Tagihan & PPOB') return direct;

    const billerText = candidates.map(candidate => candidate.billerName).join(' ');
    return postpaidCategoryFor(`${rawGroup} ${groupName} ${billerText}`);
}

/**
 * Okeconnect H2H Vendor Adapter.
 * Handles GET-based query parameter authentication, plain-text response parsing,
 * catalog syncing for E-Wallet & Game topup, transaction creation, inquiry validation, and callbacks.
 */
class OkeconnectAdapter extends VendorAdapter {
    constructor() {
        super('okeconnect');
        this.baseURL = process.env.OKECONNECT_BASE_URL || 'https://h2h.okeconnect.com';
        this.memberID = process.env.OKECONNECT_MEMBER_ID || '';
        this.pin = process.env.OKECONNECT_PIN || '';
        this.password = process.env.OKECONNECT_PASSWORD || '';
        this.priceListId = process.env.OKECONNECT_PRICE_LIST_ID || '905ccd028329b0a';
        this.priceListUrl = process.env.OKECONNECT_PRICE_LIST_URL || 'https://okeconnect.com/harga/json';
        this.callbackSecret = process.env.OKECONNECT_CALLBACK_SECRET || '';

        this.inquiryEmitter = new EventEmitter();
        this.inquiryEmitter.setMaxListeners(100);

        // Bill inquiries use a separate emitter/prefix so they never collide
        // with game/e-wallet account-validation callbacks.
        this.billInquiryEmitter = new EventEmitter();
        this.billInquiryEmitter.setMaxListeners(100);

        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: 35000,
            headers: {
                'User-Agent': 'NoxariaNetStore/1.0',
            },
        });
    }

    /**
     * Dispatch incoming callback event for pending inquiry checks.
     */
    handleInquiryCallback(refId, event) {
        if (!refId) return;
        this.inquiryEmitter.emit(refId, event);
    }

    /**
     * Dispatch an OkeConnect callback for a postpaid bill inquiry.
     */
    handleBillInquiryCallback(refId, event) {
        if (!refId) return;
        this.billInquiryEmitter.emit(refId, event);
    }


    /**
     * Auth parameters required for all transaction / balance endpoints.
     */
    _getAuthParams() {
        return {
            memberID: this.memberID,
            pin: this.pin,
            password: this.password,
        };
    }

    /**
     * Fetch the OkeConnect JSON price list.
     *
     * The public price-list endpoint rate-limits aggressively (HTTP 429), so a
     * single request can fail while the catalog itself is fine. Retry with a
     * short backoff before giving up.
     *
     * @param {string} produk - Comma separated price-list category slugs
     * @param {number} attempts - Maximum number of tries
     */
    async _fetchPriceList(produk, attempts = 3) {
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                const res = await axios.get(this.priceListUrl, {
                    params: {
                        id: this.priceListId,
                        produk,
                    },
                    timeout: 30000,
                });

                const items = Array.isArray(res.data) ? res.data : [];
                if (items.length > 0) return items;

                lastError = new Error('Respons harga OkeConnect kosong');
            } catch (error) {
                lastError = error;
                const status = error.response?.status;
                okeLog.warn('price_list_request_failed', {
                    attempt,
                    status: status || null,
                    message: error.message,
                });

                // Client errors (other than rate limiting) will not heal.
                if (status && status !== 429 && status < 500) break;
            }

            if (attempt < attempts) {
                await sleep(1500 * attempt);
            }
        }

        throw lastError || new Error('Gagal mengambil katalog harga OkeConnect');
    }

    /**
     * Fetch products catalog from OkeConnect JSON price list.
     * Filters strictly for E-Wallet and Topup Game products, plus the PLN
     * prepaid token catalog.
     * Normalized into unified product hierarchy with `is_hidden = true` by default.
     * @param {Object} params - { type: 'full'|'delta' }
     */
    async fetchProducts(params = {}) {
        try {
            okeLog.debug('price_list_request', { priceListId: this.priceListId });

            let rawItems = await this._fetchPriceList(PRICE_LIST_CATEGORIES);

            if (rawItems.length === 0) {
                return {
                    success: false,
                    message: 'Katalog produk OkeConnect kosong atau format tidak valid',
                };
            }

            // The token catalog must never depend on the e-wallet slug list.
            // If the combined request did not return the token category, pull
            // it on its own.
            let plnFetchFailed = false;
            if (!rawItems.some(isPlnTokenItem)) {
                const plnItems = await this._fetchPriceList(PLN_PRICE_LIST_CATEGORY).catch(err => {
                    okeLog.warn('price_list_pln_fetch_failed', { message: err.message });
                    return [];
                });

                if (plnItems.length > 0) {
                    rawItems = rawItems.concat(plnItems);
                } else {
                    plnFetchFailed = true;
                }
            }

            const ewalletKeywords = [
                'saldo', 'gopay', 'ovo', 'dana', 'shopeepay', 'linkaja', 'grab', 'gojek',
                'top up saldo', 'maxim', 'shopee driver', 'indriver', 'doku'
            ];

            const gameKeywords = [
                'tpg', 'diamond', 'game', 'pubg', 'mobile legend', 'free fire', 'steam',
                'garena', 'unipin', 'razer', 'point blank', 'roblox', 'call of duty',
                'arena of valor', 'clash', 'honor of king', 'blood strike', 'speed drifter',
                'lokapala', 'zepeto', 'werewolf', 'one punch', 'delta force', 'gemscool',
                'life after', 'arena breakout', 'google play', 'okegaming', 'fc mobile',
                'new state', 'magic chess'
            ];

            const grouped = {};
            const plnItems = [];

            for (const item of rawItems) {
                const groupName = (item.produk || 'Lainnya').trim();
                const lowerGroup = groupName.toLowerCase();

                // PLN prepaid tokens are merged into a single product below.
                if (isPlnTokenItem(item)) {
                    plnItems.push(item);
                    continue;
                }

                // The token category also holds e-money cards (Tapcash, BRIzzi,
                // Flazz, Tol Mandiri). They are not tokens and must never be
                // picked up by the e-wallet keyword match below.
                if (isPlnTokenCategory(item)) {
                    continue;
                }

                // Explicit excludes: subscription, utility, hardware, shopping vouchers, inquiries
                if (
                    lowerGroup.includes('berlangganan') || lowerGroup.includes('belangganan') ||
                    lowerGroup.includes('spotify') || lowerGroup.includes('wetv') || lowerGroup.includes('vidio') ||
                    lowerGroup.includes('wifi') || lowerGroup.includes('genflix') || lowerGroup.includes('cek produk') ||
                    lowerGroup.includes('omni') || lowerGroup.includes('edc') || lowerGroup.includes('voucher belanja')
                ) {
                    continue;
                }

                const isEwallet = ewalletKeywords.some(k => lowerGroup.includes(k));
                const isGame = gameKeywords.some(k => lowerGroup.includes(k));

                if (!isEwallet && !isGame) continue;

                if (!grouped[groupName]) {
                    grouped[groupName] = {
                        rawName: groupName,
                        isEwallet,
                        isGame,
                        items: [],
                    };
                }
                grouped[groupName].items.push(item);
            }

            // Transform each group into a unified Product with Variants
            const normalizedProducts = [];

            for (const [groupName, grp] of Object.entries(grouped)) {
                const slug = slugify(groupName);
                const externalId = `okc-${slug}`;
                const category = grp.isEwallet ? 'E-Wallet' : 'Game';

                // Format a clean product display name
                let cleanName = groupName
                    .replace(/^TPG\s+/i, '')
                    .replace(/^Top Up Saldo\s+/i, '')
                    .replace(/^Topup Saldo\s+/i, '')
                    .replace(/^Top Up\s+/i, '')
                    .trim();

                const brand = cleanName;
                const displayName = `${cleanName} (OkeConnect)`;

                // Determine required fields and validation availability for OkeConnect
                let requiredFields = [];
                let hasValidation = false;

                const lowerClean = cleanName.toLowerCase();
                if (lowerClean.includes('mobile legend') || lowerClean.includes('magic chess')) {
                    requiredFields = [
                        { key: 'customer_id', label: 'User ID', type: 'text', required: true },
                        { key: 'zone_id', label: 'Zone ID', type: 'text', required: true },
                    ];
                    hasValidation = true;
                } else if (lowerClean.includes('free fire') || lowerClean.includes('call of duty') || lowerClean.includes('arena of valor') || lowerClean.includes('honor of king') || lowerClean.includes('pubg') || lowerClean.includes('point blank')) {
                    requiredFields = [
                        { key: 'customer_id', label: 'User ID', type: 'text', required: true },
                    ];
                    hasValidation = true;
                } else if (grp.isEwallet) {
                    requiredFields = [
                        { key: 'customer_id', label: 'Nomor HP Tujuan', type: 'tel', required: true },
                    ];
                    hasValidation = true;
                } else {
                    requiredFields = [
                        { key: 'customer_id', label: 'Target / User ID', type: 'text', required: true },
                    ];
                }



                // Check if any variant is open denom and deduplicate by kode
                const seenCodes = new Set();
                const variants = [];

                for (const item of grp.items) {
                    const code = item.kode;
                    if (!code) continue;

                    if (seenCodes.has(code)) {
                        const existingIdx = variants.findIndex(v => v.vendor_variant_id === code);
                        if (existingIdx !== -1 && item.status === '1' && !variants[existingIdx].is_active) {
                            variants[existingIdx].is_active = true;
                            variants[existingIdx].stock = 9999;
                            variants[existingIdx].base_price = Math.ceil(parseInt(item.harga) || 0);
                            variants[existingIdx].sell_price = variants[existingIdx].base_price + 1000;
                            variants[existingIdx].name = item.keterangan || code;
                        }
                        continue;
                    }
                    seenCodes.add(code);

                    const isAvailable = item.status === '1';
                    const basePrice = Math.ceil(parseInt(item.harga) || 0);
                    const isOpenDenom = item.kode === 'BBSDN' || (item.keterangan || '').toLowerCase().includes('bebas nominal');

                    const providerMeta = isOpenDenom ? {
                        open_denom: true,
                        min_qty: 10000,
                        max_qty: 10000000,
                    } : {};

                    variants.push({
                        vendor_variant_id: item.kode,
                        name: item.keterangan || item.kode,
                        base_price: basePrice,
                        markup: 1000,
                        sell_price: basePrice + 1000,
                        stock: isAvailable ? 9999 : 0,
                        order_process: 'auto',
                        is_active: isAvailable,
                        is_hidden: true, // User Choice C: hidden by default
                        required_fields: requiredFields,
                        validation: { available: hasValidation },
                        provider_meta: providerMeta,
                        metadata: {
                            kode: item.kode,
                            kategori: item.kategori,
                            produk: item.produk,
                            raw_status: item.status,
                        },
                    });
                }


                normalizedProducts.push({
                    vendor: 'okeconnect',
                    external_id: externalId,
                    category,
                    name: displayName,
                    brand,
                    icon: null,
                    image: null,
                    is_active: true,
                    metadata: {
                        originalGroup: groupName,
                        vendor: 'okeconnect',
                    },
                    variants,
                });
            }

            // PLN prepaid tokens: every route and nominal becomes one variant of
            // a single app-only product.
            if (plnItems.length > 0) {
                const plnVariants = [];
                const seenPlnCodes = new Set();

                for (const item of plnItems) {
                    const code = item.kode;
                    if (!code || seenPlnCodes.has(code)) continue;
                    // Inquiry rows (CPLN) are not sellable tokens.
                    if (isPlnInquiryRow(item)) continue;
                    seenPlnCodes.add(code);

                    const isAvailable = item.status === '1';
                    const basePrice = Math.ceil(parseInt(item.harga) || 0);
                    const denom = plnDenomLabel(item.keterangan);
                    const route = plnRouteLabel(item.produk);

                    plnVariants.push({
                        vendor_variant_id: code,
                        name: `Token PLN ${denom} — ${route}`,
                        base_price: basePrice,
                        markup: 1000,
                        sell_price: basePrice + 1000,
                        stock: isAvailable ? 9999 : 0,
                        order_process: 'auto',
                        is_active: isAvailable,
                        is_hidden: false,
                        required_fields: PLN_TOKEN_REQUIRED_FIELDS,
                        validation: { available: true, type: 'account_inquiry' },
                        provider_meta: { target_type: 'meter' },
                        metadata: {
                            kode: code,
                            kategori: item.kategori,
                            produk: item.produk,
                            route,
                            nominal: denom,
                            raw_status: item.status,
                        },
                    });
                }

                // Cheapest route per nominal first, so the app shows the most
                // attractive denominations at the top.
                plnVariants.sort((a, b) =>
                    plnDenomValue(a.metadata.nominal) - plnDenomValue(b.metadata.nominal) ||
                    a.base_price - b.base_price
                );

                normalizedProducts.push({
                    vendor: 'okeconnect',
                    external_id: PLN_TOKEN_PRODUCT_ID,
                    category: PLN_TOKEN_CATEGORY_NAME,
                    name: PLN_TOKEN_PRODUCT_NAME,
                    brand: PLN_TOKEN_BRAND,
                    icon: null,
                    image: null,
                    is_active: true,
                    product_type: 'prepaid',
                    available_channels: ['app'],
                    metadata: {
                        originalGroups: [...new Set(plnItems.map(item => item.produk))],
                        vendor: 'okeconnect',
                    },
                    variants: plnVariants,
                });
            }

            okeLog.info('price_list_parsed', {
                productGroups: normalizedProducts.length,
                variants: rawItems.length,
                plnVariants: plnItems.length,
            });

            return {
                success: true,
                data: normalizedProducts,
                preserve_external_ids: plnFetchFailed ? [PLN_TOKEN_PRODUCT_ID] : [],
                serverTime: new Date().toISOString(),
            };
        } catch (error) {
            okeLog.error('price_list_fetch_failed', { error });
            return {
                success: false,
                message: error.message,
            };
        }
    }

    /**
     * Fetch postpaid bill products (PLN, PDAM, BPJS, phone, TV, gas, PBB, ...).
     *
     * OkeConnect exposes paired codes: a "Cek ..." inquiry code and a "Bayar ..."
     * payment code. One catalog product is created per OkeConnect price-list
     * group (`item.produk`), and every biller/region inside that group becomes a
     * variant. Example: the group "PDAM Jawa Barat dan Jakarta" becomes the
     * product of the same name with the variants "PDAM Kota Jakarta Aetra",
     * "PDAM Kota Bandung", ...
     *
     * When a biller has several commission tiers (e.g. PLN BPLA/BPLA4000/
     * BPLA4500), the highest active commission is chosen so the customer is not
     * asked to pick between indistinguishable options.
     *
     * These products are app-only by default; the web storefront must never see
     * a bill product before the bill flow is explicitly enabled for it.
     */
    async fetchPostpaidProducts(params = {}) {
        try {
            okeLog.debug('postpaid_price_list_request', { priceListId: this.priceListId });

            const res = await axios.get(this.priceListUrl, {
                params: { id: this.priceListId },
                timeout: 45000,
            });

            const rawItems = Array.isArray(res.data) ? res.data : [];
            if (rawItems.length === 0) {
                return {
                    success: false,
                    message: 'Katalog postpaid OkeConnect kosong atau format tidak valid',
                };
            }

            const byCode = new Map();
            for (const item of rawItems) {
                if (item?.kode) byCode.set(String(item.kode).toUpperCase(), item);
            }

            // One entry per OkeConnect price-list group. Inside each group the
            // key is the cleaned biller name so duplicate commission tiers for
            // the same biller collapse into a single variant.
            const groups = new Map();

            for (const item of rawItems) {
                if (!isPostpaidPayItem(item)) continue;

                const inquiryItem = findPostpaidInquiryItem(item, rawItems, byCode);
                if (!inquiryItem) continue;

                const rawGroup = String(item.produk || '').trim() || 'Tagihan Lainnya';
                const groupKey = rawGroup.toLowerCase();
                const billerName = cleanPostpaidBillerName(item);
                const billerKey = billerName.toLowerCase();

                const price = parseInt(item.harga, 10) || 0;
                const commission = Math.max(0, -price);
                const vendorFee = Math.max(0, price);
                const isActive = item.status === '1';

                const candidate = {
                    payItem: item,
                    inquiryItem,
                    billerName,
                    commission,
                    vendorFee,
                    isActive,
                };

                let group = groups.get(groupKey);
                if (!group) {
                    group = { rawGroup, billers: new Map() };
                    groups.set(groupKey, group);
                }

                const existing = group.billers.get(billerKey);
                if (!existing) {
                    group.billers.set(billerKey, candidate);
                    continue;
                }

                // Prefer an active code. Among active codes, surface the one
                // with the largest commission (lowest vendor cost for us).
                const existingScore = (existing.isActive ? 1 : 0) * 1e9 + existing.commission;
                const candidateScore = (candidate.isActive ? 1 : 0) * 1e9 + candidate.commission;
                if (candidateScore > existingScore) {
                    group.billers.set(billerKey, candidate);
                }
            }

            const usedExternalIds = new Set();
            const normalizedProducts = [];

            for (const group of groups.values()) {
                const candidates = [...group.billers.values()];
                const groupName = cleanPostpaidGroupName(group.rawGroup);

                const baseSlug = slugify(group.rawGroup) || 'group';
                let externalId = `okc-bill-${baseSlug}`;
                let suffix = 2;
                while (usedExternalIds.has(externalId)) {
                    externalId = `okc-bill-${baseSlug}-${suffix}`;
                    suffix++;
                }
                usedExternalIds.add(externalId);

                const variants = candidates
                    .map(({ payItem, inquiryItem, billerName, commission, vendorFee, isActive }) => ({
                        vendor_variant_id: payItem.kode,
                        name: billerName,
                        base_price: 0,
                        markup: 0,
                        sell_price: 0,
                        stock: isActive ? 9999 : 0,
                        order_process: 'auto',
                        is_active: isActive,
                        is_hidden: false,
                        required_fields: [{
                            key: 'customer_number',
                            label: 'Nomor Pelanggan / ID Meter',
                            type: 'text',
                            required: true,
                        }],
                        validation: { available: true, type: 'bill_inquiry' },
                        provider_meta: {
                            postpaid: true,
                            inquiry_code: inquiryItem.kode,
                            payment_code: payItem.kode,
                            commission,
                            vendor_fee: vendorFee,
                        },
                        metadata: {
                            kode: payItem.kode,
                            inquiry_code: inquiryItem.kode,
                            kategori: payItem.kategori,
                            produk: group.rawGroup,
                            biller: billerName,
                            raw_status: payItem.status,
                            commission,
                            vendor_fee: vendorFee,
                        },
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'id'));

                normalizedProducts.push({
                    vendor: 'okeconnect',
                    external_id: externalId,
                    category: resolvePostpaidCategory(group.rawGroup, candidates),
                    name: groupName,
                    brand: null,
                    icon: null,
                    image: null,
                    // A group is sellable as long as one of its billers is.
                    is_active: candidates.some(candidate => candidate.isActive),
                    product_type: 'postpaid',
                    available_channels: ['app'],
                    metadata: {
                        originalGroup: group.rawGroup,
                        vendor: 'okeconnect',
                    },
                    variants,
                });
            }

            const variantCount = normalizedProducts
                .reduce((sum, product) => sum + product.variants.length, 0);

            okeLog.info('postpaid_price_list_parsed', {
                products: normalizedProducts.length,
                variants: variantCount,
                rawItems: rawItems.length,
            });

            return {
                success: true,
                data: normalizedProducts,
                serverTime: new Date().toISOString(),
            };
        } catch (error) {
            okeLog.error('postpaid_price_list_fetch_failed', { error });
            return {
                success: false,
                message: error.message,
            };
        }
    }

    /**
     * Single product detail (not separately supported by Okeconnect, returns success).
     */
    async fetchProductDetail(externalId) {
        return { success: true, data: null };
    }

    /**
     * Real-time stock check.
     * Product availability is updated during sync via status: "1" / "0".
     */
    async checkStock(variantId) {
        return { success: true, available: true, stock: 9999 };
    }

    /**
     * Check vendor balance from `GET /trx/balance`.
     * Supports caching (TTL 60s) unless options.force is true.
     */
    async getBalance(options = {}) {
        const cacheKey = cacheService.KEYS.VENDOR_BALANCE('okeconnect');
        if (!options.force) {
            const cached = cacheService.get(cacheKey);
            if (cached !== undefined) {
                return cached;
            }
        }

        try {
            if (!this.memberID || !this.pin || !this.password) {
                return {
                    success: false,
                    message: 'Kredensial OkeConnect (memberID/pin/password) belum dikonfigurasi di .env',
                };
            }

            const res = await this.client.get('/trx/balance', {
                params: this._getAuthParams(),
            });

            const text = String(res.data || '').trim();

            if (text.includes('Salah') || text.includes('GAGAL') || text.includes('Error')) {
                return {
                    success: false,
                    status: 401,
                    message: text,
                };
            }

            // Response example: "Saldo 284.939"
            const numMatch = text.match(/Saldo\s*([0-9.,]+)/i);
            let balance = 0;
            if (numMatch) {
                balance = parseInt(numMatch[1].replace(/[^0-9]/g, ''), 10) || 0;
            }

            const result = {
                success: true,
                balance,
                data: {
                    balance,
                    formatted: `Rp ${balance.toLocaleString('id-ID')}`,
                    raw: text,
                },
            };

            // Cache for 60 seconds
            cacheService.set(cacheKey, result, 60);

            return result;
        } catch (error) {
            okeLog.error('balance_fetch_failed', { error });
            return {
                success: false,
                message: error.message,
            };
        }
    }

    /**
     * Find inquiry code for account validation.
     */
    _resolveInquiryCode(params = {}) {
        const name = `${params.productName || ''} ${params.brand || ''} ${params.category || ''}`.toLowerCase();
        const vId = `${params.variantId || ''}`.toLowerCase();

        // 1. Variant SKU prefix checks
        if (/^dml/i.test(vId)) return 'CEKML';
        if (/^dff/i.test(vId)) return 'CEKFF';
        if (/^d\d+/i.test(vId) || /^bbsdn/i.test(vId)) return 'CEKD';
        if (/^ovo/i.test(vId)) return 'CEKOVO';
        if (/^gjk/i.test(vId) || /^gp/i.test(vId)) return 'CEKGJK';
        if (/^shp/i.test(vId)) return 'CEKSHP';
        if (/^la/i.test(vId) || /^link/i.test(vId)) return 'CEKLINK';

        // 2. Product name & brand checks
        if (name.includes('mobile legend') || name.includes('magic chess')) return 'CEKML';
        if (name.includes('free fire')) return 'CEKFF';
        if (name.includes('call of duty') || name.includes('codm')) return 'CEKCODM';
        if (name.includes('arena of valor') || name.includes('aov')) return 'CEKAOV';
        if (name.includes('honor of king') || name.includes('hok')) return 'CEKHOK';
        if (name.includes('pubg')) return 'CEKPUBG';
        if (name.includes('point blank')) return 'CEKPB';
        if (name.includes('dana')) return 'CEKD';
        if (name.includes('ovo')) return 'CEKOVO';
        if (name.includes('gopay') || name.includes('go-jek') || name.includes('gojek')) return 'CEKGJK';
        if (name.includes('shopee')) return 'CEKSHP';
        if (name.includes('linkaja') || name.includes('link aja')) return 'CEKLINK';
        if (name.includes('grab')) return 'CEKGRB';
        if (name.includes('isaku') || name.includes('i.saku') || name.includes('i-saku')) return 'CEKISAKU';
        if (name.includes('maxim')) return 'CEKMAXIM';
        if (name.includes('astrapay')) return 'CEKASTRA';
        if (name.includes('kaspro')) return 'CEKKASPRO';
        if (name.includes('pln')) return 'CEKPLN';

        // 3. Fallback map lookup
        for (const [key, code] of Object.entries(INQUIRY_CODE_MAP)) {
            if (name.includes(key) || vId.includes(key)) {
                return code;
            }
        }
        return null;
    }

    /**
     * Validate customer account/user ID via OkeConnect inquiry codes (e.g. CEKML, CEKD, CEKOVO).
     * If credentials are not set or no inquiry code matches, fails open gracefully.
     * Results are cached for 30 minutes in memory.
     * @param {Object} params - { variantId, customerId, zoneId, productName, brand }
     */
    async validateAccount(params = {}) {
        const rawCustomerId = params.customerId || params.customer_id || params.user_id || params.target;
        const zoneId = params.zoneId || params.zone_id || null;

        if (!rawCustomerId) {
            return { success: false, valid: false, message: 'User ID / Nomor Tujuan wajib diisi' };
        }

        let customerId = String(rawCustomerId).trim();
        const inqCode = this._resolveInquiryCode(params);

        // Check if it's an e-wallet inquiry or phone-based target
        const isEwalletInquiry = inqCode && (
            inqCode.startsWith('CEKD') || inqCode.startsWith('CEKOVO') || inqCode.startsWith('CEKGJK') ||
            inqCode.startsWith('CEKSHP') || inqCode.startsWith('CEKLINK') || inqCode.startsWith('CEKGRB') ||
            inqCode.startsWith('CEKISAKU') || inqCode.startsWith('CEKMAXIM') || inqCode.startsWith('CEKASTRA') ||
            inqCode.startsWith('CEKKASPRO')
        );
        const isEwalletCat = (params.category && params.category.toLowerCase().includes('wallet')) ||
            (params.productName && /dana|ovo|gopay|gojek|shopee|linkaja|isaku|maxim/i.test(params.productName));

        if (isEwalletInquiry || isEwalletCat) {
            // Strictly reject if alphabetic characters are present
            if (/[a-zA-Z]/.test(rawCustomerId)) {
                return { success: false, valid: false, message: 'Nomor tujuan e-wallet tidak boleh mengandung huruf. Masukkan nomor HP valid (contoh: 08123456789)' };
            }
            // Format nomor e-wallet harus menggunakan format 08 tanpa spasi dan strip (-)
            const normalized = normalizePhoneNumber(customerId);
            if (!normalized || !/^08[0-9]{8,13}$/.test(normalized)) {
                return { success: false, valid: false, message: 'Format nomor e-wallet tidak valid. Harus diawali 08 dengan 10-14 digit angka.' };
            }
            customerId = normalized;
        } else if (inqCode === 'CEKML') {
            if (!/^\d{4,12}$/.test(customerId)) {
                return { success: false, valid: false, message: 'User ID Mobile Legends harus berupa 4-12 digit angka (tanpa huruf).' };
            }
            if (!zoneId || !/^\d{3,6}$/.test(zoneId)) {
                return { success: false, valid: false, message: 'Zone ID Mobile Legends harus berupa 3-6 digit angka (tanpa huruf).' };
            }
        } else if (inqCode === 'CEKFF') {
            if (!/^\d{6,14}$/.test(customerId)) {
                return { success: false, valid: false, message: 'User ID Free Fire harus berupa 6-14 digit angka (tanpa huruf).' };
            }
        } else if (inqCode === 'CEKPLN') {
            // PLN meter / customer numbers are plain digit strings. They may
            // start with 62 or 8, so they must never be phone-normalized.
            const digits = customerId.replace(/\D/g, '');
            if (!digits || digits.length < 6 || digits.length > 20) {
                return { success: false, valid: false, message: 'No. Meter / ID Pelanggan PLN harus berupa 6-20 digit angka.' };
            }
            customerId = digits;
        } else if (!zoneId && /^[0-9\s\-\+\(\)]+$/.test(customerId)) {
            const normalized = normalizePhoneNumber(customerId);
            if (normalized && normalized.startsWith('08')) {
                customerId = normalized;
            }
        }

        if (!inqCode || !this.memberID || !this.pin || !this.password) {
            // Fail-open gracefully if no inquiry code available or credentials not yet added
            return { success: true, valid: true, data: { account_name: customerId, display_name: customerId, customer_id: customerId } };
        }

        let dest = customerId;
        if (zoneId) {
            dest = `${dest}(${zoneId})`;
        }

        // Check in-memory cache first for instant (<2ms) response
        const cacheKey = cacheService.KEYS.ACCOUNT_VALIDATION('okeconnect', `${inqCode}_${dest}`);
        const cached = cacheService.get(cacheKey);
        if (cached !== undefined) {
            okeLog.debug('account_validation_cache_hit');
            return cached;
        }

        try {
            const tempRefId = `INQ${Date.now().toString(36).toUpperCase()}`;

            okeLog.debug('account_validation_started', { inqCode, refId: tempRefId });

            // Setup a Promise to wait for callback with optimized 4s timeout
            const waitForCallback = new Promise((resolve) => {
                const onCallback = (event) => {
                    resolve(event);
                };
                this.inquiryEmitter.once(tempRefId, onCallback);
                setTimeout(() => {
                    this.inquiryEmitter.removeListener(tempRefId, onCallback);
                    resolve(null);
                }, 4000);
            });

            const res = await this.client.get('/trx', {
                params: {
                    ...this._getAuthParams(),
                    product: inqCode,
                    dest,
                    refID: tempRefId,
                },
            });

            const text = String(res.data || '').trim();
            okeLog.debug('account_validation_response_received', { inqCode });

            const initialParsed = parseStatusAndSn(text);

            let finalText = text;
            let finalStatus = initialParsed.status;
            let finalSn = initialParsed.sn;

            // If initial response is pending / "akan diproses", wait for webhook callback or poll
            if (finalStatus === 'pending' || text.includes('akan diproses') || text.includes('Menunggu Jawaban')) {
                okeLog.debug('account_validation_waiting_callback', { refId: tempRefId });
                const callbackEvent = await waitForCallback;
                if (callbackEvent) {
                    finalText = callbackEvent.message || finalText;
                    finalStatus = callbackEvent.status;
                    finalSn = callbackEvent.sn;
                    okeLog.debug('account_validation_callback_received', { refId: tempRefId, status: finalStatus });
                } else {
                    // Quick poll fallback if callback didn't arrive in time
                    try {
                        const checkRes = await this.checkOrderStatus(tempRefId, { product: inqCode, dest });
                        if (checkRes.success && checkRes.status !== 'pending') {
                            finalStatus = checkRes.status;
                            finalSn = checkRes.sn;
                            finalText = checkRes.data?.raw || finalText;
                        }
                    } catch (e) {
                        // ignore
                    }
                }
            }

            // Check if result is NOT success
            if (inqCode === 'CEKPLN') {
                // CEKPLN answers with a plain-text customer row (number, name,
                // tariff) instead of the "SUKSES" keyword the other inquiries
                // use. Only an explicit error marks the meter as invalid.
                const plnError = /GAGAL|TIDAK DITEMUKAN|Tidak Ditemukan|TIDAK VALID|Tidak Valid|TIDAK ADA|\bSalah\b/i.test(finalText);
                const hasCustomerRow = finalText.includes(customerId) || /\d{6,20}/.test(finalText);

                if (plnError || !hasCustomerRow) {
                    const message = plnError
                        ? extractErrorMessage(finalText)
                        : 'No. Meter / ID Pelanggan tidak ditemukan atau tidak valid';
                    return { success: false, valid: false, message };
                }

                const name = extractPlnCustomerName(finalText, customerId);
                const tariff = extractPlnTariff(finalText);
                const accountName = tariff ? `${name} (${tariff})` : name;

                const result = {
                    success: true,
                    valid: true,
                    data: {
                        account_name: accountName,
                        display_name: accountName,
                        customer_id: customerId,
                        sn: finalSn,
                        raw: finalText,
                    },
                };

                // Cache successful validation result for 30 minutes
                cacheService.set(cacheKey, result, 1800);

                return result;
            }

            const isSuccess = (finalStatus === 'success' || /status\s+Sukses/i.test(finalText) || /\bSUKSES\b/i.test(finalText)) &&
                              !/GAGAL|Salah|Tidak Ditemukan|TIDAK ADA|tidak terdaftar/i.test(finalText);

            if (!isSuccess || finalStatus === 'failed' || finalStatus === 'pending') {
                const errMsg = extractErrorMessage(finalText);
                return {
                    success: false,
                    valid: false,
                    message: (errMsg && !errMsg.includes('akan diproses') && !errMsg.includes('Menunggu Jawaban')) 
                        ? errMsg 
                        : 'Akun / ID tidak ditemukan atau tidak valid',
                };
            }

            // Extract customer name / nickname from response
            const accountName = extractCustomerName(finalText, customerId);

            const result = {
                success: true,
                valid: true,
                data: {
                    account_name: accountName,
                    display_name: accountName,
                    sn: finalSn,
                    raw: finalText,
                },
            };

            // Cache successful validation result for 30 minutes
            cacheService.set(cacheKey, result, 1800);

            return result;
        } catch (error) {
            okeLog.warn('account_validation_failed', { error });
            return {
                success: false,
                valid: false,
                message: error.message || 'Gagal memvalidasi akun ke OkeConnect',
            };
        }
    }



    /**
     * Ask OkeConnect for a postpaid bill quote.
     *
     * @param {Object} params
     * @param {string} params.inquiryCode - vendor "Cek ..." product code
     * @param {string} params.customerId - customer number / meter ID
     * @param {string} [params.productName]
     * @returns {Promise<{success: boolean, data?: object, message?: string}>}
     */
    async inquireBill(params = {}) {
        const inquiryCode = params.inquiryCode || params.inquiry_code;
        const customerId = String(
            params.customerId || params.customer_id || params.customerNumber || ''
        ).trim();

        if (!inquiryCode) {
            return { success: false, message: 'Kode inquiry tagihan tidak tersedia.' };
        }
        if (!customerId) {
            return { success: false, message: 'Nomor pelanggan wajib diisi.' };
        }
        if (!this.memberID || !this.pin || !this.password) {
            return { success: false, message: 'Kredensial OkeConnect belum dikonfigurasi di .env' };
        }

        const refId = `BILLINQ${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

        let timeoutHandle = null;
        let onCallback = null;

        const waitForCallback = new Promise((resolve) => {
            onCallback = (event) => resolve(event);
            this.billInquiryEmitter.once(refId, onCallback);
            timeoutHandle = setTimeout(() => {
                this.billInquiryEmitter.removeListener(refId, onCallback);
                resolve(null);
            }, 8000);
        });

        const cleanup = () => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (onCallback) this.billInquiryEmitter.removeListener(refId, onCallback);
        };

        try {
            okeLog.info('bill_inquiry_started', { refId, inquiryCode });

            const res = await this.client.get('/trx', {
                params: {
                    ...this._getAuthParams(),
                    product: inquiryCode,
                    dest: customerId,
                    refID: refId,
                },
            });

            let text = String(res.data || '').trim();
            let parsed = parseBillInquiry(text);

            const looksPending = /akan diproses|menunggu jawaban|\bpending\b/i.test(text);

            // A clear vendor failure does not need to wait for a callback.
            if (!parsed.success && !looksPending) {
                cleanup();
                okeLog.warn('bill_inquiry_vendor_rejected', { refId, inquiryCode });
                return {
                    success: false,
                    message: text.slice(0, 300) || 'Tagihan tidak ditemukan.',
                    data: { raw: text, inquiry_ref: refId },
                };
            }

            if (!parsed.success || looksPending) {
                okeLog.debug('bill_inquiry_waiting_callback', { refId });
                const callbackEvent = await waitForCallback;

                if (callbackEvent?.message) {
                    text = callbackEvent.message;
                    parsed = parseBillInquiry(text);
                }

                if (!parsed.success) {
                    const statusCheck = await this.checkOrderStatus(refId, {
                        product: inquiryCode,
                        dest: customerId,
                    });

                    if (statusCheck.success && statusCheck.data?.raw) {
                        text = statusCheck.data.raw;
                        parsed = parseBillInquiry(text);
                    }
                }
            }

            cleanup();

            if (!parsed.success) {
                okeLog.warn('bill_inquiry_parse_failed', { refId, inquiryCode });
                return {
                    success: false,
                    message: parsed.message || 'Tagihan tidak ditemukan atau respons vendor tidak dapat dibaca.',
                    data: { raw: text, inquiry_ref: refId },
                };
            }

            return {
                success: true,
                data: {
                    ...parsed.data,
                    inquiry_ref: refId,
                    vendor_ref: parsed.data.vendor_ref || refId,
                    raw: text,
                },
            };
        } catch (error) {
            cleanup();
            okeLog.error('bill_inquiry_failed', { refId, inquiryCode, error });
            return {
                success: false,
                message: error.message || 'Gagal mengecek tagihan ke OkeConnect.',
            };
        }
    }

    /**
     * Create order / transaction on OkeConnect.
     * @param {string} refId - Unique order ID (NX-...)
     * @param {Object} orderData - { variantId / sku, target, zoneId, qty, accountDetails }
     */
    async createOrder(refId, orderData) {
        try {
            if (!this.memberID || !this.pin || !this.password) {
                throw new Error('Kredensial OkeConnect belum dikonfigurasi di .env');
            }

            const product = orderData.variantId || orderData.sku || orderData.productCode;
            if (!product) {
                throw new Error('Kode produk / variant_id wajib diisi untuk OkeConnect');
            }

            let dest = orderData.target || orderData.accountDetails?.target || orderData.accountDetails?.note || '';
            const zoneId = orderData.zoneId || orderData.accountDetails?.zone_id;
            const customerId = orderData.accountDetails?.customer_id;
            const isPostpaid = orderData.accountDetails?.type === 'postpaid' ||
                orderData.accountDetails?.postpaid === true;
            // Meter / customer numbers (PLN token) are not phone numbers and
            // must be passed through exactly as entered.
            const isMeterTarget = orderData.accountDetails?.target_type === 'meter';

            if (customerId && zoneId && !dest.includes('(')) {
                dest = `${customerId}(${zoneId})`;
            } else if (isMeterTarget && dest) {
                // Meter / customer numbers are digits only.
                dest = String(dest).replace(/\D/g, '');
            } else if (!zoneId && dest && !isPostpaid && !isMeterTarget) {
                // Normalize e-wallet / phone number to 08xxx format. Bill
                // customer numbers must be passed through exactly as entered;
                // leading zeros and separators are significant for PDAM/PBB.
                const normalized = normalizePhoneNumber(dest);
                if (normalized && normalized.startsWith('08')) {
                    dest = normalized;
                }
            }

            if (!dest) {
                throw new Error('Nomor tujuan / User ID tujuan tidak boleh kosong');
            }

            // Some H2H billers require the payment to reuse the inquiry refID.
            // Keep this behind an env flag until the vendor confirms the rule.
            const useInquiryRef = isPostpaid &&
                orderData.accountDetails?.use_inquiry_ref === true &&
                orderData.accountDetails?.vendor_ref;
            const effectiveRefId = useInquiryRef
                ? orderData.accountDetails.vendor_ref
                : refId;

            const params = {
                ...this._getAuthParams(),
                product,
                dest,
                refID: effectiveRefId,
            };

            const qty = orderData.qty || orderData.accountDetails?.provider_qty;
            if (qty) {
                params.qty = parseInt(qty);
            }

            okeLog.info('order_create_started', { refId, product });

            const res = await this.client.get('/trx', { params });
            const text = String(res.data || '').trim();

            okeLog.debug('order_create_response_received', { refId });

            const isFailed = text.includes('GAGAL') ||
                             text.includes('Pin Salah') ||
                             text.includes('tidak mencukupi') ||
                             text.includes('Cut Off') ||
                             text.includes('Gangguan') ||
                             (isPostpaid && /TIDAK ADA TAGIHAN|SUDAH BAYAR|SUDAH LUNAS|TIDAK DITEMUKAN/i.test(text));

            // Extract Transaction ID (T#123456789)
            const trxMatch = text.match(/T#([0-9A-Za-z]+)/);
            const transactionId = trxMatch ? trxMatch[1] : null;

            // Extract Ref ID (R#12345)
            const refMatch = text.match(/R#([0-9A-Za-z\-]+)/);
            const extractedRefId = refMatch ? refMatch[1] : effectiveRefId;

            // Extract SN if already provided
            const sn = extractSN(text);


            if (isFailed && !text.includes('akan diproses') && !text.includes('SUKSES') && !text.includes('Sukses')) {
                return {
                    success: false,
                    message: text,
                    vendorOrderId: transactionId || extractedRefId,
                    data: { raw: text },
                };
            }

            return {
                success: true,
                vendorOrderId: transactionId || extractedRefId || effectiveRefId,
                invoice: sn || transactionId || null,
                sn,
                data: {
                    transactionId,
                    refId: extractedRefId,
                    sn,
                    raw: text,
                },
            };
        } catch (error) {
            okeLog.error('order_create_failed', { refId, error });
            return {
                success: false,
                message: error.message || 'Gagal membuat transaksi di OkeConnect',
            };
        }
    }

    /**
     * Check transaction status on OkeConnect.
     * @param {string} refId
     * @param {Object} options - { product, dest, qty }
     */
    async checkOrderStatus(refId, options = {}) {
        try {
            if (!this.memberID || !this.pin || !this.password) {
                return { success: false, message: 'Kredensial OkeConnect belum dikonfigurasi' };
            }

            const params = {
                ...this._getAuthParams(),
                refID: refId,
                check: 1,
            };

            if (options.product) params.product = options.product;
            if (options.dest) params.dest = options.dest;
            if (options.qty) params.qty = options.qty;

            const res = await this.client.get('/trx', { params });
            const text = String(res.data || '').trim();

            const parsed = parseStatusAndSn(text);

            return {
                success: true,
                status: parsed.status,
                sn: parsed.sn,
                data: {
                    raw: text,
                    status: parsed.status,
                    sn: parsed.sn,
                },
            };
        } catch (error) {
            okeLog.error('order_status_check_failed', { refId, error });
            return {
                success: false,
                message: error.message,
            };
        }
    }

    /**
     * Verify incoming webhook / GET callback signature.
     * OkeConnect sends GET request with `refid` and `message`.
     * Secret verification is supported via query parameter `secret` or `token`.
     */
    verifyWebhookSignature(req, signature, secret) {
        const configuredSecret = secret || this.callbackSecret;
        if (!configuredSecret) {
            // If no secret configured, allow callback
            return true;
        }

        const receivedSecret = req?.query?.secret || req?.query?.token || req?.headers?.['x-callback-secret'];
        if (!receivedSecret) {
            return false;
        }

        return receivedSecret === configuredSecret;
    }

    /**
     * Parse incoming GET callback from OkeConnect.
     * Query: { refid: '...', message: '...' }
     */
    parseWebhookEvent(body, headers, query = {}) {
        const refId = query.refid || query.refID || body?.refid || '';
        const message = query.message || body?.message || '';

        const parsed = parseStatusAndSn(message);

        let event = 'order.status_update';
        if (parsed.status === 'success') {
            event = 'order.completed';
        } else if (parsed.status === 'failed') {
            event = 'order.failed';
        }

        return {
            event,
            vendorOrderId: refId,
            status: parsed.status,
            sn: parsed.sn,
            message,
            data: {
                refid: refId,
                message,
                sn: parsed.sn,
            },
        };
    }
}

module.exports = OkeconnectAdapter;

module.exports.__test = {
    isPlnTokenItem,
    isPlnTokenCategory,
    plnRouteLabel,
    plnDenomLabel,
    plnDenomValue,
    extractPlnCustomerName,
    extractPlnTariff,
};
