// api/data.js — Authoritative market data anchor (crude + diesel).
// FREE sources: FRED (no key), EIA (free key, has diesel/heating oil),
// TradingEconomics (free key), Polymarket (no key), GDELT (no key).
// The AI never has to guess prices — it gets real anchors.

const FRED_SERIES = {
  wti: 'DCOILWTICO',        // WTI Crude $/bbl
  brent: 'DCOILBRENTEU',    // Brent $/bbl
  gas: 'GASREGW',           // US Regular gasoline $/gal (weekly)
  diesel: 'GASDESW',        // US Diesel (On-Highway) $/gal (weekly)
  heatingoil: 'DHOILNYH',   // No.2 Heating Oil NY Harbor $/gal
  dxy: 'DTWEXBGS',          // Trade-weighted USD index
};

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; OilOracle/4.2)',
  'Accept': 'text/csv,application/json,text/plain,*/*',
};

// Wrap any fetch with a hard timeout so one slow source can't stall everything
async function fetchTimeout(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

async function fetchFredLatest(seriesId) {
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=2025-01-01`;
  try {
    const r = await fetchTimeout(url, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const csv = await r.text();
    const lines = csv.trim().split('\n');
    for (let i = lines.length - 1; i > 0; i--) {
      const [date, val] = lines[i].split(',');
      if (val && val !== '.' && !isNaN(parseFloat(val))) return { value: parseFloat(val), date };
    }
    return null;
  } catch { return null; }
}

async function fetchFredHistory(seriesId, days = 30) {
  const start = new Date(Date.now() - (days + 25) * 86400000).toISOString().slice(0, 10);
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${seriesId}&cosd=${start}`;
  try {
    const r = await fetchTimeout(url, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const csv = await r.text();
    const lines = csv.trim().split('\n');
    const points = [];
    for (let i = 1; i < lines.length; i++) {
      const [date, val] = lines[i].split(',');
      if (val && val !== '.' && !isNaN(parseFloat(val))) points.push({ date, value: parseFloat(val) });
    }
    return points.slice(-days);
  } catch { return null; }
}

// EIA official API — crude (RWTC/RBRTE) + diesel (EMD_EPD2D_PTE_NUS_DPG) + others
async function fetchEIA(key) {
  if (!key) return null;
  const series = {
    wti: 'PET.RWTC.D',          // WTI spot daily
    brent: 'PET.RBRTE.D',       // Brent spot daily
    diesel: 'PET.EMD_EPD2D_PTE_NUS_DPG.W', // US diesel retail weekly
    gasoline: 'PET.EMM_EPM0_PTE_NUS_DPG.W',
  };
  const out = {};
  await Promise.all(Object.entries(series).map(async ([k, sid]) => {
    try {
      const url = `https://api.eia.gov/v2/seriesid/${sid}?api_key=${key}`;
      const r = await fetchTimeout(url, { headers: FETCH_HEADERS });
      if (!r.ok) { out[k] = null; return; }
      const j = await r.json();
      const row = j?.response?.data?.[0];
      out[k] = row ? { value: parseFloat(row.value), date: row.period } : null;
    } catch { out[k] = null; }
  }));
  return out;
}

// TradingEconomics free API — crude + brent. Free key format "guest:guest" works limited.
async function fetchTradingEconomics(key) {
  const auth = key || 'guest:guest';
  try {
    const url = `https://api.tradingeconomics.com/markets/commodity/crude%20oil,brent%20crude%20oil?c=${encodeURIComponent(auth)}&f=json`;
    const r = await fetchTimeout(url, { headers: FETCH_HEADERS });
    if (!r.ok) return null;
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.map(m => ({
      name: m.Name || m.Symbol,
      last: m.Last,
      change: m.DailyChange,
      pctChange: m.DailyPercentualChange,
      date: m.Date,
    }));
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const eiaKey = process.env.EIA_API_KEY;
  const teKey = process.env.TRADINGECONOMICS_API_KEY;

  try {
    // FRED anchors (parallel)
    const fredEntries = await Promise.all(
      Object.entries(FRED_SERIES).map(async ([key, id]) => [key, await fetchFredLatest(id)])
    );
    const fred = Object.fromEntries(fredEntries);

    const [wtiHistory, eia, te, polymarket, gdelt] = await Promise.all([
      fetchFredHistory('DCOILWTICO', 30),
      fetchEIA(eiaKey),
      fetchTradingEconomics(teKey),
      (async () => {
        try {
          const r = await fetchTimeout('https://gamma-api.polymarket.com/markets?closed=false&limit=10&order=volume&ascending=false', { headers: FETCH_HEADERS }, 6000);
          if (!r.ok) return null;
          const d = await r.json();
          const rel = (Array.isArray(d) ? d : []).filter(m => {
            const q = (m.question || '').toLowerCase();
            return q.includes('oil') || q.includes('iran') || q.includes('hormuz') || q.includes('opec') || q.includes('crude') || q.includes('gas');
          }).slice(0, 6).map(m => ({ question: m.question, odds: m.outcomePrices, volume: m.volume }));
          return rel.length ? rel : null;
        } catch { return null; }
      })(),
      (async () => {
        try {
          const q = encodeURIComponent('(oil OR crude OR OPEC OR "Strait of Hormuz" OR Iran) sourcelang:eng');
          const r = await fetchTimeout(`https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=tonechart&format=json&timespan=3d`, { headers: FETCH_HEADERS }, 6000);
          if (!r.ok) return null;
          const txt = await r.text();
          const gj = JSON.parse(txt);
          if (gj.tonechart && gj.tonechart.length) {
            let tot = 0, wt = 0;
            gj.tonechart.forEach(b => { tot += b.count || 0; wt += (b.bin || 0) * (b.count || 0); });
            const avg = tot ? wt / tot : null;
            return { articles3d: tot, avgTone: avg != null ? avg.toFixed(2) : null,
              read: avg == null ? null : avg < -2 ? 'Negative/tense (often bullish oil)' : avg > 1 ? 'Positive/calm' : 'Neutral' };
          }
          return null;
        } catch { return null; }
      })(),
    ]);

    return res.status(200).json({
      source: 'FRED + EIA + TradingEconomics + Polymarket + GDELT',
      fetchedAt: new Date().toISOString(),
      anchors: {
        fred,                 // includes diesel + heating oil
        eia: eia || 'no EIA key (add EIA_API_KEY)',
        tradingEconomics: te || 'TE unavailable (add TRADINGECONOMICS_API_KEY)',
      },
      prices: fred,           // backward-compat for frontend
      wtiHistory,
      polymarket,
      gdelt,
      note: 'FRED daily lag 1-2 biz days; EIA spot daily; TE near-real-time. AI also pulls intraday via search.',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { maxDuration: 60 };
