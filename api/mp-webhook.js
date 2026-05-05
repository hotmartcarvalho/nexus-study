// =============================================================================
// /api/mp-webhook.js — V2 (FASE B — top-up atômico + idempotente)
// =============================================================================
// Substitui o read-modify-write antigo (linhas 53-67 da v1) por
// add_topup_credits_atomic. Vantagens:
//
// 1. ATÔMICO: INSERT...ON CONFLICT DO UPDATE em uma transação. Sem race
//    condition entre SELECT e UPDATE.
// 2. IDEMPOTENTE: passa mp_payment_id; se o mesmo evento chegar duas vezes
//    (retry do MP, nova tentativa de webhook), a RPC detecta que já foi
//    processado e retorna duplicate=true sem cobrar de novo.
// 3. Marca topup_purchases.mp_status='approved' dentro da mesma transação.
//
// REQUISITOS:
// - RPC add_topup_credits_atomic (criada em gralia-credits-system-v3.1.sql)
//
// O resto do arquivo (assinaturas, comissão de afiliado) fica IGUAL ao V1.
// =============================================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Resposta IMEDIATA pro MP (importante: não pode demorar)
  res.status(200).json({ received: true });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const body = req.body;
  const type = body.type || body.action;
  const dataId = body.data?.id;

  if (!dataId) {
    console.warn('[mp-webhook] missing data.id', body);
    return;
  }

  try {
    if (type === 'payment' || type === 'payment.updated' || type === 'payment.created') {
      // -----------------------------------------------------------------
      // Pagamento avulso (top-up) — V2: usa add_topup_credits_atomic
      // -----------------------------------------------------------------
      const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const payment = await paymentRes.json();

      if (payment.metadata?.type === 'topup' && payment.status === 'approved') {
        const userId = payment.metadata.user_id;
        const credits = parseInt(payment.metadata.credits, 10);

        if (!userId || !Number.isFinite(credits) || credits <= 0) {
          console.error('[mp-webhook] topup metadata inválido:', payment.metadata);
          return;
        }

        // V2: uma única chamada atômica + idempotente. mp_payment_id é a chave.
        const { data: result, error: addErr } = await supabase.rpc('add_topup_credits_atomic', {
          p_user_id: userId,
          p_credits: credits,
          p_mp_payment_id: String(dataId)
        });

        if (addErr) {
          console.error('[mp-webhook] add_topup_credits_atomic error:', addErr);
          return;
        }

        if (result?.duplicate) {
          console.log('[mp-webhook] topup já processado anteriormente (idempotente):', userId, 'mp_payment_id:', dataId);
        } else if (result?.success) {
          console.log('[mp-webhook] topup approved:', userId, '+'+credits, 'créditos. Saldo:', result.new_balance);
        } else {
          console.error('[mp-webhook] add_topup_credits_atomic non-success:', result);
        }
      }
    } else if (type === 'subscription_preapproval' || type === 'preapproval' || type === 'subscription_authorized_payment') {
      // -----------------------------------------------------------------
      // Assinatura — IGUAL ao V1
      // -----------------------------------------------------------------
      const preRes = await fetch(`https://api.mercadopago.com/preapproval/${dataId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const pre = await preRes.json();

      const statusMap = {
        'authorized': 'active',
        'paused': 'suspended',
        'cancelled': 'cancelled',
        'pending': 'pending'
      };
      const internalStatus = statusMap[pre.status] || pre.status;

      await supabase.from('subscriptions').update({
        status: internalStatus,
        updated_at: new Date().toISOString()
      }).eq('mp_subscription_id', String(dataId));

      if (pre.status === 'authorized') {
        const { data: sub } = await supabase
          .from('subscriptions').select('user_id, plan_id, billing_period')
          .eq('mp_subscription_id', String(dataId)).single();

        if (sub) {
          const { data: plan } = await supabase
            .from('plans').select('credits_per_month').eq('id', sub.plan_id).single();

          if (plan) {
            await supabase.rpc('reset_plan_credits', { p_user_id: sub.user_id });
            console.log('[mp-webhook] subscription authorized:', sub.user_id, 'plan:', sub.plan_id);
          }

          // V13: comissão de afiliado
          const paymentAmount = parseFloat(pre.auto_recurring?.transaction_amount || 0);
          if (paymentAmount > 0) {
            try {
              await supabase.rpc('process_affiliate_commission', {
                p_user_id: sub.user_id,
                p_payment_amount: paymentAmount
              });
              console.log('[mp-webhook] affiliate commission processed for', sub.user_id, paymentAmount);
            } catch (e) {
              console.warn('[mp-webhook] affiliate commission failed:', e.message);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('[mp-webhook] error:', e);
  }
}
