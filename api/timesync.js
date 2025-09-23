// api/timesync.js
// Expect POST { t1 } where t1 is client's local epoch ms at send time.
// Respond with { t1, t2, t3 } where
//  - t2 = server receive time
//  - t3 = server send time (captured immediately before response)
// Client should record t4 = Date.now() upon receipt and then compute:
// offset = ((t2 - t1) + (t3 - t4)) / 2
// delay  = (t4 - t1) - (t3 - t2)

// api/timesync.js
// Expects POST { clientTime } (ms). Returns { t1, t2, t3 }
// Client will record t4 upon receipt and compute offset/delay using NTP formula.

let recentRTTs = [];
const MAX_SAMPLES = 50;

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: true, serverTime: Date.now() });
    }
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'method not allowed' });
    }

    const body = req.body || {};
    const t1 = typeof body.clientTime === 'number' ? Number(body.clientTime) : null;
    if (t1 === null) {
      return res.status(400).json({ error: 'Missing clientTime' });
    }

    const t2 = Date.now(); // server receive time
    // minimal processing
    const t3 = Date.now(); // server send time (as close as possible)
    const rtt = t3 - t1;
    recentRTTs.push(rtt);
    if (recentRTTs.length > MAX_SAMPLES) recentRTTs.shift();

    // median RTT for debug
    const sorted = [...recentRTTs].sort((a,b)=>a-b);
    const medianRTT = sorted[Math.floor(sorted.length/2)] || 0;

    console.log(`timesync t1=${t1} t2=${t2} t3=${t3} rtt=${rtt} median=${medianRTT}`);

    return res.status(200).json({ t1, t2, t3, rtt, medianRTT });
  } catch (err) {
    console.error('timesync err', err);
    return res.status(500).json({ error: 'internal server error', details: String(err && err.message) });
  }
};



