// =============================================================================
// /api/turnstile-verify.js — V1 (V15.12.75.38)
// =============================================================================
// Valida token Cloudflare Turnstile via Siteverify API.
// Chamado pelo cliente APÓS resolver o widget de captcha, ANTES de prosseguir
// com signup. Retorna { success: true } se token é válido.
//
// Por que servidor: a Secret Key NUNCA pode estar no cliente. O token gerado
// pelo widget só prova "não sou bot" se for validado server-side com a Secret.
//
// REQUISITOS:
// - Env var TURNSTILE_SECRET_KEY (Project Settings → Environment Variables)
//
// SEGURANÇA:
// - Tokens expiram em 5 min e só podem ser validados UMA vez
// - Hostname do request deve bater com hostname configurado no widget
// - Retorna error claro mas sem expor detalhes internos
// =============================================================================

export default async function handler(req, res) {
  // CORS — permite chamada do próprio domínio Vercel + futuras integrações
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'method_not_allowed' });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    console.error('[turnstile-verify] TURNSTILE_SECRET_KEY ausente nas env vars');
    return res.status(500).json({ success: false, error: 'config_missing' });
  }

  const { token } = req.body || {};
  if (!token || typeof token !== 'string' || token.length < 10) {
    return res.status(400).json({ success: false, error: 'invalid_token_format' });
  }

  // IP do cliente — útil pro Siteverify cruzar com o IP em que o token foi gerado
  // Vercel popula automaticamente x-forwarded-for
  const remoteip =
    (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secret);
    formData.append('response', token);
    if (remoteip) formData.append('remoteip', remoteip);

    const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    if (!cfRes.ok) {
      console.warn('[turnstile-verify] Siteverify retornou HTTP', cfRes.status);
      return res.status(502).json({ success: false, error: 'siteverify_unavailable' });
    }

    const data = await cfRes.json();

    if (data.success) {
      // Token válido. Retorna também hostname e action pra log auditável
      return res.status(200).json({
        success: true,
        hostname: data.hostname || null,
        challenge_ts: data.challenge_ts || null,
      });
    }

    // Token inválido — pode ser expirado, já usado, ou bot
    const errorCodes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    console.warn('[turnstile-verify] Token rejeitado:', errorCodes.join(', '));
    return res.status(200).json({
      success: false,
      error: 'token_invalid',
      codes: errorCodes,
    });
  } catch (err) {
    console.error('[turnstile-verify] Exception:', err.message);
    return res.status(500).json({ success: false, error: 'verify_exception' });
  }
}
