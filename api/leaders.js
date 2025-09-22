import { v7 as uuidv7 } from 'uuid';

// 簡單的記憶體內存，存 leader 清單
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

let uuidv7;

export default async function handler(req, res) {
  if (!uuidv7) {
    const { v7 } = await import('uuid');
    uuidv7 = v7;
  }

  if (req.method === 'GET') {
    cleanupExpiredLeaders();
    return res.status(200).json(Object.values(leaders));
  }

  if (req.method === 'POST') {
    cleanupExpiredLeaders();
    const id = uuidv7();
    leaders[id] = { id, createdAt: Date.now() };
    return res.status(200).json(leaders[id]);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}


