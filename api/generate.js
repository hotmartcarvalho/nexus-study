// api/generate.js — Fase 2a
// Endpoint serverless protegido:
// 1. Valida JWT do Supabase (requer login)
// 2. (Opcional) Checa whitelist de emails permitidos
// 3. Checa quota do usuário (créditos disponíveis)
// 4. Chama Anthropic
// 5. Decrementa 1 crédito se a chamada foi bem-sucedida
//
// Env vars necessárias no Vercel:
//   ANTHROPIC_API_KEY        — sua chave Anthropic
//   SUPABASE_URL             — URL do projeto Supabase
//   SUPABASE_SERVICE_ROLE_KEY — service_role key (Supabase → Settings → API)
//
// Env vars opcionais:
//   ALLOWED_EMAILS           — CSV de emails permitidos (ex: "voce@gmail.com,amigo@gmail.com")
//                               Se vazio/ausente, qualquer usuário autenticado pode usar.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, anthropic-version');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const missing = [];
  if (!apiKey) missing.push('ANTHROPIC_API_KEY');
  if (!supabaseUrl) missing.push('SUPABASE_URL');
  if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length > 0) {
    console.error('Missing env vars:', missing);
    return res.status(500).json({
      error: 'Servidor mal configurado. Env vars ausentes: ' + missing.join(', ')
    });
  }

  // 1. Extrai e valida JWT
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Autenticação necessária. Faça login.' });
  }

  const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  let user;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    }
    user = data.user;
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao validar sessão.' });
  }

  // 2. Whitelist (opcional, recomendado durante beta)
 // const allowedEmails = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean);
 // if (allowedEmails.length > 0 && !allowedEmails.includes(user.email)) {
 //   return res.status(403).json({
  //    error: 'Este site está em teste privado. Seu email não está na lista de convidados.'
  //  });
 // }

  // V12: Importação de fontes/questões é GRATUITA pro usuário (custo é da plataforma).
  // Quando free_action está presente no body, pula a verificação de créditos e o decrement.
  // Razão: importação é a porta de entrada — bloquear por créditos cria atrito ruim.
  // E o conteúdo importado enriquece o cache compartilhado pra comunidade.
  // Lista de ações gratuitas controlada explicitamente pra evitar abuso:
  const FREE_ACTIONS = ['organize_import', 'extract_questions_pdf', 'classify_imported_question'];
  const isFreeAction = req.body && req.body.free_action && FREE_ACTIONS.includes(req.body.free_action);

  // 3. Checa quota — V12: lê direto de user_credits (plan + topup)
  // Antes lia de user_quota (tabela velha) que dessincronizava com admin_grant_credits.
  // Pula se for free_action.
  if (!isFreeAction) {
    try {
      let { data: credits, error: qErr } = await supabaseAdmin
        .from('user_credits')
        .select('plan_credits, topup_credits')
        .eq('user_id', user.id)
        .maybeSingle();

      if (qErr) {
        console.error('Credits SELECT error:', JSON.stringify(qErr));
        return res.status(500).json({
          error: 'Erro ao verificar créditos: ' + (qErr.message || qErr.code || 'desconhecido')
        });
      }

      // Auto-create se não existe (fallback do trigger create_trial_on_signup)
      if (!credits) {
        console.warn('user_credits missing for user', user.id, '- creating with 40 trial credits');
        const { data: created, error: insErr } = await supabaseAdmin
          .from('user_credits')
          .insert({
            user_id: user.id,
            plan_credits: 40,
            topup_credits: 0,
            last_reset_at: new Date().toISOString()
          })
          .select('plan_credits, topup_credits')
          .single();
        if (insErr) {
          console.error('user_credits INSERT error:', JSON.stringify(insErr));
          return res.status(500).json({
            error: 'Erro ao criar créditos: ' + (insErr.message || insErr.code || 'desconhecido')
          });
        }
        credits = created;
      }

      const totalCredits = (credits.plan_credits || 0) + (credits.topup_credits || 0);

      // Pega plano (pra retornar no erro)
      let planLabel = 'trial';
      try {
        const { data: sub } = await supabaseAdmin
          .from('subscriptions')
          .select('plan_id')
          .eq('user_id', user.id)
          .in('status', ['active', 'trialing'])
          .maybeSingle();
        if (sub && sub.plan_id) planLabel = sub.plan_id;
      } catch (_e) { /* ignore */ }

      if (totalCredits <= 0) {
        return res.status(402).json({ error: 'Créditos esgotados', code: 'NO_CREDITS', plan: planLabel });
      }
    } catch (err) {
      console.error('Quota check exception:', err.message, err.stack);
      return res.status(500).json({
        error: 'Erro ao verificar créditos: ' + (err.message || 'exceção desconhecida')
      });
    }
  } else {
    console.log(`[free_action] ${req.body.free_action} for user ${user.id} — skipping credit check`);
  }

  // 4. Valida body
  const { model, system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Campo "messages" é obrigatório (array).' });
  }
  if (!model) {
    return res.status(400).json({ error: 'Campo "model" é obrigatório.' });
  }

  // 5. Chama Anthropic
  let anthropicResponse;
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens: max_tokens || 2500, system, messages })
    });

    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const msg = (data && (data.error?.message || data.message)) || 'Erro na API Anthropic';
      return res.status(upstream.status).json({ error: `${upstream.status}: ${msg}` });
    }
    anthropicResponse = data;
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao chamar a API: ' + (err.message || 'erro desconhecido') });
  }

  // 6. Decrementa crédito após sucesso — só se NÃO for free_action
  if (!isFreeAction) {
    try {
      const { data: newBalance } = await supabaseAdmin
        .rpc('decrement_credits', { target_user: user.id, amount: 1 });
      if (typeof newBalance === 'number' && newBalance >= 0) {
        res.setHeader('X-Credits-Remaining', String(newBalance));
      }
    } catch (err) {
      console.error('Decrement error:', err);
    }
  }

  return res.status(200).json(anthropicResponse);
}
