import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // 客戶端送來的 local time
  const { clientTime } = req.body;

  const serverTime = Date.now();

  res.json({
    clientTime,
    serverTime,
  });
}
