// metronome.js - 完整前端 (視覺化長條 + timesync multi-sample + WebRTC signaling + leader/follower)
// 注意：此檔假設 /api/leaders, /api/timesync, /api/signal 已在 server 端實作（如 earlier messages）

(() => {
  // ---- Config / endpoints ----
  const API_LEADERS = '/api/leaders';
  const API_TIMESYNC = '/api/timesync';
  const API_SIGNAL = '/api/signal';

  // ---- DOM ----
  const leaderLabelInput = document.getElementById('leaderLabel');
  const bpmRange = document.getElementById('bpm');
  const bpmVal = document.getElementById('bpmVal');
  const beatsPerMeasureInput = document.getElementById('beatsPerMeasure');
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

  // ---- State ----
  let audioCtx = null;
  let playingTimer = null;
  let beatIndex = 0;
  let bpm = Number(bpmRange.value || 120);
  let beatsPerMeasure = Number(beatsPerMeasureInput.value || 0);
  let soundEnabled = soundToggle.checked;
  let isLeader = false;
  let currentLeader = null;
  let offsetMs = 0; // serverTime - localTime (ms)
  let medianDelay = 0;

  // WebRTC
  let pc = null;
  let dc = null;
  let leaderLabel = null;

  // ---- Utilities ----
  function randLabel(){
    const s = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    return 'Beat-' + s.slice(0,4);
  }

  // init leader label randomized on load
  leaderLabelInput.value = randLabel();

  // Audio helpers
  function ensureAudio(){
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  function playClick(isAccent){
    if (!soundEnabled) return;
    try {
      ensureAudio();
      const now = audioCtx.currentTime;
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = isAccent ? 1000 : 730;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.linearRampToValueAtTime(0.8, now + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(now);
      o.stop(now + 0.13);
    } catch (e) { console.warn('playClick error', e); }
  }

  // Visual: build segments
  function renderSegments(){
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
      const seg = document.createElement('div');
      seg.className = 'segment flash';
      seg.style.flexBasis = '100%';
      beatVisual.appendChild(seg);
    }
  }

  function updateVisual(current){
    const segs = Array.from(beatVisual.children);
    if (beatsPerMeasure > 0) {
      segs.forEach((s, idx) => {
        if (idx <= (current % beatsPerMeasure)) s.classList.add('active');
        else s.classList.remove('active');
      });
    } else {
      // flash entire bar on every beat (toggle)
      const seg = segs[0];
      if (!seg) return;
      seg.classList.toggle('active');
    }
  }

  // ---- Scheduler ----
  function stopLocalScheduler(){
    if (playingTimer) { clearInterval(playingTimer); playingTimer = null; }
    beatIndex = 0;
    dbgBeat.textContent = '-';
    // reset visual if segmented: keep active according to beatIndex=0
    updateVisual(0);
  }

  // compute local epoch ms that corresponds to server startTime
  function computeLocalStartFromLeader(serverStartMs){
    return Number(serverStartMs) - Number(offsetMs);
  }

  function startLocalSchedulerAligned(localStartMs = null){
    stopLocalScheduler();

    const intervalMs = 60000 / bpm;

    // if leader-local-start provided
    if (localStartMs) {
      const now = Date.now();
      const delta = localStartMs - now;
      if (delta > 50) {
        // schedule to begin at that time
        setTimeout(()=> {
          // set initial beat index to zero and run
          beatIndex = 0;
          doBeat(); // immediate first beat
          playingTimer = setInterval(doBeat, intervalMs);
        }, delta);
        return;
      } else {
        // leader has already started — compute where we are
        const elapsed = now - localStartMs;
        const beatsSince = Math.floor(elapsed / intervalMs);
        beatIndex = beatsSince + 1;
        const nextDelay = intervalMs - (elapsed % intervalMs);
        setTimeout(()=> {
          doBeat();
          playingTimer = setInterval(doBeat, intervalMs);
        }, Math.max(0, nextDelay));
        return;
      }
    }

    // no leader alignment -> immediate start
    beatIndex = 0;
    doBeat();
    playingTimer = setInterval(doBeat, intervalMs);
  }

  function doBeat(){
    const isAccent = (beatsPerMeasure > 0) ? (beatIndex % beatsPerMeasure === 0) : false;
    // play & visual
    playClick(isAccent);
    updateVisual(beatIndex);
    dbgBeat.textContent = String(beatIndex);
    // broadcast if leader via DataChannel with server timestamp idea
    if (isLeader && dc && dc.readyState === 'open' && currentLeader) {
      const serverTs = Date.now() + offsetMs; // approximate server epoch
      const msg = { type:'beat', beatIndex, bpm, beatsPerMeasure, serverTs };
      try { dc.send(JSON.stringify(msg)); } catch(e){ console.warn('dc send err', e); }
    }
    beatIndex++;
  }

  // ---- Timesync (NTP-style multi sample) ----
  // returns { offset, delay, samples }
  async function timesyncMulti(samples = 12){
    const results = [];
    for (let i=0;i<samples;i++){
      const T1 = Date.now();
      try {
        const r = await fetch(API_TIMESYNC, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ clientTime: T1 })
        });
        const T4 = Date.now();
        if (!r.ok) {
          const txt = await r.text();
          console.warn('timesync sample failed', r.status, txt);
          await new Promise(r=>setTimeout(r,40));
          continue;
        }
        const j = await r.json(); // { t1, t2, t3, rtt, medianRTT }
        const T2 = j.t2;
        const T3 = j.t3;
        const offset = ((T2 - T1) + (T3 - T4)) / 2;
        const delay = (T4 - T1) - (T3 - T2);
        results.push({ offset, delay, T1, T2, T3, T4 });
      } catch (e) {
        console.warn('timesync sample err', e);
      }
      await new Promise(r => setTimeout(r, 30 + Math.random()*30));
    }

    if (results.length === 0) throw new Error('timesync failed');

    // pick best half by lowest delay
    results.sort((a,b)=>a.delay - b.delay);
    const keep = results.slice(0, Math.max(3, Math.floor(results.length/2)));
    const offsets = keep.map(x=>x.offset).sort((a,b)=>a-b);
    const delays = keep.map(x=>x.delay).sort((a,b)=>a-b);
    const medianOffset = offsets[Math.floor(offsets.length/2)];
    const medianDelayVal = delays[Math.floor(delays.length/2)];

    // apply
    offsetMs = Math.round(medianOffset);
    medianDelay = medianDelayVal; // set variable (was const problem earlier)
    // debug UI
    dbgLocal.textContent = String(Date.now());
    dbgOffset.textContent = offsetMs.toFixed(1);
    dbgDelay.textContent = medianDelay.toFixed(1);
    return { offset: offsetMs, delay: medianDelay, samples: results };
  }

  // ---- Leader list / create APIs ----
  async function refreshLeaderList(){
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
      console.warn('refresh leader list err', e);
      leaderSelect.innerHTML = '<option value="">(error)</option>';
    }
  }

  async function createLeaderOnServer(){
    const label = (leaderLabelInput.value || '').trim() || randLabel();
    const payload = {
      label,
      bpm,
      beatsPerMeasure,
      allowChangesByOthers: !!allowChangesInput.checked,
      startTime: Date.now() + 1500
    };
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
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

  // ---- WebRTC signaling & DC ----
  async function setupLeaderWebRTC(label){
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('beatSync');
    dc.onopen = ()=>console.log('dc open (leader)');
    dc.onmessage = e=>console.log('leader dc recv', e.data);
    pc.onicecandidate = e=>{ if (e.candidate) console.log('leader ice', e.candidate); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // send offer + label to server
    const r = await fetch(API_SIGNAL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ type:'offer', label, payload: offer }) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('post offer failed: ' + r.status + ' ' + txt);
    }

    // poll for answer
    let tries = 0;
    const poll = async () => {
      tries++;
      const q = `?type=answer&label=${encodeURIComponent(label)}`;
      const r2 = await fetch(API_SIGNAL + q);
      if (!r2.ok) {
        if (tries < 20) return setTimeout(poll, 500);
        else throw new Error('poll answer failed');
      }
      const j = await r2.json();
      if (j.payload) {
        await pc.setRemoteDescription(j.payload);
        console.log('leader set remote answer');
        return;
      } else {
        if (tries < 20) setTimeout(poll, 500);
      }
    };
    poll();
  }

  async function joinLeaderWebRTC(label){
    // fetch offer
    const q = `?type=offer&label=${encodeURIComponent(label)}`;
    const r = await fetch(API_SIGNAL + q);
    if (!r.ok) throw new Error('fetch offer failed: ' + r.status);
    const j = await r.json();
    if (!j.payload) throw new Error('no offer found');

    pc = new RTCPeerConnection();
    pc.ondatachannel = ev => {
      dc = ev.channel;
      dc.onopen = ()=>console.log('dc open (follower)');
      dc.onmessage = ev => handleLeaderDCMessage(ev.data);
    };
    await pc.setRemoteDescription(j.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // post answer
    const r2 = await fetch(API_SIGNAL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ type:'answer', label, payload: answer }) });
    if (!r2.ok) {
      const txt = await r2.text();
      throw new Error('post answer failed: ' + r2.status + ' ' + txt);
    }
    console.log('follower posted answer');
  }

  function handleLeaderDCMessage(raw){
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'beat') {
        // serverTs provided by leader; compute local play time
        const serverTs = msg.serverTs || msg.serverTs === 0 ? msg.serverTs : (Date.now() + offsetMs);
        const localPlay = serverTs - offsetMs; // local epoch ms
        const delay = localPlay - Date.now();
        if (delay <= 20) {
          // play immediately
          playClick(msg.beatsPerMeasure>0 ? (msg.beatIndex % msg.beatsPerMeasure === 0) : false);
          updateVisual(msg.beatIndex);
          dbgBeat.textContent = String(msg.beatIndex);
        } else {
          setTimeout(()=> {
            playClick(msg.beatsPerMeasure>0 ? (msg.beatIndex % msg.beatsPerMeasure === 0) : false);
            updateVisual(msg.beatIndex);
            dbgBeat.textContent = String(msg.beatIndex);
          }, delay);
        }
      }
    } catch(e){ console.warn('handleLeaderDCMessage', e); }
  }

  // ---- Button handlers ----
  startLocalBtn.addEventListener('click', () => {
    isLeader = false;
    startLocalSchedulerAligned(null);
  });
  stopLocalBtn.addEventListener('click', () => stopLocalScheduler());

  startLeaderBtn.addEventListener('click', async () => {
    try {
      await timesyncMulti(12); // compute offsetMs
      const leader = await createLeaderOnServer();
      isLeader = true;
      currentLeader = leader;
      const localStart = computeLocalStartFromLeader(leader.startTime);
      startLocalSchedulerAligned(localStart);
      await setupLeaderWebRTC(leader.label);
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
      await timesyncMulti(12); // compute offsetMs
      // fetch leader detail
      const r = await fetch(API_LEADERS + '?label=' + encodeURIComponent(label));
      if (!r.ok) throw new Error('fetch leader detail failed: ' + r.status);
      const leader = await r.json();
      currentLeader = leader;
      const localStart = computeLocalStartFromLeader(leader.startTime);
      startLocalSchedulerAligned(localStart);
      await joinLeaderWebRTC(leader.label);
    } catch (e) {
      console.error('join failed', e);
      alert('Join failed: ' + (e && e.message));
    }
  });

  // ---- init ----
  // initial render and populate segments
  function init(){
    bpm = Number(bpmRange.value);
    beatsPerMeasure = Number(beatsPerMeasureInput.value);
    soundEnabled = soundToggle.checked;
    renderSegments();
    updateVisual(0);
    refreshLeaderList();
    setInterval(refreshLeaderList, 5000);
  }

  // refresh when inputs change
  bpmRange.addEventListener('input', () => {
    bpm = Number(bpmRange.value);
    bpmVal.textContent = String(bpm);
    // restart scheduler with new bpm if playing
    if (playingTimer) startLocalSchedulerAligned(null);
  });
  beatsPerMeasureInput.addEventListener('input', () => {
    beatsPerMeasure = Math.max(0, Number(beatsPerMeasureInput.value));
    renderSegments();
    updateVisual(0);
  });
  soundToggle.addEventListener('change', () => soundEnabled = soundToggle.checked);

  // expose helpers for debug
  window._metronome = { timesyncMulti };

  // start
  init();

})();
