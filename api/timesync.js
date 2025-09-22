// api/timesync.js
// Expect POST { t1 } where t1 is client's local epoch ms at send time.
// Respond with { t1, t2, t3 } where
//  - t2 = server receive time
//  - t3 = server send time (captured immediately before response)
// Client should record t4 = Date.now() upon receipt and then compute:
// offset = ((t2 - t1) + (t3 - t4)) / 2
// delay  = (t4 - t1) - (t3 - t2)

export default async function handler(req, res) {
  // allow GET for quick ping-check
  if (req.method === 'GET') {
    return res.json({ ok: true, serverTime: Date.now() });
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  try {
    const body = req.body || {};
    // client t1 may be provided or not; support both
    const t1 = typeof body.t1 === 'number' ? body.t1 : null;

    // t2: server receive time (as early as possible)
    const t2 = Date.now();

    // minimal synchronous processing here
    // t3: server send time just before response; for better accuracy, recalc after small synchronous work
    const t3 = Date.now();

    // Return t1 (echo), t2 and t3
    res.json({ t1, t2, t3 });
  } catch (err) {
    console.error('timesync error', err);
    res.status(500).json({ error: 'internal error' });
  }
}

