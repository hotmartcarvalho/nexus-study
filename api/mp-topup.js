// =============================================================================
// /api/mp-topup.js — Cria pagamento único pra pacote de créditos avulsos
// =============================================================================
// POST /api/mp-topup
// Body: {package_id: 'topup_100' | 'topup_300' | 'topup_1000'}
// Headers: Authorization: Bearer <user-token>
//
// Retorna: {checkout_url: string}
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

  const { package_id } = req.body;
  if (!package_id) return res.status(400).json({ error: 'package_id obrigatório' });

  const { data: pkg, error: pkgError } = await supabase
    .from('topup_packages').select('*').eq('id', package_id).eq('is_active', true).single();
  if (pkgError || !pkg) return res.status(404).json({ error: 'Pacote não encontrado' });

  const externalRef = `gralia-topup-${user.id}-${pkg.id}-${Date.now()}`;

  // Cria preference (pagamento único) no MP
  const mpBody = {
    items: [{
      title: `Gralia · ${pkg.name}`,
      description: `${pkg.credits} créditos avulsos`,
      quantity: 1,
      unit_price: parseFloat(pkg.price_brl),
      currency_id: 'BRL'
    }],
    payer: { email: user.email },
    back_urls: {
      success: `${process.env.PUBLIC_URL || 'https://gralia.com.br'}/?topup=success`,
      failure: `${process.env.PUBLIC_URL || 'https://gralia.com.br'}/?topup=failure`,
      pending: `${process.env.PUBLIC_URL || 'https://gralia.com.br'}/?topup=pending`
    },
    auto_return: 'approved',
    external_reference: externalRef,
    notification_url: `${process.env.PUBLIC_URL || 'https://gralia.com.br'}/api/mp-webhook`,
    metadata: {
      type: 'topup',
      user_id: user.id,
      package_id: pkg.id,
      credits: pkg.credits
    }
  };

  try {
    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(mpBody)
    });
    const mpData = await mpRes.json();

    if (!mpRes.ok) {
      console.error('[mp-topup] MP error:', mpData);
      return res.status(500).json({ error: 'Erro do Mercado Pago: ' + (mpData.message || 'desconhecido') });
    }

    // Salva topup pending
    await supabase.from('topup_purchases').insert([{
      user_id: user.id,
      package_id: pkg.id,
      credits: pkg.credits,
      amount_brl: pkg.price_brl,
      mp_payment_id: mpData.id,
      mp_status: 'pending'
    }]);

    return res.status(200).json({
      checkout_url: mpData.init_point,
      preference_id: mpData.id
    });

  } catch (e) {
    console.error('[mp-topup]', e);
    return res.status(500).json({ error: e.message });
  }
}
