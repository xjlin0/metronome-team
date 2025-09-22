// api/leaders.js
let leaders = {};

function cleanupExpiredLeaders() {
  const now = Date.now();
  for (const [id, leader] of Object.entries(leaders)) {
    if (now - leader.createdAt > 2 * 60 * 60 * 1000) delete leaders[id];
  }
}

export default async function handler(req, res) {
  // 動態 import uuid v7
  const { v7: uuidv7 } = await import('uuid');

  cleanupExpiredLeaders();

  if (req.method === 'GET') {
    return res.status(200).json(Object.values(leaders));
  }

  if (req.method === 'POST') {
    const id = uuidv7();
    leaders[id] = { id, createdAt: Date.now(), bpm: 120, beatsPerMeasure: 4 };
    return res.status(200).json(leaders[id]);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
