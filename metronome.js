// metronome.js
let audioCtx = null;
let schedulerTimer = null;
let beatIndex = 0;
let bpm = Number(document.getElementById('bpm').value || 120);
let beatsPerMeasure = Number(document.getElementById('beatsPerMeasure').value || 0);
let isRunning = false;

const circle = document.getElementById('circle');
const bpmInput = document.getElementById('bpm');
const bpmValue = document.getElementById('bpmValue');
const beatsSel = document.getElementById('beatsPerMeasure');

const dbgLocal = document.getElementById('dbgLocal');
const dbgOffsetEl = document.getElementById('dbgOffset');
const dbgDelayEl = document.getElementById('dbgDelay');
const dbgLeaderStart = document.getElementById('dbgLeaderStart');
const dbgBeat = document.getElementById('dbgBeat');

bpmInput.addEventListener('input', (e)=> {
  bpm = Number(e.target.value);
  bpmValue.textContent = bpm;
  if (isRunning) restartScheduler();
});
beatsSel.addEventListener('change', (e)=> {
  beatsPerMeasure = Number(e.target.value);
});

document.getElementById('startBtn').addEventListener('click', ()=> startLocal());
document.getElementById('stopBtn').addEventListener('click', ()=> stopLocal());

// audio
function ensureAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}
function clickSound(strong=false, when=null) {
  if (!audioCtx) return;
  const o = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.value = strong ? 1100 : 700;
  o.connect(g); g.connect(audioCtx.destination);
  g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  const startAt = when || audioCtx.currentTime;
  g.gain.linearRampToValueAtTime(0.8, startAt + 0.001);
  g.gain.exponentialRampToValueAtTime(0.001, startAt + 0.12);
  o.start(startAt);
  o.stop(startAt + 0.13);
}

// visual: flash (strong uses scale + border)
function flashVisual(strong=false) {
  if (strong) {
    circle.style.transform = 'scale(1.18)';
    circle.style.border = '6px solid #004d40'; // dark border + size = easier to notice for colorblind
    circle.style.background = 'linear-gradient(90deg,#ffbd59,#ff7a59)';
    setTimeout(()=> {
      circle.style.transform='scale(1)';
      circle.style.border='none';
      circle.style.background='';
    }, 140);
  } else {
    circle.style.transform = 'scale(1.06)';
    circle.style.background = 'linear-gradient(90deg,#7fcfff,#4a90e2)';
    setTimeout(()=> {
      circle.style.transform='scale(1)';
      circle.style.background='';
    }, 120);
  }
}

// scheduler: schedule using Date.now() + optional offset
let schedulingOffset = 0; // serverTime - localTime (ms) as computed by timeSync
let leaderStartTime = null; // server epoch ms

function startLocal(startTime = null) {
  // start immediate local metronome (no offset)
  ensureAudio();
  stopLocal();
  beatIndex = 0;
  isRunning = true;
  // if startTime passed -> schedule first beat at that server epoch (converted to local)
  if (startTime) {
    scheduleFromLeaderStart(startTime);
  } else {
    // local immediate
    scheduleImmediate();
  }
}

function stopLocal() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  isRunning = false;
  beatIndex = 0;
  dbgBeat.textContent = '-';
}

function restartScheduler() {
  if (!isRunning) return;
  stopLocal();
  startLocal(leaderStartTime ? (leaderStartTime) : null);
}

function scheduleImmediate(){
  // simple interval-based scheduling (good enough for single device testing)
  const intervalMs = 60000 / bpm;
  // fire first now
  doBeat();
  schedulerTimer = setInterval(() => {
    doBeat();
  }, intervalMs);
}

function scheduleFromLeaderStart(serverStartEpochMs) {
  // compute local performance time to play
  leaderStartTime = serverStartEpochMs;
  dbgLeaderStart.textContent = serverStartEpochMs;
  const nowLocal = Date.now();
  const msUntil = serverStartEpochMs - nowLocal + schedulingOffset;
  // msUntil can be negative -> leader already started; compute next beat index
  const intervalMs = 60000 / bpm;
  if (msUntil > 50) {
    // schedule first beat at msUntil
    setTimeout(()=> {
      doBeat();
      schedulerTimer = setInterval(doBeat, intervalMs);
    }, msUntil);
  } else {
    // leader already started; compute how many beats have passed
    const elapsedSinceLeaderStart = nowLocal - serverStartEpochMs - schedulingOffset;
    const beatsSince = Math.floor(elapsedSinceLeaderStart / intervalMs);
    const nextBeatDelay = intervalMs - (elapsedSinceLeaderStart % intervalMs);
    // align beatIndex accordingly
    beatIndex = beatsSince + 1;
    setTimeout(()=> {
      doBeat();
      schedulerTimer = setInterval(doBeat, intervalMs);
    }, Math.max(0, nextBeatDelay));
  }
}

function doBeat() {
  const isStrong = (beatsPerMeasure>0) ? ((beatIndex % beatsPerMeasure) === 0) : false;
  // audio
  try {
    const playAt = audioCtx ? audioCtx.currentTime : null;
    clickSound(isStrong, playAt);
  } catch(e){}
  // visual
  flashVisual(isStrong);
  beatIndex++;
  dbgBeat.textContent = String(beatIndex);
}

