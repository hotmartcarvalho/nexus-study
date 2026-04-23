// api/generate.js
// Endpoint serverless que repassa chamadas à Anthropic preservando a interface original.
// Recebe o mesmo body que a API Anthropic aceita (system, messages, model, max_tokens)
// e retorna a resposta completa (content, usage, etc). Esconde apenas a chave do cliente.

export default async function handler(req, res) {
  // CORS — ajuste a origin se quiser restringir
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, anthropic-version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  const { model, system, messages, max_tokens } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Campo "messages" é obrigatório (array).' });
  }
  if (!model) {
    return res.status(400).json({ error: 'Campo "model" é obrigatório.' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: max_tokens || 2500,
        system,
        messages
      })
    });

    // Repassa o status e corpo da Anthropic de forma transparente
    const data = await upstream.json().catch(() => null);
    if (!upstream.ok) {
      const msg = (data && (data.error?.message || data.message)) || 'Erro na API Anthropic';
      return res.status(upstream.status).json({ error: `${upstream.status}: ${msg}` });
    }
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao chamar a API: ' + (err.message || 'erro desconhecido') });
  }
}
