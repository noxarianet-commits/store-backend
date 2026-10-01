const supabase = require('../supabase');

class BalanceService {
    async creditBalance(userId, amount, type, referenceId, description) {
        const { data, error } = await supabase.rpc('credit_balance', {
            p_user_id: userId,
            p_amount: amount,
            p_type: type,
            p_reference_id: referenceId,
            p_description: description
        });
        if (error) throw error;
        return data;
    }

    /**
     * Kredit top-up yang SUDAH punya baris di balance_transactions (pending).
     *
     * Seluruh pekerjaan (claim pending->completed, update saldo, set credited_at)
     * dilakukan oleh RPC credit_topup dalam SATU transaksi DB, jadi hasilnya
     * idempoten: webhook gateway, cron 1 menit, dan polling user bisa berjalan
     * bersamaan untuk top-up yang sama tanpa ada yang dobel-kredit.
     *
     * JANGAN kembalikan ke pola select-then-update di sini — itu celah yang
     * exploitable. Selalu panggil fungsi ini, jangan creditBalance(), untuk
     * top-up yang punya baris pending.
     */
    async creditTopup(tx) {
        if (!tx || !tx.id) {
            throw new Error('Data transaksi topup tidak valid');
        }

        const { data, error } = await supabase.rpc('credit_topup', { p_topup_id: tx.id });
        if (error) throw error;

        // Sudah dikreditkan oleh pemanggil lain — bukan error.
        if (data?.already_processed) return { alreadyProcessed: true };

        // Kredit ditolak (mis. lewat balance_limit). Ini kegagalan sungguhan:
        // user sudah bayar tapi saldonya belum bertambah, jadi HARUS dilempar
        // supaya pemanggil logged, bukan dilaporkan sebagai sukses.
        if (!data?.success) {
            throw new Error(data?.error || 'Gagal kredit saldo top-up');
        }

        return data;
    }

    async debitBalance(userId, amount, referenceId, description) {
        const { data, error } = await supabase.rpc('debit_balance', {
            p_user_id: userId,
            p_amount: amount,
            p_reference_id: referenceId,
            p_description: description
        });
        if (error) throw error;
        return data;
    }

    async refundBalance(userId, amount, orderId, description) {
        const { data, error } = await supabase.rpc('refund_balance', {
            p_user_id: userId,
            p_amount: amount,
            p_order_id: orderId,
            p_description: description
        });
        if (error) throw error;
        return data;
    }

    async getBalance(userId) {
        const { data, error } = await supabase
            .from('user_profiles')
            .select('balance, balance_limit')
            .eq('id', userId)
            .single();
        if (error) throw error;
        return data;
    }

    async getHistory(userId, page = 1, limit = 10, type = null) {
        const offset = (page - 1) * limit;
        
        let countQuery = supabase
            .from('balance_transactions')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', userId);

        let dataQuery = supabase
            .from('balance_transactions')
            .select('*')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (type && type !== 'semua' && type !== 'ALL') {
            countQuery = countQuery.eq('type', type);
            dataQuery = dataQuery.eq('type', type);
        }

        const { count, error: countError } = await countQuery;
        if (countError) throw countError;

        const { data, error } = await dataQuery;
        if (error) throw error;

        return {
            data,
            pagination: {
                total: count || 0,
                page,
                limit,
                totalPages: Math.ceil((count || 0) / limit) || 1
            }
        };
    }
}

module.exports = new BalanceService();
