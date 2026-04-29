// =============================================================================
// /api/mp-subscribe.js — Cria assinatura recorrente no Mercado Pago
// =============================================================================
// POST /api/mp-subscribe
// Body: {plan_id: 'estudante'|'concurseiro'|'pro', billing_period: 'monthly'|'yearly'}
// Headers: Authorization: Bearer <user-token>
//
// Retorna: {checkout_url: string}
//
// Variáveis de ambiente necessárias na Vercel:
//   MP_ACCESS_TOKEN — Access Token do Mercado Pago (production)
//                     Obtenha em: https://www.mercadopago.com.br/developers/panel/credentials
//   MP_PUBLIC_KEY   — opcional pra checkout transparente
//   SUPABASE_URL    — já existe
//   SUPABASE_SERVICE_ROLE_KEY — já existe
//   PUBLIC_URL      — URL pública do site (ex: https://gralia.com.br)
// =============================================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Pega o token de auth
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação ausente' });
  }
  const token = authHeader.replace('Bearer ', '');

  // Valida token via Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  // Body
  const { plan_id, billing_period = 'monthly' } = req.body;
  if (!plan_id || !['estudante', 'concurseiro', 'pro'].includes(plan_id)) {
    return res.status(400).json({ error: 'plan_id inválido' });
  }
  if (!['monthly', 'yearly'].includes(billing_period)) {
    return res.status(400).json({ error: 'billing_period inválido' });
  }

  // Busca o plano
  const { data: plan, error: planError } = await supabase
    .from('plans').select('*').eq('id', plan_id).single();
  if (planError || !plan) {
    return res.status(404).json({ error: 'Plano não encontrado' });
  }

  // Calcula preço (com desconto BETA se aplicável)
  let basePrice = billing_period === 'yearly' ? parseFloat(plan.price_brl_yearly) : parseFloat(plan.price_brl);
  if (!basePrice) basePrice = parseFloat(plan.price_brl);

  // Aplica desconto BETA
  const { data: discount } = await supabase
    .from('beta_discounts').select('*').eq('user_id', user.id).maybeSingle();
  let finalPrice = basePrice;
  if (discount && new Date(discount.expires_at) > new Date()) {
    finalPrice = parseFloat((basePrice * (1 - discount.discount_pct / 100)).toFixed(2));
  }

  // Frequência da assinatura
  const frequency = billing_period === 'yearly' ? 12 : 1;
  const frequencyType = 'months';

  // Cria preapproval no Mercado Pago
  const externalRef = `gralia-${user.id}-${plan_id}-${Date.now()}`;
  const mpBody = {
    reason: `Gralia · Plano ${plan.name} (${billing_period === 'yearly' ? 'anual' : 'mensal'})`,
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

    // Salva subscription pending no DB (atualiza via webhook quando ficar autorizada)
    await supabase.from('subscriptions').insert([{
      user_id: user.id,
      plan_id,
      status: 'pending',
      billing_period,
      mp_subscription_id: mpData.id,
      mp_payer_email: user.email,
      current_period_end: new Date(Date.now() + (billing_period === 'yearly' ? 365 : 30) * 86400000).toISOString(),
      beta_discount_pct: discount?.discount_pct || 0,
      beta_discount_until: discount?.expires_at || null
    }]);

    return res.status(200).json({
      checkout_url: mpData.init_point,
      mp_subscription_id: mpData.id
    });

  } catch (e) {
    console.error('[mp-subscribe]', e);
    return res.status(500).json({ error: e.message });
  }
}
