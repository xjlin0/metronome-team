import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method === "POST") {
    const { id, tempo, allowChanges } = req.body;
    const leaderData = {
      id,
      tempo,
      allowChanges,
      createdAt: Date.now(),
    };
    await kv.set(`leader:${id}`, leaderData, { ex: 7200 }); // TTL 2h
    return res.json(leaderData);
  }

  if (req.method === "GET") {
    const keys = await kv.keys("leader:*");
    const leaders = [];
    for (const key of keys) {
      const leader = await kv.get(key);
      if (leader) leaders.push(leader);
    }
    return res.json(leaders);
  }

  if (req.method === "PUT") {
    const { id, tempo } = req.body;
    const leader = await kv.get(`leader:${id}`);
    if (!leader) return res.status(404).json({ error: "Not found" });

    if (leader.allowChanges) {
      leader.tempo = tempo;
      leader.updatedAt = Date.now();
      await kv.set(`leader:${id}`, leader, { ex: 7200 });
      return res.json(leader);
    } else {
      return res.status(403).json({ error: "Changes not allowed" });
    }
  }

  res.status(405).json({ error: "Method not allowed" });
}

