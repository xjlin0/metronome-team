// leaders.js
// CommonJS-compatible, 動態 import uuid

let uuidv7;
let leaders = {};

// 輔助函數：移除過期 leader
function cleanupExpiredLeaders() {
  const now = Date.now();
  for (const [id, leader] of Object.entries(leaders)) {
    if (now - leader.createdAt > 2 * 60 * 60 * 1000) {
      delete leaders[id];
    }
  }
}

module.exports = async function handler(req, res) {
  if (!uuidv7) {
    // 動態 import ESM 模組
    const { v7 } = await import('uuid');
    uuidv7 = v7;
  }

  try {
    if (req.method === 'GET') {
      cleanupExpiredLeaders();
      return res.status(200).json(Object.values(leaders));
    }

    if (req.method === 'POST') {
      cleanupExpiredLeaders();
      const id = uuidv7();
      leaders[id] = {
        id,
        createdAt: Date.now(),
        allowChangesByOthers: req.body?.allowChangesByOthers || false
      };
      return res.status(200).json(leaders[id]);
    }

    if (req.method === 'PUT') {
      const { id, allowChangesByOthers } = req.body;
      if (!id || typeof allowChangesByOthers !== 'boolean') {
        return res.status(400).json({ error: 'Missing id or allowChangesByOthers' });
      }
      if (!leaders[id]) return res.status(404).json({ error: 'Leader not found' });
      leaders[id].allowChangesByOthers = allowChangesByOthers;
      return res.status(200).json(leaders[id]);
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
};