// ========= TimeSync client (NTP-like, multi-sample, median) =========
async function timeSync(samples = 12, endpoint = '/api/timesync') {
  // perform multiple exchanges and compute offsets/delays
  const results = [];
  for (let i=0;i<samples;i++) {
    const t1 = Date.now();
    let respJson;
    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: {'content-type':'application/json'},
        body: JSON.stringify({ t1 })
      });
      const t4 = Date.now();
      // server returns { t1, t2, t3 }
      respJson = await r.json();
      const T1 = respJson.t1 || t1;
      const T2 = respJson.t2;
      const T3 = respJson.t3;
      const T4 = t4;
      const offset = ((T2 - T1) + (T3 - T4)) / 2; // serverTime - localTime
      const delay  = (T4 - T1) - (T3 - T2);
      results.push({ offset, delay, T1,T2,T3,T4 });
    } catch (e) {
      // network error - skip this sample
      console.warn('timesync sample failed', e);
    }
    // small jitter between samples
    await new Promise(r => setTimeout(r, 40 + Math.random()*30));
  }

  if (results.length === 0) throw new Error('timesync failed');

  // choose best half by lowest delay
  results.sort((a,b)=>a.delay - b.delay);
  const keep = results.slice(0, Math.max(3, Math.floor(results.length/2)));
  // median offset among kept
  const offsets = keep.map(r=>r.offset).sort((a,b)=>a-b);
  const delays = keep.map(r=>r.delay).sort((a,b)=>a-b);
  const medianOffset = offsets[Math.floor(offsets.length/2)];
  const medianDelay = delays[Math.floor(delays.length/2)];
  // debug populate
  dbgLocal.textContent = Date.now();
  dbgOffsetEl.textContent = medianOffset.toFixed(1);
  dbgDelayEl.textContent = medianDelay.toFixed(1);
  schedulingOffset = Math.round(medianOffset); // ms
  return { offset: schedulingOffset, delay: medianDelay, samples: results };
}

// =========== Leader / Follower UI logic ===========
document.getElementById('leaderBtn').addEventListener('click', async ()=> {
  // create leader on server
  try {
    const payload = {
      bpm,
      beatsPerMeasure,
      name: undefined,
      allowChanges: document.getElementById('allowChanges').checked,
      startTime: Date.now() + 1500 // give 1.5s for joiners by default
    };
    const r = await fetch('/api/leaders', {
      method: 'POST',
      headers: {'content-type':'application/json'},
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const text = await r.text();
      alert('Leader create failed: ' + r.status + ' ' + text);
      return;
    }
    const leader = await r.json();
    // show ID and start local scheduler aligned to server time
    alert('Leader created: ' + leader.id + '\nstartTime: ' + leader.startTime);
    // schedule local start exactly at server startTime (we should compute offset too)
    // do a quick timeSync to compute schedulingOffset
    await timeSync(10);
    startLocal(leader.startTime + schedulingOffset);
    refreshLeaderList();
  } catch (e) {
    console.error(e);
    alert('Leader create error: ' + e.message);
  }
});

async function refreshLeaderList() {
  try {
    const r = await fetch('/api/leaders');
    const arr = await r.json();
    const container = document.getElementById('leaderList');
    if (!Array.isArray(arr) || arr.length === 0) {
      container.innerHTML = '<div style="margin-top:8px;color:#666">No leaders</div>';
      return;
    }
    container.innerHTML = arr.map(l => {
      return `<div style="margin-top:6px">
        <strong>${l.name || l.id}</strong>
        &nbsp; BPM:${l.bpm} / beats:${l.beatsPerMeasure || 0}
        &nbsp; <button data-id="${l.id}" onclick="joinLeaderBtn(event)">Join</button>
      </div>`;
    }).join('');
  } catch (e) {
    console.warn('refresh leaders failed', e);
  }
}

// global join helper for onclick in innerHTML
window.joinLeaderBtn = async function(ev) {
  const id = ev.target.getAttribute('data-id');
  if (!id) return;
  await joinLeader(id);
};

async function joinLeader(id) {
  try {
    // 1. timesync to compute offset
    const t = await timeSync(12);
    // 2. get leader config
    const r = await fetch('/api/leaders?id=' + encodeURIComponent(id));
    if (!r.ok) { alert('leader fetch failed: ' + r.status); return; }
    const leader = await r.json();
    // 3. apply leader config and start aligned
    bpm = Number(leader.bpm) || bpm;
    beatsPerMeasure = Number(leader.beatsPerMeasure) || beatsPerMeasure;
    document.getElementById('bpm').value = bpm;
    document.getElementById('bpmValue').textContent = bpm;
    document.getElementById('beatsPerMeasure').value = beatsPerMeasure;

    // The leader.startTime is server epoch ms. We already computed schedulingOffset (server - local).
    // We need to compute local start = leader.startTime - offsetLocalToServer? We used schedulingOffset as server - local,
    // So local time to start = leader.startTime - schedulingOffset (serverTime = local + schedulingOffset).
    // But code above uses startLocal(leader.startTime + schedulingOffset) when leader created; to align: convert so:
    // server-time = local + schedulingOffset  => local = server-time - schedulingOffset
    const localStart = leader.startTime - schedulingOffset;
    dbgLeaderStart.textContent = leader.startTime + ' (server)';
    // Start metronome aligned:
    startLocal(leader.startTime - schedulingOffset);
    alert('Joined leader ' + id + ' (offset ' + schedulingOffset + ' ms)');
  } catch (e) {
    console.error('joinLeader error', e);
    alert('join error: ' + e.message);
  }
}

// initial load
refreshLeaderList();
