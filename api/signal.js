// api/signal.js
let offers = {};
let answers = {};

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const { type, id, payload } = req.body;
    if (!type || !id || !payload) return res.status(400).json({ error: 'Missing fields' });

    if (type === 'offer') {
      offers[id] = payload;
      return res.status(200).json({ status: 'offer stored' });
    }
    if (type === 'answer') {
      answers[id] = payload;
      return res.status(200).json({ status: 'answer stored' });
    }
    return res.status(400).json({ error: 'Invalid type' });
  }

  if (req.method === 'GET') {
    const { type, id } = req.query;
    if (type === 'offer') return res.status(200).json({ payload: offers[id] || null });
    if (type === 'answer') return res.status(200).json({ payload: answers[id] || null });
    return res.status(400).json({ error: 'Invalid query' });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
