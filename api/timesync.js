export default function handler(req, res) {
  const now = Date.now();
  res.json({ serverTime: now, offset: 0 });
}
