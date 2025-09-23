// metronome.js
// WebAudio precise scheduling + DataChannel ping/pong + timesync multi-sample + UI
(() => {
  // endpoints (server must provide these)
  const API_LEADERS = '/api/leaders';
  const API_TIMESYNC = '/api/timesync';
  const API_SIGNAL = '/api/signal';

  // DOM
  const leaderLabelInput = document.getElementById('leaderLabel');
  const bpmRange = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  const beatsPerMeasureSel = document.getElementById('beatsPerMeasure');
  const soundToggle = document.getElementById('soundToggle');
  const startLocalBtn = document.getElementById('startLocal');
  const stopLocalBtn = document.getElementById('stopLocal');
  const startLeaderBtn = document.getElementById('startLeader');
  const allowChangesInput = document.getElementById('allowChanges');
  const leaderSelect = document.getElementById('leaderSelect');
  const joinLeaderBtn = document.getElementById('joinLeaderBtn');

  const beatVisual = document.getElementById('beatVisual');
  const dbgLocal = document.getElementById('dbgLocal');
  const dbgOffset = document.getElementById('dbgOffset');
  const dbgDelay = document.getElementById('dbgDelay');
  const dbgLeaderStart = document.getElementById('dbgLeaderStart');
  const dbgBeat = document.getElementById('dbgBeat');

  // state
  let audioCtx = null;
  let schedulerTimer = null;     // setInterval for lookahead
  let nextNoteTime = 0;         // audioCtx time for next scheduled note
  let noteInterval = 0;         // seconds between beats (1 beat)
  let scheduleAheadTime = 0.4;  // seconds to schedule ahead
  let lookahead = 25;           // ms, scheduler tick
  let current16th = 0;          // beat counter (we use beatIndex)
  let bpm = Number(bpmRange.value || 120);
  let beatsPerMeasure = Number(beatsPerMeasureSel.value || 0);
  let soundEnabled = soundToggle.checked;
  let isPlaying = false;
  let isLeader = false;
  let currentLeader = null; // object from server
  let offsetMs = 0; // server - local (ms) from timesync
  let medianDelay = 0;

  // WebRTC
  let pc = null;
  let dc = null;
  let leaderLabel = null;
  let dcPingInterval = null;

  // helpers
  function randLabel() {
    const s = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0,6);
    return 'Beat-' + s.slice(0,4);
  }
  leaderLabelInput.value = randLabel();

  // update UI bindings
  bpmVal.textContent = String(bpm);
  bpmRange.addEventListener('input', () => {
    bpm = Number(bpmRange.value);
    bpmVal.textContent = String(bpm);
    noteInterval = 60 / bpm;
    // if playing, recompute scheduling
    if (isPlaying) resetSchedulerForBPMChange();
  });

  beatsPerMeasureSel.addEventListener('change', () => {
    beatsPerMeasure = Number(beatsPerMeasureSel.value);
    renderSegments();
    // do not restart playing; scheduler will use new beatsPerMeasure on next beat
  });

  soundToggle.addEventListener('change', () => soundEnabled = soundToggle.checked);

  // WebAudio helpers
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // schedule one click at precise audio time
  function scheduleClick(audioTime, isAccent) {
    ensureAudio();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = isAccent ? 1000 : 700;
    g.gain.setValueAtTime(0.0001, audioTime);
    g.gain.linearRampToValueAtTime(0.8, audioTime + 0.001);
    g.gain.exponentialRampToValueAtTime(0.001, audioTime + 0.12);
    o.connect(g); g.connect(audioCtx.destination);
    o.start(audioTime);
    o.stop(audioTime + 0.13);
  }

  // visual functions: render segments and update persistent state
  function renderSegments() {
    beatVisual.innerHTML = '';
    if (beatsPerMeasure > 0) {
      for (let i=0;i<beatsPerMeasure;i++){
        const seg = document.createElement('div');
        seg.className = 'segment';
        seg.dataset.index = String(i);
        seg.style.flexBasis = `${100 / beatsPerMeasure}%`;
        beatVisual.appendChild(seg);
      }
    } else {
      // single flashing bar
      const seg = document.createElement('div');
      seg.className = 'segment flash';
      seg.style.flexBasis = '100%';
      beatVisual.appendChild(seg);
    }
  }

  function updateVisual(beatIndex) {
    const segs = Array.from(beatVisual.children);
    if (beatsPerMeasure > 0) {
      // mark all up to current as active (persistent fill)
      segs.forEach((s, idx) => {
        if (idx <= (beatIndex % beatsPerMeasure)) s.classList.add('active');
        else s.classList.remove('active');
      });
    } else {
      // flash entire bar each beat (toggle visible)
      const seg = segs[0];
      if (!seg) return;
      // to ensure visible, set class active briefly and then remove
      seg.classList.add('active');
      setTimeout(() => seg.classList.remove('active'), 120);
    }
  }

  // compute audioCtx time that corresponds to a target local epoch ms
  // localEpochMs: Date.now() based epoch in ms
  function audioTimeFromLocalEpoch(localEpochMs) {
    ensureAudio();
    const nowLocalMs = Date.now();
    const dtSec = (localEpochMs - nowLocalMs) / 1000.0;
    return audioCtx.currentTime + dtSec;
  }

  // scheduler: schedules notes ahead using audioCtx times
  function schedulerTick() {
    // schedule while nextNoteTime is within scheduleAheadTime
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      // compute beat index corresponding to nextNoteTime
      const beatIndex = current16th;
      const isAccent = (beatsPerMeasure > 0) ? (beatIndex % beatsPerMeasure === 0) : true;
      // schedule audio click
      scheduleClick(nextNoteTime, isAccent && soundEnabled);
      // schedule visual update slightly after audio for sync (use setTimeout relative to real time)
      const localPlayMs = Date.now() + ((nextNoteTime - audioCtx.currentTime) * 1000);
      const delayMs = Math.max(0, localPlayMs - Date.now());
      setTimeout(() => updateVisual(beatIndex), delayMs);

      // broadcast if leader (include server timestamp)
      if (isLeader && dc && dc.readyState === 'open' && currentLeader) {
        // serverTs approximation: server = local + offsetMs
        const serverTs = (Date.now() + offsetMs) + Math.round((nextNoteTime - audioCtx.currentTime)*1000);
        try {
          dc.send(JSON.stringify({ type:'beat', beatIndex, bpm, beatsPerMeasure, serverTs }));
        } catch(e){ console.warn('dc send fail', e); }
      }

      // advance to next note
      nextNoteTime += noteInterval;
      current16th++;
      dbgBeat.textContent = String(current16th);
    }
  }

  function startSchedulerAtLocalStart(localStartMs) {
    ensureAudio();
    // resume audio context on user gesture
    if (audioCtx.state === 'suspended') audioCtx.resume();

    // compute initial nextNoteTime in audioCtx time
    // If localStartMs in future: set nextNoteTime = audioTimeFromLocalEpoch(localStartMs)
    // If localStartMs in past: compute next beat slot
    const nowLocal = Date.now();
    noteInterval = 60 / bpm;
    if (!localStartMs || localStartMs <= nowLocal) {
      // start immediately, align nextNoteTime slightly in future
      nextNoteTime = audioCtx.currentTime + 0.05; // 50ms from now
      current16th = 0;
    } else {
      // schedule first beat at that local epoch time
      nextNoteTime = audioTimeFromLocalEpoch(localStartMs);
      current16th = 0;
    }

    // clear any existing tickers
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(schedulerTick, lookahead);
    isPlaying = true;
  }

  function stopScheduler() {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    isPlaying = false;
    current16th = 0;
    dbgBeat.textContent = '-';
    // reset visual (all off)
    renderSegments();
    updateVisual(0);
  }

  function resetSchedulerForBPMChange() {
    // recompute noteInterval and adjust nextNoteTime preserving phase roughly
    noteInterval = 60 / bpm;
    // we will keep current16th but recompute nextNoteTime from now
    // set nextNoteTime slightly in future
    ensureAudio();
    nextNoteTime = audioCtx.currentTime + 0.05;
  }

  // ------------------ timesync multi-sample NTP-style ------------------
  // returns { offset, delay } and sets offsetMs, medianDelay
  async function timesyncMulti(samples = 12) {
    const results = [];
    for (let i=0;i<samples;i++) {
      const T1 = Date.now();
      try {
        const r = await fetch(API_TIMESYNC, {
          method:'POST',
          headers:{'content-type':'application/json'},
          body: JSON.stringify({ clientTime: T1 })
        });
        const T4 = Date.now();
        if (!r.ok) {
          const txt = await r.text();
          console.warn('timesync sample failed', r.status, txt);
          await new Promise(r=>setTimeout(r, 40));
          continue;
        }
        const j = await r.json(); // { t1, t2, t3, rtt, medianRTT }
        const T2 = j.t2;
        const T3 = j.t3;
        const offset = ((T2 - T1) + (T3 - T4)) / 2;
        const delay = (T4 - T1) - (T3 - T2);
        results.push({ offset, delay, T1, T2, T3, T4 });
      } catch (e) {
        console.warn('timesync sample exception', e);
      }
      await new Promise(r => setTimeout(r, 30 + Math.random()*20));
    }

    if (results.length === 0) throw new Error('timesync failed');

    results.sort((a,b) => a.delay - b.delay);
    const keep = results.slice(0, Math.max(3, Math.floor(results.length/2)));
    const offsets = keep.map(x=>x.offset).sort((a,b)=>a-b);
    const delays = keep.map(x=>x.delay).sort((a,b)=>a-b);
    const medianOffset = offsets[Math.floor(offsets.length/2)];
    const medianDelayVal = delays[Math.floor(delays.length/2)];

    offsetMs = Math.round(medianOffset);
    medianDelay = medianDelayVal;
    dbgLocal.textContent = String(Date.now());
    dbgOffset.textContent = offsetMs.toFixed(1);
    dbgDelay.textContent = medianDelay.toFixed(1);
    return { offset: offsetMs, delay: medianDelay };
  }

  // ------------------ leader list APIs ------------------
  async function refreshLeaderList() {
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { leaderSelect.innerHTML = '<option value="">(error)</option>'; return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        leaderSelect.innerHTML = '<option value="">(no leaders)</option>';
        return;
      }
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refreshLeaderList', e);
      leaderSelect.innerHTML = '<option value="">(error)</option>';
    }
  }

  async function createLeaderOnServer() {
    const label = (leaderLabelInput.value || '').trim() || randLabel();
    const payload = {
      label,
      bpm,
      beatsPerMeasure,
      allowChangesByOthers: !!allowChangesInput.checked,
      startTime: Date.now() + 1500
    };
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('create leader failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    currentLeader = leader;
    leaderLabel = leader.label;
    dbgLeaderStart.textContent = String(leader.startTime);
    return leader;
  }

  // ------------------ WebRTC signaling & DC ping/pong ------------------
  async function setupLeaderWebRTC(label) {
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('beatSync');
    dc.onopen = () => {
      console.log('dc open (leader)');
      // start responding to dc pings (handled in onmessage)
      // start sending periodic ping to followers? leader will respond to pings from followers.
    };
    dc.onmessage = (ev) => {
      // support follower->leader ping: follower sends {type:'dc_ping', t1}
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'dc_ping') {
          // reply immediately with dc_pong: include t1, t2 (leader recv), t3 (leader send)
          const t2 = Date.now();
          const reply = { type:'dc_pong', t1: msg.t1, t2, t3: Date.now() };
          try { dc.send(JSON.stringify(reply)); } catch(e){ console.warn('dc pong send fail', e); }
        } else {
          // other messages (not used here)
          console.log('leader dc got', msg);
        }
      } catch (e) { console.warn('leader dc message parse err', e); }
    };
    pc.onicecandidate = e => { if (e.candidate) console.log('leader ice', e.candidate); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // post offer to signaling server
    const r = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'offer', label, payload: offer }) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('post offer failed: ' + r.status + ' ' + txt);
    }
    // poll for answer
    let tries = 0;
    const poll = async () => {
      tries++;
      const q = `?type=answer&label=${encodeURIComponent(label)}`;
      try {
        const r2 = await fetch(API_SIGNAL + q);
        if (!r2.ok) { if (tries < 20) return setTimeout(poll, 500); else throw new Error('poll answer failed'); }
        const j = await r2.json();
        if (j.payload) {
          await pc.setRemoteDescription(j.payload);
          console.log('leader set remote answer');
          return;
        } else {
          if (tries < 20) setTimeout(poll, 500);
        }
      } catch (e) {
        if (tries < 20) setTimeout(poll, 500);
        else console.warn('poll error', e);
      }
    };
    poll();
  }

  async function joinLeaderWebRTC(label) {
    // fetch offer
    const q = `?type=offer&label=${encodeURIComponent(label)}`;
    const r = await fetch(API_SIGNAL + q);
    if (!r.ok) throw new Error('fetch offer failed: ' + r.status);
    const j = await r.json();
    if (!j.payload) throw new Error('no offer found');

    pc = new RTCPeerConnection();
    pc.ondatachannel = ev => {
      dc = ev.channel;
      dc.onopen = () => console.log('dc open (follower)');
      dc.onmessage = ev => handleLeaderDCMessage(ev.data);
    };
    await pc.setRemoteDescription(j.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // post answer
    const r2 = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'answer', label, payload: answer }) });
    if (!r2.ok) {
      const txt = await r2.text();
      throw new Error('post answer failed: ' + r2.status + ' ' + txt);
    }
    console.log('follower posted answer');

    // start periodic DC ping to leader for drift compensation
    startDCPingPong();
  }

  // follower handling of beat messages
  function handleLeaderDCMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'beat') {
        // leader provides serverTs for the scheduled beat
        // convert to local play time: localPlayMs = serverTs - offsetMs
        const serverTs = msg.serverTs;
        const localPlayMs = Number(serverTs) - Number(offsetMs);
        // compute audioCtx time for localPlayMs
        const audioWhen = audioTimeFromLocalEpoch(localPlayMs);
        // schedule click precisely at audioWhen
        const isAccent = (msg.beatsPerMeasure > 0) ? (msg.beatIndex % msg.beatsPerMeasure === 0) : true;
        scheduleClick(audioWhen, isAccent && soundEnabled);
        // update visual at actual localPlayMs
        const delayMs = Math.max(0, localPlayMs - Date.now());
        setTimeout(()=> updateVisual(msg.beatIndex), delayMs);
        dbgBeat.textContent = String(msg.beatIndex);
      } else if (msg.type === 'dc_pong') {
        // pong reply from leader containing t1 (follower t1), t2 (leader recv), t3 (leader send)
        const t4 = Date.now();
        const t1 = msg.t1;
        const t2 = msg.t2;
        const t3 = msg.t3;
        const offsetPeer = ((t2 - t1) + (t3 - t4)) / 2; // leader - follower
        const rtt = (t4 - t1) - (t3 - t2);
        // blend offsetPeer into offsetMs (we have server-based offset as baseline)
        // small smoothing: weighted average
        const alpha = 0.4; // tune between immediate and stable
        offsetMs = Math.round((1 - alpha) * offsetMs + alpha * (offsetMs + offsetPeer)); // adjust baseline by peer offset
        // update debug
        dbgOffset.textContent = String(offsetMs.toFixed(1));
        dbgDelay.textContent = String(rtt.toFixed(1));
      }
    } catch (e) { console.warn('handleLeaderDCMessage err', e); }
  }

  // start periodic DC ping from follower -> leader
  function startDCPingPong() {
    if (!dc || dc.readyState !== 'open') return;
    stopDCPingPong();
    dcPingInterval = setInterval(() => {
      try {
        const t1 = Date.now();
        dc.send(JSON.stringify({ type:'dc_ping', t1 }));
      } catch (e) { console.warn('dc ping send fail', e); }
    }, 2000); // every 2s
  }
  function stopDCPingPong() {
    if (dcPingInterval) { clearInterval(dcPingInterval); dcPingInterval = null; }
  }

  // compute audioCtx time from local epoch ms
  function audioTimeFromLocalEpoch(localEpochMs) {
    ensureAudio();
    const nowLocalMs = Date.now();
    const dt = (localEpochMs - nowLocalMs) / 1000;
    return audioCtx.currentTime + dt;
  }

  // visual helpers
  function updateVisual(beatIndex) {
    const segs = Array.from(beatVisual.children);
    if (beatsPerMeasure > 0) {
      segs.forEach((s, idx) => {
        if (idx <= (beatIndex % beatsPerMeasure)) s.classList.add('active');
        else s.classList.remove('active');
      });
    } else {
      const seg = segs[0];
      if (!seg) return;
      seg.classList.add('active');
      setTimeout(()=> seg.classList.remove('active'), 120);
    }
  }

  // ------------ Button handlers -------------
  startLocalBtn.addEventListener('click', () => {
    // local start immediate (no leader alignment)
    isLeader = false;
    // compute local epoch start as now + small gap
    const localStart = Date.now() + 50;
    startSchedulerAtLocalStart(localStart);
  });

  stopLocalBtn.addEventListener('click', () => {
    stopScheduler();
    stopDCPingPong();
  });

  startLeaderBtn.addEventListener('click', async () => {
    try {
      // compute timesync multi-sample first to establish baseline offsetMs
      await timesyncMulti(12);
      const leader = await createLeaderOnServer();
      currentLeader = leader;
      isLeader = true;
      // apply leader settings immediately
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();
      // compute local start time from leader.startTime
      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = String(leader.startTime);
      startSchedulerAtLocalStart(localStart);
      // setup WebRTC leader (offer & publish)
      await setupLeaderWebRTC(leader.label);
      // refresh list
      setTimeout(refreshLeaderList, 400);
    } catch (e) {
      console.error('start leader failed', e);
      alert('Start leader failed: ' + (e && e.message));
    }
  });

  joinLeaderBtn.addEventListener('click', async () => {
    const sel = leaderSelect.value;
    if (!sel) return alert('請先選擇一個 leader');
    const label = decodeURIComponent(sel);
    try {
      // timesync multi-sample
      await timesyncMulti(12);
      // fetch leader
      const r = await fetch(API_LEADERS + '?label=' + encodeURIComponent(label));
      if (!r.ok) throw new Error('fetch leader failed: ' + r.status);
      const leader = await r.json();
      currentLeader = leader;
      // apply leader settings (this was the bug earlier)
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();
      // compute local start from leader.startTime and start scheduler aligned
      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = String(leader.startTime);
      startSchedulerAtLocalStart(localStart);
      // join WebRTC
      await joinLeaderWebRTC(leader.label);
    } catch (e) {
      console.error('join failed', e);
      alert('Join failed: ' + (e && e.message));
    }
  });

  // server create leader helper
  async function createLeaderOnServer() {
    const label = (leaderLabelInput.value || '').trim() || randLabel();
    const payload = {
      label,
      bpm,
      beatsPerMeasure,
      allowChangesByOthers: !!allowChangesInput.checked,
      startTime: Date.now() + 1500
    };
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('create leader failed: ' + r.status + ' ' + txt);
    }
    return r.json();
  }

  // helper: compute local ms for a given leader startTime (server ms)
  function computeLocalStartFromLeader(serverStartMs) {
    return Number(serverStartMs) - Number(offsetMs);
  }

  // ------------ init / UI refresh -------------
  async function refreshLeaderList() {
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { leaderSelect.innerHTML = '<option value="">(error)</option>'; return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        leaderSelect.innerHTML = '<option value="">(no leaders)</option>';
        return;
      }
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refreshLeaderList err', e);
      leaderSelect.innerHTML = '<option value="">(error)</option>';
    }
  }

  // bootstrap
  function init() {
    bpm = Number(bpmRange.value);
    beatsPerMeasure = Number(beatsPerMeasureSel.value);
    soundEnabled = soundToggle.checked;
    noteInterval = 60 / bpm;
    renderSegments();
    updateVisual(0);
    refreshLeaderList();
    setInterval(refreshLeaderList, 5000);
  }

  // expose debug helpers
  window._metronome = { timesyncMulti };

  init();
})();
