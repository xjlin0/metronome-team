let leaders = {};

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { bpm, beatsPerMeasure } = req.body;
    const id = Math.random().toString(36).substr(2, 5);
    leaders[id] = {
      id,
      bpm,
      beatsPerMeasure,
      startTime: Date.now() + 1000, // 給1秒準備時間
      created: Date.now()
    };
    res.json(leaders[id]);
  } else if (req.method === "GET") {
    if (req.query.id) {
      res.json(leaders[req.query.id]);
    } else {
      // 移除超過2小時的
      const now = Date.now();
      leaders = Object.fromEntries(
        Object.entries(leaders).filter(([_, l]) => now - l.created < 7200000)
      );
      res.json(Object.values(leaders));
    }
  } else {
    res.status(405).end();
  }
}
