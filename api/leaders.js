// api/leaders.js
// POST /api/leaders  { name?, bpm, beatsPerMeasure, allowChanges }
// GET  /api/leaders        -> list (summaries)
// GET  /api/leaders?id=xxx -> detail
// PUT  /api/leaders       { id, bpm, beatsPerMeasure, allowChanges }  (updates if allowed)

import { v4 as uuidv4 } from 'uuid';

let useKV = false;
let kv = null;
// try to import @vercel/kv if available
try {
  // dynamic import so deployment won't fail if package missing (but you should install @vercel/kv)
  // eslint-disable-next-line
  kv = require('@vercel/kv').kv;
  useKV = !!kv;
  console.log('require @vercel/kv success!')
} catch (e) {
  console.error('require @vercel/kv fail!', e);
  useKV = false;
}

// fallback in-memory store (not persistent across cold starts) - OK for quick testing
let inMemory = {};

const TTL_SECONDS = 2 * 3600; // 2 hours

async function kvSet(key, value) {
  if (useKV) return kv.set(key, JSON.stringify(value), { ex: TTL_SECONDS });
  inMemory[key] = value;
}
async function kvGet(key) {
  if (useKV) {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  }
  return inMemory[key] || null;
}
async function kvDel(key) {
  if (useKV) return kv.del(key);
  delete inMemory[key];
}
async function kvList(prefix = 'leader:') {
  if (useKV) {
    // There is no easy "list keys with prefix" in @vercel/kv, so we store an index.
    // We'll rely on "leader_index" list if using KV
    try {
      const ids = await kv.lrange('leader_index', 0, 9999);
      const out = [];
      for (const id of ids) {
        const raw = await kv.get(`leader:${id}`);
        if (raw) out.push(JSON.parse(raw));
      }
      return out;
    } catch (e) {
      return [];
    }
  } else {
    return Object.values(inMemory);
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const bpm = Number(body.bpm) || 120;
      const beatsPerMeasure = Number(body.beatsPerMeasure) || 0;
      const name = body.name || ('節拍器-' + Math.random().toString(36).slice(2,6).toUpperCase());
      const allowChanges = !!body.allowChanges;
      const id = uuidv4();
      const createdAt = Date.now();
      const startTime = (body.startTime && Number(body.startTime)) || (Date.now() + 1000); // default start 1s later

      const leader = { id, name, bpm, beatsPerMeasure, allowChanges, createdAt, startTime, expiresAt: createdAt + TTL_SECONDS * 1000 };

      await kvSet(`leader:${id}`, leader);
      if (useKV) {
        // maintain index list
        try {
          await kv.lpush('leader_index', id);
        } catch (e) { /* ignore */ }
      }

      return res.json(leader);
    }

    if (req.method === 'GET') {
      const id = req.query && (req.query.id || (req.query && req.query['id']));
      if (id) {
        const leader = await kvGet(`leader:${id}`);
        if (!leader) return res.status(404).json({ error: 'not found' });
        return res.json(leader);
      } else {
        // list
        const all = await kvList();
        // prune expired when using inMemory
        const now = Date.now();
        const filtered = all.filter(l => !l.expiresAt || l.expiresAt > now);
        return res.json(filtered);
      }
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const id = body.id;
      if (!id) return res.status(400).json({ error: 'missing id' });
      const leader = await kvGet(`leader:${id}`);
      if (!leader) return res.status(404).json({ error: 'not found' });

      // check permission
      if (!leader.allowChanges) return res.status(403).json({ error: 'changes not allowed' });

      if (typeof body.bpm !== 'undefined') leader.bpm = Number(body.bpm);
      if (typeof body.beatsPerMeasure !== 'undefined') leader.beatsPerMeasure = Number(body.beatsPerMeasure);
      if (typeof body.allowChanges !== 'undefined') leader.allowChanges = !!body.allowChanges;
      // update startTime if provided
      if (typeof body.startTime !== 'undefined') leader.startTime = Number(body.startTime);

      leader.updatedAt = Date.now();
      leader.expiresAt = Date.now() + TTL_SECONDS * 1000;
      await kvSet(`leader:${id}`, leader);

      return res.json(leader);
    }

    res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('leaders handler error', err);
    res.status(500).json({ error: 'internal error' });
  }
}

