// =============================================================================
// /api/mp-webhook.js — Recebe notificações do Mercado Pago
// =============================================================================
// V13: Adicionado processamento de comissão de afiliado quando subscription
// é autorizada ou quando uma mensalidade é cobrada.
//
// Configurar em: https://www.mercadopago.com.br/developers/panel/webhooks
//   URL: https://gralia.com.br/api/mp-webhook
//   Eventos: payment, subscription_preapproval, subscription_authorized_payment
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
      // Pagamento avulso (top-up)
      const paymentRes = await fetch(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { 'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}` }
      });
      const payment = await paymentRes.json();

      if (payment.metadata?.type === 'topup' && payment.status === 'approved') {
        const userId = payment.metadata.user_id;
        const credits = parseInt(payment.metadata.credits, 10);

        await supabase.from('topup_purchases').update({
          mp_status: 'approved',
          approved_at: new Date().toISOString()
        }).eq('mp_payment_id', String(dataId));

        const { data: cur } = await supabase
          .from('user_credits').select('topup_credits').eq('user_id', userId).maybeSingle();

        if (cur) {
          await supabase.from('user_credits').update({
            topup_credits: cur.topup_credits + credits,
            updated_at: new Date().toISOString()
          }).eq('user_id', userId);
        } else {
          await supabase.from('user_credits').insert([{
            user_id: userId,
            plan_credits: 0,
            topup_credits: credits
          }]);
        }
        console.log('[mp-webhook] topup approved:', userId, credits, 'credits');
      }
    } else if (type === 'subscription_preapproval' || type === 'preapproval' || type === 'subscription_authorized_payment') {
      // Assinatura criada / autorizada / pagamento mensal cobrado
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

      // Atualiza subscription
      await supabase.from('subscriptions').update({
        status: internalStatus,
        updated_at: new Date().toISOString()
      }).eq('mp_subscription_id', String(dataId));

      // Se autorizou pela primeira vez OU é uma cobrança recorrente: reseta créditos + processa comissão
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

          // V13: Processa comissão de afiliado (se houver)
          const paymentAmount = parseFloat(pre.auto_recurring?.transaction_amount || 0);
          if (paymentAmount > 0) {
            try {
              await supabase.rpc('process_affiliate_commission', {
                p_user_id: sub.user_id,
                p_payment_amount: paymentAmount
              });
              console.log('[mp-webhook] affiliate commission processed for', sub.user_id, paymentAmount);
            } catch (e) {
              // Função pode não existir ainda — não é fatal
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
