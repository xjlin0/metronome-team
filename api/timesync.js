// api/timesync.js
// Expect POST { t1 } where t1 is client's local epoch ms at send time.
// Respond with { t1, t2, t3 } where
//  - t2 = server receive time
//  - t3 = server send time (captured immediately before response)
// Client should record t4 = Date.now() upon receipt and then compute:
// offset = ((t2 - t1) + (t3 - t4)) / 2
// delay  = (t4 - t1) - (t3 - t2)

let pings = []; // 儲存最近多次採樣
const MAX_SAMPLES = 10;

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    const { clientTime } = req.body;

    if (!clientTime) {
      return res.status(400).json({ error: 'Missing clientTime' });
    }

    const t2 = Date.now(); // server receive time
    const t3 = Date.now(); // server send time
    const rtt = t3 - clientTime;

    pings.push(rtt);
    if (pings.length > MAX_SAMPLES) pings.shift();

    const sorted = [...pings].sort((a, b) => a - b);
    const medianRtt = sorted[Math.floor(sorted.length / 2)];

    console.log(`clientTime=${clientTime} t2=${t2} t3=${t3} RTT=${rtt} medianRTT=${medianRtt}`);

    return res.status(200).json({
      clientTime,
      t2,
      t3,
      rtt,
      medianRtt
    });
  }

  return res.status(405).json({ error: 'Method not allowed' });
};


