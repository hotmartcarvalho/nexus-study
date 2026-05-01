// =============================================================================
// /api/mp-subscribe.js — Cria assinatura recorrente no Mercado Pago
// =============================================================================
// V13: Adicionado suporte a cupom de desconto.
// POST /api/mp-subscribe
// Body: {plan_id, billing_period, coupon_code?}
// Headers: Authorization: Bearer <user-token>
//
// Retorna: {checkout_url, mp_subscription_id}
// =============================================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Auth
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação ausente' });
  }
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Body
  const { plan_id, billing_period = 'monthly', coupon_code = null } = req.body;
  if (!plan_id || !['estudante', 'concurseiro', 'pro'].includes(plan_id)) {
    return res.status(400).json({ error: 'plan_id inválido' });
  }
  if (!['monthly', 'yearly'].includes(billing_period)) {
    return res.status(400).json({ error: 'billing_period inválido' });
  }

  // Plano
  const { data: plan, error: planError } = await supabase
    .from('plans').select('*').eq('id', plan_id).single();
  if (planError || !plan) {
    return res.status(404).json({ error: 'Plano não encontrado' });
  }

  // Preço base
  let basePrice = billing_period === 'yearly' ? parseFloat(plan.price_brl_yearly) : parseFloat(plan.price_brl);
  if (!basePrice) basePrice = parseFloat(plan.price_brl);
  let finalPrice = basePrice;

  // Desconto BETA
  const { data: discount } = await supabase
    .from('beta_discounts').select('*').eq('user_id', user.id).maybeSingle();
  let betaDiscountPct = 0;
  let betaDiscountUntil = null;
  if (discount && new Date(discount.expires_at) > new Date()) {
    betaDiscountPct = discount.discount_pct;
    betaDiscountUntil = discount.expires_at;
    finalPrice = parseFloat((finalPrice * (1 - betaDiscountPct / 100)).toFixed(2));
  }

  // V13: Cupom de desconto (cumulativo com BETA)
  let couponDiscountPct = 0;
  let validatedCoupon = null;
  if (coupon_code) {
    const upperCode = String(coupon_code).trim().toUpperCase();
    const { data: couponRow } = await supabase
      .from('coupons')
      .select('*')
      .eq('code', upperCode)
      .eq('active', true)
      .maybeSingle();

    if (couponRow) {
      const now = new Date();
      const validUntil = couponRow.valid_until ? new Date(couponRow.valid_until) : null;
      const validFrom = couponRow.valid_from ? new Date(couponRow.valid_from) : new Date(0);
      const isExpired = validUntil && validUntil < now;
      const isFuture = validFrom > now;
      const isExhausted = couponRow.max_uses && couponRow.uses_count >= couponRow.max_uses;
      const planAllowed = !couponRow.applicable_plans || couponRow.applicable_plans.includes(plan_id);

      let alreadyUsed = false;
      if (couponRow.one_per_user) {
        const { count } = await supabase
          .from('coupon_redemptions')
          .select('*', { count: 'exact', head: true })
          .eq('code', upperCode)
          .eq('user_id', user.id);
        alreadyUsed = (count || 0) > 0;
      }

      if (!isExpired && !isFuture && !isExhausted && planAllowed && !alreadyUsed) {
        couponDiscountPct = couponRow.discount_pct;
        validatedCoupon = couponRow;
        finalPrice = parseFloat((finalPrice * (1 - couponDiscountPct / 100)).toFixed(2));
      }
    }
  }

  // Garantia: preço mínimo de R$ 5 (regra do MP)
  if (finalPrice < 5) finalPrice = 5;

  // Frequência
  const frequency = billing_period === 'yearly' ? 12 : 1;
  const frequencyType = 'months';

  // Preapproval
  const externalRef = `gralia-${user.id}-${plan_id}-${Date.now()}`;
  const mpBody = {
    reason: `Gralia · Plano ${plan.name} (${billing_period === 'yearly' ? 'anual' : 'mensal'})${validatedCoupon ? ` · Cupom ${validatedCoupon.code}` : ''}`,
    auto_recurring: {
      frequency,
      frequency_type: frequencyType,
      transaction_amount: finalPrice,
      currency_id: 'BRL'
    },
    payer_email: user.email,
    back_url: `${process.env.PUBLIC_URL || 'https://gralia.com.br'}/?subscription=success`,
    external_reference: externalRef,
    status: 'pending'
  };

  try {
    const mpRes = await fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mpBody)
    });

    const mpData = await mpRes.json();

    if (!mpRes.ok) {
      console.error('[mp-subscribe] MP error:', mpData);
      return res.status(500).json({
        error: 'Erro do Mercado Pago: ' + (mpData.message || 'desconhecido')
      });
    }

    // Salva subscription pending
    const subInsert = {
      user_id: user.id,
      plan_id,
      status: 'pending',
      billing_period,
      mp_subscription_id: mpData.id,
      mp_payer_email: user.email,
      current_period_end: new Date(Date.now() + (billing_period === 'yearly' ? 365 : 30) * 86400000).toISOString(),
      beta_discount_pct: betaDiscountPct,
      beta_discount_until: betaDiscountUntil
    };
    if (validatedCoupon) {
      subInsert.coupon_code = validatedCoupon.code;
      subInsert.coupon_discount_pct = couponDiscountPct;
    }
    await supabase.from('subscriptions').insert([subInsert]);

    // V13: Registra redemption do cupom (incrementa uses_count via RPC).
    if (validatedCoupon) {
      await supabase.from('coupon_redemptions').insert([{
        code: validatedCoupon.code,
        user_id: user.id,
        plan_id,
        payment_amount: finalPrice
      }]).then(() => {
        supabase.rpc('increment_coupon_uses', { p_code: validatedCoupon.code }).catch(() => {});
      }).catch(e => console.warn('[coupon] redemption insert failed:', e.message));
    }

    return res.status(200).json({
      checkout_url: mpData.init_point,
      mp_subscription_id: mpData.id,
      final_price: finalPrice,
      applied_coupon: validatedCoupon ? validatedCoupon.code : null
    });

  } catch (e) {
    console.error('[mp-subscribe]', e);
    return res.status(500).json({ error: e.message });
  }
}
