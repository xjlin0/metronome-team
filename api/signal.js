// api/signal.js
// Simple in-memory signaling storage keyed by label.
// POST { type: 'offer'|'answer', label, payload }
// GET  ?type=offer|answer&label=Beat-XXXX

let store = {
  offers: {},   // store.offers[label] = sdp/offer
  answers: {}   // store.answers[label] = answer
};

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const { type, label, payload } = body;
      // log body for debugging
      console.log('signal POST', JSON.stringify(body).slice(0,1000));

      if (!type) return res.status(400).json({ error: 'missing type (offer|answer)' });
      if (!label) return res.status(400).json({ error: 'missing label (leader label), please provide label' });
      if (!payload) return res.status(400).json({ error: 'missing payload (SDP)' });

      if (type === 'offer') {
        store.offers[label] = payload;
        // clear older answers for label
        delete store.answers[label];
        console.log('stored offer for', label);
        return res.status(200).json({ ok: true });
      } else if (type === 'answer') {
        store.answers[label] = payload;
        console.log('stored answer for', label);
        return res.status(200).json({ ok: true });
      } else {
        return res.status(400).json({ error: 'unknown type' });
      }
    }

    if (req.method === 'GET') {
      const q = req.query || {};
      const type = q.type;
      const label = q.label;
      if (!type || !label) return res.status(400).json({ error: 'missing query param type or label' });
      if (type === 'offer') {
        return res.status(200).json({ payload: store.offers[label] || null });
      } else if (type === 'answer') {
        return res.status(200).json({ payload: store.answers[label] || null });
      } else {
        return res.status(400).json({ error: 'unknown type' });
      }
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    console.error('signal err', err);
    return res.status(500).json({ error: 'internal server error', details: String(err && err.message) });
  }
};
