// =============================================================================
// /api/generate.js — V3 (FASE B — final)
// =============================================================================
// SEM fallback genérico. Toda chamada exige action_id válido.
//
// Mudanças em relação ao V2:
//
// 1. SEM "legacy_call" fallback. Se action_id ausente → 400 imediatamente.
// 2. Ação desconhecida → 400 imediatamente (não cobra 1 crédito sem catálogo).
// 3. Validação de admin_only: se action.admin_only=true, exige is_admin()
//    server-side. Não-admin → 403.
// 4. Validação de batch_size: se action.max_batch_size > 0 e o body passa
//    batch_size, valida que batch_size <= max_batch_size. Senão → 400.
// 5. status do log:
//    - success / free
//    - insufficient_credits  (em vez de no_credits)
//    - invalid_action        (action_id desconhecido)
//    - admin_blocked         (não-admin tentou ação admin_only)
//    - batch_too_large       (excedeu max_batch_size)
//    - anthropic_error_refunded
//    - network_error_refunded
//    - duplicate_blocked     (idempotency-key duplicada)
//
// REQUISITOS NO SUPABASE:
// - Tabelas: ai_actions, ai_usage_log, admin_audit_log
// - RPCs: charge_credits_atomic, refund_credits, log_ai_usage,
//         find_idempotent_response, get_action_cost
// - Função is_admin() que aceita p_user_id (ou usa auth.uid() interno)
//
// ENV VARS:
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// =============================================================================

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type, Authorization, anthropic-version, Idempotency-Key, idempotency-key');
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
    console.error('[generate] Missing env vars:', missing);
    return res.status(500).json({ error: 'Servidor mal configurado.' });
  }

  const supa = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ---------------------------------------------------------------------------
  // 1. JWT
  // ---------------------------------------------------------------------------
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Autenticação necessária. Faça login.' });
  }

  let user;
  try {
    const { data, error } = await supa.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Sessão inválida. Faça login novamente.' });
    }
    user = data.user;
  } catch (err) {
    return res.status(401).json({ error: 'Falha ao validar sessão.' });
  }

  // ---------------------------------------------------------------------------
  // 2. Validação do body — action_id é OBRIGATÓRIO
  // ---------------------------------------------------------------------------
  const body = req.body || {};
  const { model, system, messages, max_tokens, action_id, batch_size } = body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Campo "messages" é obrigatório.' });
  }
  if (!model) {
    return res.status(400).json({ error: 'Campo "model" é obrigatório.' });
  }
  if (!action_id || typeof action_id !== 'string' || action_id.length > 64) {
    return res.status(400).json({
      error: 'Campo "action_id" é obrigatório e inválido.',
      code: 'MISSING_ACTION_ID'
    });
  }
  if (batch_size !== undefined && batch_size !== null) {
    if (typeof batch_size !== 'number' || !Number.isInteger(batch_size) || batch_size < 1) {
      return res.status(400).json({ error: 'Campo "batch_size" inválido (inteiro >= 1).' });
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Idempotency-Key (dedup de retry)
  // ---------------------------------------------------------------------------
  const idempotencyKey = (req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || '').trim() || null;
  if (idempotencyKey) {
    if (idempotencyKey.length > 100 || !/^[a-zA-Z0-9_-]+$/.test(idempotencyKey)) {
      return res.status(400).json({ error: 'Idempotency-Key inválido.' });
    }
    try {
      const { data: existing } = await supa.rpc('find_idempotent_response', { p_key: idempotencyKey });
      if (existing && existing.found) {
        return res.status(409).json({
          error: 'Esta requisição já foi processada anteriormente.',
          code: 'DUPLICATE_REQUEST',
          previous_status: existing.status,
          processed_at: existing.created_at,
          credits_charged_previously: existing.credits_charged || 0
        });
      }
    } catch (e) {
      console.warn('[generate] idempotency check failed:', e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Resolve custo + metadados da ação (server-side, fonte da verdade)
  // ---------------------------------------------------------------------------
  let costInfo;
  try {
    const { data, error } = await supa.rpc('get_action_cost', {
      p_action_id: action_id, p_model: model
    });
    if (error) throw error;
    costInfo = data;
  } catch (err) {
    console.error('[generate] get_action_cost error:', err);
    return res.status(500).json({ error: 'Erro ao consultar catálogo de ações.' });
  }

  // Ação desconhecida → 400 + log (sem cobrar)
  if (!costInfo || costInfo.found === false) {
    supa.rpc('log_ai_usage', {
      p_user_id: user.id, p_action_id: action_id, p_model: model,
      p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
      p_credits_charged: 0, p_status: 'invalid_action', p_http_status: 400,
      p_error_msg: 'Ação não cadastrada em ai_actions',
      p_idempotency_key: idempotencyKey, p_duration_ms: 0
    }).then(() => {}, () => {});
    return res.status(400).json({
      error: `Ação desconhecida: "${action_id}". Não cadastrada no catálogo.`,
      code: 'INVALID_ACTION'
    });
  }

  const cost = parseInt(costInfo.cost, 10);
  const isFree = !!costInfo.is_free;
  const adminOnly = !!costInfo.admin_only;
  const maxBatch = costInfo.max_batch_size || null;

  // ---------------------------------------------------------------------------
  // 5. admin_only check
  // ---------------------------------------------------------------------------
  if (adminOnly) {
    let isAdmin = false;
    try {
      // Cria client COM o JWT do usuário pra que auth.uid() funcione no is_admin()
      const supaUser = createClient(supabaseUrl, supabaseServiceKey, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { autoRefreshToken: false, persistSession: false }
      });
      const { data, error } = await supaUser.rpc('is_admin');
      if (error) throw error;
      isAdmin = !!data;
    } catch (e) {
      console.warn('[generate] is_admin check failed:', e.message);
      isAdmin = false;
    }

    if (!isAdmin) {
      supa.rpc('log_ai_usage', {
        p_user_id: user.id, p_action_id: action_id, p_model: model,
        p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
        p_credits_charged: 0, p_status: 'admin_blocked', p_http_status: 403,
        p_error_msg: 'Ação admin_only chamada por não-admin',
        p_idempotency_key: idempotencyKey, p_duration_ms: 0
      }).then(() => {}, () => {});
      return res.status(403).json({
        error: 'Esta ação requer privilégios de administrador.',
        code: 'ADMIN_ONLY'
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 6. batch_size validation
  // ---------------------------------------------------------------------------
  if (maxBatch && batch_size && batch_size > maxBatch) {
    supa.rpc('log_ai_usage', {
      p_user_id: user.id, p_action_id: action_id, p_model: model,
      p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
      p_credits_charged: 0, p_status: 'batch_too_large', p_http_status: 400,
      p_error_msg: `batch_size=${batch_size} > max=${maxBatch}`,
      p_idempotency_key: idempotencyKey, p_duration_ms: 0
    }).then(() => {}, () => {});
    return res.status(400).json({
      error: `Lote muito grande para esta ação. Máximo: ${maxBatch}, recebido: ${batch_size}.`,
      code: 'BATCH_TOO_LARGE',
      max_batch_size: maxBatch
    });
  }

  // ---------------------------------------------------------------------------
  // 7. Cobrança atômica (com lock + guard saldo)
  // ---------------------------------------------------------------------------
  let chargedAmount = 0;
  let newBalance = null;

  if (!isFree && cost > 0) {
    try {
      const { data: charge, error: chargeErr } = await supa.rpc('charge_credits_atomic', {
        p_user_id: user.id, p_amount: cost
      });
      if (chargeErr) throw chargeErr;

      if (!charge || charge.success === false) {
        if (charge && charge.error === 'insufficient_balance') {
          // Tenta pegar o plano pra retornar
          let planLabel = 'trial';
          try {
            const { data: sub } = await supa.from('subscriptions')
              .select('plan_id').eq('user_id', user.id)
              .in('status', ['active','trialing']).maybeSingle();
            if (sub?.plan_id) planLabel = sub.plan_id;
          } catch (_) {}

          supa.rpc('log_ai_usage', {
            p_user_id: user.id, p_action_id: action_id, p_model: model,
            p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
            p_credits_charged: 0, p_status: 'insufficient_credits', p_http_status: 402,
            p_error_msg: `balance=${charge.balance} required=${charge.required} short_by=${charge.short_by}`,
            p_idempotency_key: idempotencyKey, p_duration_ms: 0
          }).then(() => {}, () => {});

          return res.status(402).json({
            error: 'Créditos insuficientes',
            code: 'NO_CREDITS',
            balance: charge.balance || 0,
            required: charge.required || cost,
            short_by: charge.short_by || (cost - (charge.balance || 0)),
            plan: planLabel,
            action_id,
            action_label: costInfo.label
          });
        }

        console.error('[generate] charge non-success:', charge);
        return res.status(500).json({
          error: 'Erro ao processar cobrança: ' + (charge?.error || 'desconhecido')
        });
      }

      chargedAmount = cost;
      newBalance = charge.new_balance;
    } catch (err) {
      console.error('[generate] charge error:', err);
      return res.status(500).json({
        error: 'Erro ao verificar/cobrar créditos: ' + (err.message || 'desconhecido')
      });
    }
  } else if (isFree) {
    // Saldo atual pra header
    try {
      const { data: cur } = await supa.from('user_credits')
        .select('plan_credits, topup_credits, promotional_credits')
        .eq('user_id', user.id).maybeSingle();
      if (cur) {
        newBalance = (cur.plan_credits || 0) + (cur.topup_credits || 0) + (cur.promotional_credits || 0);
      }
    } catch (_) {}
  }

  // ---------------------------------------------------------------------------
  // 8. Chama Anthropic
  // ---------------------------------------------------------------------------
  const startTime = Date.now();
  let anthropicResponse;

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model, max_tokens: max_tokens || 2500, system, messages
      })
    });

    const data = await upstream.json().catch(() => null);

    if (!upstream.ok) {
      const msg = (data && (data.error?.message || data.message)) || 'Erro Anthropic';
      const errorMsg = `${upstream.status}: ${msg}`;

      if (chargedAmount > 0) {
        try {
          await supa.rpc('refund_credits', {
            p_user_id: user.id, p_amount: chargedAmount, p_to_topup: true
          });
        } catch (e) {
          console.error('[generate] refund failed:', e.message);
        }
      }

      supa.rpc('log_ai_usage', {
        p_user_id: user.id, p_action_id: action_id, p_model: model,
        p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
        p_credits_charged: 0, p_status: 'anthropic_error_refunded', p_http_status: upstream.status,
        p_error_msg: errorMsg, p_idempotency_key: idempotencyKey,
        p_duration_ms: Date.now() - startTime
      }).then(() => {}, () => {});

      return res.status(upstream.status).json({ error: errorMsg });
    }
    anthropicResponse = data;
  } catch (err) {
    const errorMsg = err.message || 'erro de rede desconhecido';

    if (chargedAmount > 0) {
      try {
        await supa.rpc('refund_credits', {
          p_user_id: user.id, p_amount: chargedAmount, p_to_topup: true
        });
      } catch (e) {
        console.error('[generate] refund failed:', e.message);
      }
    }

    supa.rpc('log_ai_usage', {
      p_user_id: user.id, p_action_id: action_id, p_model: model,
      p_input_tokens: 0, p_output_tokens: 0, p_cache_read: 0, p_cache_write: 0,
      p_credits_charged: 0, p_status: 'network_error_refunded', p_http_status: 500,
      p_error_msg: errorMsg, p_idempotency_key: idempotencyKey,
      p_duration_ms: Date.now() - startTime
    }).then(() => {}, () => {});

    return res.status(500).json({ error: 'Falha ao chamar Anthropic: ' + errorMsg });
  }

  // ---------------------------------------------------------------------------
  // 9. Sucesso — log + headers
  // ---------------------------------------------------------------------------
  const usage = anthropicResponse?.usage || {};

  supa.rpc('log_ai_usage', {
    p_user_id: user.id, p_action_id: action_id, p_model: model,
    p_input_tokens: usage.input_tokens || 0, p_output_tokens: usage.output_tokens || 0,
    p_cache_read: usage.cache_read_input_tokens || 0,
    p_cache_write: usage.cache_creation_input_tokens || 0,
    p_credits_charged: chargedAmount,
    p_status: isFree ? 'free' : 'success', p_http_status: 200,
    p_error_msg: null, p_idempotency_key: idempotencyKey,
    p_duration_ms: Date.now() - startTime
  }).then(() => {}, () => {});

  if (newBalance !== null) {
    res.setHeader('X-Credits-Remaining', String(newBalance));
  }
  if (cost > 0) {
    res.setHeader('X-Credits-Charged', String(chargedAmount));
  }
  res.setHeader('X-Action-Id', action_id);

  return res.status(200).json(anthropicResponse);
}
