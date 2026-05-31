// api/ai.js — Multi-provider AI gateway.
// FREE: gemini (research+search), groq (fast voting, no search)
// PAID (optional, off unless key present): openai, grok
// HEAD ACTUARY: claude (synthesis/adjudication)

const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GROQ_MODEL   = process.env.GROQ_MODEL   || 'llama-3.3-70b-versatile';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const GROK_MODEL   = process.env.GROK_MODEL   || 'grok-2-latest';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const keys = {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    groq:   process.env.GROQ_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    grok:   process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  };

  if (req.method === 'GET') {
    return res.status(200).json({
      status: 'Multi-AI gateway alive',
      providers: {
        claude: { configured: !!keys.claude, model: CLAUDE_MODEL, role: 'head actuary / synthesis' },
        gemini: { configured: !!keys.gemini, model: GEMINI_MODEL, role: 'research + web search (free)' },
        groq:   { configured: !!keys.groq,   model: GROQ_MODEL,   role: 'fast voting (free, no search)' },
        openai: { configured: !!keys.openai, model: OPENAI_MODEL, role: 'optional voting (paid)' },
        grok:   { configured: !!keys.grok,   model: GROK_MODEL,   role: 'optional X/Trump (paid)' },
      },
      ready: !!keys.claude && !!keys.gemini,
      message: (!!keys.claude && !!keys.gemini)
        ? `Core ready. Free voters: ${[keys.gemini&&'Gemini',keys.groq&&'Groq'].filter(Boolean).join(', ')||'none'}. Paid voters: ${[keys.openai&&'OpenAI',keys.grok&&'Grok'].filter(Boolean).join(', ')||'none'}.`
        : `Missing core: ${!keys.claude?'ANTHROPIC_API_KEY ':''}${!keys.gemini?'GEMINI_API_KEY':''}`,
    });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { provider = 'claude', system, user, useSearch = false, maxTokens = 4000, temperature = 0.3 } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Missing user message' });

  try {
    if (provider === 'gemini') return await callGemini({ res, key: keys.gemini, system, user, useSearch, maxTokens, temperature });
    if (provider === 'groq')   return await callGroq({   res, key: keys.groq,   system, user, maxTokens, temperature });
    if (provider === 'openai') return await callOpenAI({ res, key: keys.openai, system, user, useSearch, maxTokens, temperature });
    if (provider === 'grok')   return await callGrok({   res, key: keys.grok,   system, user, maxTokens, temperature });
    return await callClaude({ res, key: keys.claude, system, user, useSearch, maxTokens });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown server error', provider });
  }
}

// ---------- GEMINI (free, has Google Search) ----------
async function callGemini({ res, key, system, user, useSearch, maxTokens, temperature }) {
  if (!key) return res.status(500).json({ error: 'GEMINI_API_KEY not configured' });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`;
  const body = { contents: [{ parts: [{ text: user }] }], generationConfig: { temperature, maxOutputTokens: maxTokens } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (useSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const raw = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: `Gemini ${r.status}`, details: raw.slice(0, 500) });
  let data; try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'Gemini parse fail', details: raw.slice(0,300) }); }
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('\n');
  return res.status(200).json({ text, provider: 'gemini' });
}

// ---------- GROQ (free, fast Llama, OpenAI-compatible, no search) ----------
async function callGroq({ res, key, system, user, maxTokens, temperature }) {
  if (!key) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [ system ? { role: 'system', content: system } : null, { role: 'user', content: user } ].filter(Boolean),
      max_tokens: maxTokens, temperature,
    }),
  });
  const raw = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: `Groq ${r.status}`, details: raw.slice(0, 500) });
  let data; try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'Groq parse fail', details: raw.slice(0,300) }); }
  const text = data.choices?.[0]?.message?.content || '';
  return res.status(200).json({ text, provider: 'groq' });
}

// ---------- OPENAI (optional, paid) ----------
async function callOpenAI({ res, key, system, user, maxTokens, temperature }) {
  if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not configured' });
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [ system ? { role: 'system', content: system } : null, { role: 'user', content: user } ].filter(Boolean),
      max_tokens: maxTokens, temperature,
    }),
  });
  const raw = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: `OpenAI ${r.status}`, details: raw.slice(0, 500) });
  let data; try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'OpenAI parse fail', details: raw.slice(0,300) }); }
  const text = data.choices?.[0]?.message?.content || '';
  return res.status(200).json({ text, provider: 'openai' });
}

// ---------- GROK / xAI (optional, paid; has X access) ----------
async function callGrok({ res, key, system, user, maxTokens, temperature }) {
  if (!key) return res.status(500).json({ error: 'XAI_API_KEY not configured' });
  const r = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: GROK_MODEL,
      messages: [ system ? { role: 'system', content: system } : null, { role: 'user', content: user } ].filter(Boolean),
      max_tokens: maxTokens, temperature,
    }),
  });
  const raw = await r.text();
  if (!r.ok) return res.status(r.status).json({ error: `Grok ${r.status}`, details: raw.slice(0, 500) });
  let data; try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'Grok parse fail', details: raw.slice(0,300) }); }
  const text = data.choices?.[0]?.message?.content || '';
  return res.status(200).json({ text, provider: 'grok' });
}

// ---------- CLAUDE (head actuary / synthesis) ----------
async function callClaude({ res, key, system, user, useSearch, maxTokens }) {
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  const body = { model: CLAUDE_MODEL, max_tokens: maxTokens, system: system || 'You are a helpful assistant.', messages: [{ role: 'user', content: user }] };
  if (useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }];
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  if (!r.ok) {
    const retryAfter = r.headers.get('retry-after');
    return res.status(r.status).json({ error: `Claude ${r.status}`, details: raw.slice(0, 500), retryAfter: retryAfter ? parseInt(retryAfter,10) : null });
  }
  let data; try { data = JSON.parse(raw); } catch { return res.status(500).json({ error: 'Claude parse fail', details: raw.slice(0,300) }); }
  if (data.error) return res.status(500).json({ error: data.error.message });
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  return res.status(200).json({ text, provider: 'claude' });
}

export const config = { maxDuration: 300 };
