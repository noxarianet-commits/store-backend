const VendorAdapter = require('./VendorAdapter');
const axios = require('axios');
const EventEmitter = require('events');
const cacheService = require('../cacheService');

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
     * Fetch products catalog from OkeConnect JSON price list.
     * Filters strictly for E-Wallet and Topup Game products.
     * Normalized into unified product hierarchy with `is_hidden = true` by default.
     * @param {Object} params - { type: 'full'|'delta' }
     */
    async fetchProducts(params = {}) {
        try {
            console.log(`[OkeconnectAdapter] Fetching price list from ${this.priceListUrl}?id=${this.priceListId}&produk=saldo_gojek,digital...`);
            const res = await axios.get(this.priceListUrl, {
                params: {
                    id: this.priceListId,
                    produk: 'saldo_gojek,digital',
                },
                timeout: 30000,
            });

            const rawItems = Array.isArray(res.data) ? res.data : [];
            if (rawItems.length === 0) {
                return {
                    success: false,
                    message: 'Katalog produk OkeConnect kosong atau format tidak valid',
                };
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

            for (const item of rawItems) {
                const groupName = (item.produk || 'Lainnya').trim();
                const lowerGroup = groupName.toLowerCase();

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

            console.log(`[OkeconnectAdapter] Successfully parsed ${normalizedProducts.length} product groups (${rawItems.length} total variants).`);

            return {
                success: true,
                data: normalizedProducts,
                serverTime: new Date().toISOString(),
            };
        } catch (error) {
            console.error('[OkeconnectAdapter] fetchProducts error:', error.message);
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
            console.error('[OkeconnectAdapter] getBalance error:', error.message);
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
        const customerId = params.customerId || params.customer_id || params.user_id || params.target;
        const zoneId = params.zoneId || params.zone_id || null;

        if (!customerId) {
            return { success: false, valid: false, message: 'User ID / Nomor Tujuan wajib diisi' };
        }

        const inqCode = this._resolveInquiryCode(params);
        if (!inqCode || !this.memberID || !this.pin || !this.password) {
            // Fail-open gracefully if no inquiry code available or credentials not yet added
            return { success: true, valid: true, data: { account_name: customerId, display_name: customerId } };
        }

        let dest = String(customerId).trim();
        if (zoneId) {
            dest = `${dest}(${zoneId})`;
        }

        // Check in-memory cache first for instant (<2ms) response
        const cacheKey = cacheService.KEYS.ACCOUNT_VALIDATION('okeconnect', `${inqCode}_${dest}`);
        const cached = cacheService.get(cacheKey);
        if (cached !== undefined) {
            console.log(`[OkeconnectAdapter] Cache hit for account validation: ${dest}`);
            return cached;
        }

        try {
            const tempRefId = `INQ${Date.now().toString(36).toUpperCase()}`;

            console.log(`[OkeconnectAdapter] Validating account with code=${inqCode}, dest=${dest}, refID=${tempRefId}...`);

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
            console.log(`[OkeconnectAdapter] Inquiry response for ${dest}:`, text);

            const initialParsed = parseStatusAndSn(text);

            let finalText = text;
            let finalStatus = initialParsed.status;
            let finalSn = initialParsed.sn;

            // If initial response is pending / "akan diproses", wait for webhook callback or poll
            if (finalStatus === 'pending' || text.includes('akan diproses') || text.includes('Menunggu Jawaban')) {
                console.log(`[OkeconnectAdapter] Waiting for inquiry callback for ${tempRefId}...`);
                const callbackEvent = await waitForCallback;
                if (callbackEvent) {
                    finalText = callbackEvent.message || finalText;
                    finalStatus = callbackEvent.status;
                    finalSn = callbackEvent.sn;
                    console.log(`[OkeconnectAdapter] Inquiry callback received for ${tempRefId}: status=${finalStatus}, sn=${finalSn}`);
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

            if (finalStatus === 'failed' || finalText.includes('GAGAL') || finalText.includes('Salah') || finalText.includes('Tidak Ditemukan') || finalText.includes('TIDAK ADA')) {
                const errMsg = extractErrorMessage(finalText);
                return {
                    success: false,
                    valid: false,
                    message: errMsg || 'Akun tidak ditemukan atau ID salah',
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
            console.warn('[OkeconnectAdapter] validateAccount error:', error.message);
            return {
                success: false,
                valid: false,
                message: error.message || 'Gagal memvalidasi akun ke OkeConnect',
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

            if (customerId && zoneId && !dest.includes('(')) {
                dest = `${customerId}(${zoneId})`;
            }

            if (!dest) {
                throw new Error('Nomor tujuan / User ID tujuan tidak boleh kosong');
            }

            const params = {
                ...this._getAuthParams(),
                product,
                dest,
                refID: refId,
            };

            const qty = orderData.qty || orderData.accountDetails?.provider_qty;
            if (qty) {
                params.qty = parseInt(qty);
            }

            console.log(`[OkeconnectAdapter] Creating order refID=${refId}, product=${product}, dest=${dest}...`);

            const res = await this.client.get('/trx', { params });
            const text = String(res.data || '').trim();

            console.log(`[OkeconnectAdapter] Response for refID=${refId}:`, text);

            const isFailed = text.includes('GAGAL') ||
                             text.includes('Pin Salah') ||
                             text.includes('tidak mencukupi') ||
                             text.includes('Cut Off') ||
                             text.includes('Gangguan');

            // Extract Transaction ID (T#123456789)
            const trxMatch = text.match(/T#([0-9A-Za-z]+)/);
            const transactionId = trxMatch ? trxMatch[1] : null;

            // Extract Ref ID (R#12345)
            const refMatch = text.match(/R#([0-9A-Za-z\-]+)/);
            const extractedRefId = refMatch ? refMatch[1] : refId;

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
                vendorOrderId: transactionId || extractedRefId || refId,
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
            console.error(`[OkeconnectAdapter] createOrder error:`, error.message);
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
            console.error(`[OkeconnectAdapter] checkOrderStatus error:`, error.message);
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
