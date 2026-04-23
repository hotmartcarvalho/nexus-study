// api/generate.js
// Endpoint serverless para Vercel que intermedia chamadas ao Anthropic.
// Frontend envia { prompt, model } via POST e recebe { output: "..." }.

export default async function handler(req, res) {
  // CORS básico — ajuste a origin se quiser restringir a um domínio específico
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Pré-flight CORS
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Aceita apenas POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  // Verifica se a chave está configurada no ambiente
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Chave da API não configurada no servidor.' });
  }

  // Extrai e valida o corpo
  const { prompt, model } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'Campo "prompt" é obrigatório e deve ser string.' });
  }

  const selectedModel = model || 'claude-haiku-4-5-20251001';

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: selectedModel,
        max_tokens: 2500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return res.status(response.status).json({
        error: `Erro na API Anthropic (${response.status}): ${errText.slice(0, 200)}`
      });
    }

    const data = await response.json();
    const output = (data.content || [])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    if (!output) {
      return res.status(502).json({ error: 'Resposta vazia da API.' });
    }

    return res.status(200).json({ output });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao chamar a API: ' + (err.message || 'erro desconhecido') });
  }
}
