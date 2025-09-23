// api/leaders.js
// CommonJS module with dynamic import for uuid (avoids ERR_REQUIRE_ESM)
let leaders = {}; // in-memory store (non-persistent across cold starts)

function cleanupExpiredLeaders() {
  const now = Date.now();
  for (const [k, v] of Object.entries(leaders)) {
    if (v.expiresAt && v.expiresAt <= now) delete leaders[k];
  }
}

module.exports = async function handler(req, res) {
  try {
    // dynamic import uuid v7 (works in CommonJS)
    const { v7: uuidv7 } = await import('uuid');

    cleanupExpiredLeaders();

    if (req.method === 'GET') {
      // GET /api/leaders  OR  /api/leaders?label=Beat-XXXX
      const q = req.query || {};
      if (q.label) {
        // find by label
        const found = Object.values(leaders).find(l => l.label === q.label);
        if (!found) return res.status(404).json({ error: 'not found' });
        return res.status(200).json(found);
      }
      // list
      return res.status(200).json(Object.values(leaders));
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      // label provided or generate default Beat-XXXX
      let label = (body.label && String(body.label).trim()) || null;
      if (!label) {
        // generate Beat-XXXX (4 alnum uppercase)
        const rnd = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
        label = 'Beat-' + (rnd.slice(0,4));
      }
      // avoid label collision: append suffix if exists
      if (Object.values(leaders).some(l => l.label === label)) {
        label = label + '-' + Math.random().toString(36).slice(2,3).toUpperCase();
      }

      const id = uuidv7();
      const createdAt = Date.now();
      const startTime = (typeof body.startTime === 'number') ? Number(body.startTime) : (createdAt + 1500); // default 1.5s later
      const bpm = Number(body.bpm) || 120;
      const beatsPerMeasure = Number(body.beatsPerMeasure) || 0;
      const allowChangesByOthers = !!body.allowChangesByOthers;

      const expiresAt = createdAt + 2 * 3600 * 1000; // 2 hours

      const leader = { id, label, bpm, beatsPerMeasure, allowChangesByOthers, createdAt, startTime, expiresAt };
      leaders[id] = leader;

      // debug log
      console.log('Leader created', { id, label, bpm, beatsPerMeasure, startTime });

      return res.status(200).json(leader);
    }

    if (req.method === 'PUT') {
      const body = req.body || {};
      const id = body.id;
      if (!id) return res.status(400).json({ error: 'missing id' });
      const leader = leaders[id];
      if (!leader) return res.status(404).json({ error: 'not found' });
      // permission control
      if (!leader.allowChangesByOthers && !body.force) return res.status(403).json({ error: 'not allowed' });
      if (typeof body.bpm !== 'undefined') leader.bpm = Number(body.bpm);
      if (typeof body.beatsPerMeasure !== 'undefined') leader.beatsPerMeasure = Number(body.beatsPerMeasure);
      if (typeof body.startTime !== 'undefined') leader.startTime = Number(body.startTime);
      if (typeof body.allowChangesByOthers !== 'undefined') leader.allowChangesByOthers = !!body.allowChangesByOthers;
      leader.updatedAt = Date.now();
      leader.expiresAt = Date.now() + 2 * 3600 * 1000;
      console.log('Leader updated', leader.id, { bpm: leader.bpm, beatsPerMeasure: leader.beatsPerMeasure, startTime: leader.startTime });
      return res.status(200).json(leader);
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('leaders handler err:', err);
    return res.status(500).json({ error: 'internal server error', details: String(err && err.message) });
  }
};
