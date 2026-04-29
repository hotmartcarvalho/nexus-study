// =============================================================================
// /api/mp-cancel.js — Cancela assinatura (mantém acesso até fim do período pago)
// =============================================================================
// POST /api/mp-cancel
// Body: {primary_reason, feedback}
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

  const { primary_reason, feedback } = req.body || {};

  // Busca subscription ativa
  const { data: sub } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', user.id)
    .in('status', ['active', 'trialing', 'pending'])
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!sub) return res.status(404).json({ error: 'Sem assinatura ativa' });

  // Se tem MP subscription_id, cancela no MP (não cobra mais)
  if (sub.mp_subscription_id) {
    try {
      const mpRes = await fetch(`https://api.mercadopago.com/preapproval/${sub.mp_subscription_id}`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'cancelled' })
      });
      if (!mpRes.ok) {
        const err = await mpRes.text();
        console.warn('[mp-cancel] MP returned error:', err);
      }
    } catch (e) {
      console.error('[mp-cancel] MP error:', e);
    }
  }

  // Marca subscription como cancelada localmente (mas mantém acesso até period_end)
  await supabase.from('subscriptions').update({
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancellation_reason: primary_reason || 'unspecified',
    cancellation_feedback: feedback || null,
    updated_at: new Date().toISOString()
  }).eq('id', sub.id);

  // Salva feedback estruturado
  if (primary_reason) {
    await supabase.from('cancellation_feedback').insert([{
      user_id: user.id,
      subscription_id: sub.id,
      primary_reason,
      detailed_feedback: feedback || null,
      saved_offer_accepted: false
    }]).select();
  }

  return res.status(200).json({
    ok: true,
    access_until: sub.current_period_end
  });
}
