import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  const { id, type, data } = req.body;

  if (req.method === "POST") {
    // 存入訊號
    await kv.rpush(`signal:${id}`, JSON.stringify({ type, data }));
    return res.json({ ok: true });
  }

  if (req.method === "GET") {
    const signals = await kv.lrange(`signal:${id}`, 0, -1);
    await kv.del(`signal:${id}`);
    return res.json(signals.map((s) => JSON.parse(s)));
  }

  res.status(405).json({ error: "Method not allowed" });
}

