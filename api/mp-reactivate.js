// =============================================================================
// /api/mp-reactivate.js — Reativa assinatura cancelada (se ainda dentro do período)
// =============================================================================
// POST /api/mp-reactivate
// Headers: Authorization: Bearer <user-token>
// =============================================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Token inválido' });

  // Busca subscription cancelada mais recente
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .eq('status', 'cancelled')
    .order('cancelled_at', { ascending: false })
    .limit(1)
    .single();

  if (!sub) return res.status(404).json({ error: 'Sem assinatura cancelada' });

  // Verifica se ainda tem acesso (não passou da data de fim)
  if (new Date(sub.current_period_end) < new Date()) {
    return res.status(400).json({ error: 'Período de acesso já expirou. Crie uma nova assinatura.' });
  }

  // Reativa no MP
  if (sub.mp_subscription_id) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${sub.mp_subscription_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'authorized' })
      });
      if (!mpRes.ok) {
        const err = await mpRes.text();
        console.warn('[mp-reactivate] MP error:', err);
      }
    } catch (e) {
      console.error('[mp-reactivate] MP error:', e);
    }
  }

  // Atualiza no DB
  await supabase.from('subscriptions').update({
    status: 'active',
    cancelled_at: null,
    cancellation_reason: null,
    cancellation_feedback: null,
    updated_at: new Date().toISOString()
  }).eq('id', sub.id);

  return res.status(200).json({ ok: true });
}
