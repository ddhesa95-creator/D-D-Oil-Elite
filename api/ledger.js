// api/ledger.js — Prediction track record.
// POST {action:"save", prediction} → store a dated prediction
// GET  ?action=list → all predictions + computed hit-rate stats
// POST {action:"grade", date, actualClose} → record actual outcome, score it
//
// Uses Vercel KV if configured (KV_REST_API_URL + KV_REST_API_TOKEN).
// Falls back to in-memory (resets on cold start) if KV not set — still works for a session.

let memoryStore = []; // fallback only

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const KV_KEY = 'oil_oracle_predictions';

async function kvGet() {
  if (!KV_URL || !KV_TOKEN) return null;
  try {
    const r = await fetch(`${KV_URL}/get/${KV_KEY}`, {
      headers: { Authorization: `Bearer ${KV_TOKEN}` },
    });
    if (!r.ok) return [];
    const data = await r.json();
    if (!data.result) return [];
    return JSON.parse(data.result);
  } catch { return []; }
}

async function kvSet(arr) {
  if (!KV_URL || !KV_TOKEN) return false;
  try {
    await fetch(`${KV_URL}/set/${KV_KEY}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.parse(JSON.stringify(arr))),
    });
    return true;
  } catch { return false; }
}

async function loadAll() {
  const kv = await kvGet();
  if (kv !== null) return kv;
  return memoryStore;
}
async function saveAll(arr) {
  const ok = await kvSet(arr);
  if (!ok) memoryStore = arr;
}

function computeStats(preds) {
  const graded = preds.filter(p => p.actualClose != null && p.tomorrowDirection);
  if (!graded.length) return { totalPredictions: preds.length, graded: 0, message: 'No graded predictions yet — outcomes get scored the next day.' };
  let dirHits = 0;
  let inRange = 0;
  graded.forEach(p => {
    const prevClose = parseFloat(String(p.wtiCurrent).replace(/[^0-9.]/g, ''));
    const actual = parseFloat(p.actualClose);
    const target = parseFloat(String(p.tomorrowTarget).replace(/[^0-9.]/g, ''));
    if (!isNaN(prevClose) && !isNaN(actual)) {
      const actualDir = actual > prevClose ? 'UP' : actual < prevClose ? 'DOWN' : 'SIDEWAYS';
      const predDir = (p.tomorrowDirection || '').toUpperCase();
      if (predDir === actualDir) dirHits++;
      else if (predDir === 'SIDEWAYS' && Math.abs(actual - prevClose) / prevClose < 0.01) dirHits++;
    }
    const lo = parseFloat(String(p.tomorrowRangeLow).replace(/[^0-9.]/g, ''));
    const hi = parseFloat(String(p.tomorrowRangeHigh).replace(/[^0-9.]/g, ''));
    if (!isNaN(lo) && !isNaN(hi) && !isNaN(actual) && actual >= lo && actual <= hi) inRange++;
  });
  return {
    totalPredictions: preds.length,
    graded: graded.length,
    directionAccuracy: Math.round((dirHits / graded.length) * 100),
    rangeAccuracy: Math.round((inRange / graded.length) * 100),
    directionHits: dirHits,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const all = await loadAll();
      const sorted = [...all].sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
      return res.status(200).json({
        kvConfigured: !!(KV_URL && KV_TOKEN),
        stats: computeStats(all),
        predictions: sorted.slice(0, 30),
      });
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};
      const all = await loadAll();

      if (action === 'save') {
        const p = req.body.prediction || {};
        const today = new Date().toISOString().slice(0, 10);
        // avoid dup for same day — replace if exists
        const filtered = all.filter(x => x.predictionDate !== today);
        filtered.push({
          predictionDate: today,
          savedAt: new Date().toISOString(),
          wtiCurrent: p.wti_current,
          tomorrowTarget: p.tomorrow_target,
          tomorrowDirection: p.tomorrow_direction,
          tomorrowRangeLow: p.tomorrow_range_low,
          tomorrowRangeHigh: p.tomorrow_range_high,
          tomorrowConfidence: p.tomorrow_confidence_pct,
          tradeSignal: p.trade_signal,
          primaryDriver: p.primary_driver,
          actualClose: null,
        });
        await saveAll(filtered);
        return res.status(200).json({ ok: true, saved: today, total: filtered.length });
      }

      if (action === 'grade') {
        const { date, actualClose } = req.body;
        const idx = all.findIndex(x => x.predictionDate === date);
        if (idx === -1) return res.status(404).json({ error: 'No prediction for that date' });
        all[idx].actualClose = actualClose;
        all[idx].gradedAt = new Date().toISOString();
        await saveAll(all);
        return res.status(200).json({ ok: true, graded: date, stats: computeStats(all) });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}

export const config = { maxDuration: 30 };
