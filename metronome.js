// metronome.js
// multi-beat pre-scheduling + dc ping/pong + timesync multi + join fixes + stronger 0 flash + debug logging
(() => {
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
  const debugLogEl = document.getElementById('debugLog');

  // state
  let audioCtx = null;
  let schedulerTimer = null;
  let nextNoteTime = 0;       // audioCtx time for next scheduled note
  let noteInterval = 60/120;  // seconds per beat
  let scheduleAheadTime = 1.2; // seconds to schedule ahead (multi-beat)
  let lookahead = 25;         // ms for scheduler tick
  let nextBeatNumber = 0;     // absolute index of next beat to schedule
  let lastPlayedBeatNumber = -1; // absolute index of last played beat (for visual)
  let scheduledBeats = new Set(); // avoid duplicate scheduling by beatNumber
  let bpm = Number(bpmRange.value || 120);
  let beatsPerMeasure = Number(beatsPerMeasureSel.value || 4);
  let soundEnabled = soundToggle.checked;
  let isPlaying = false;
  let isLeader = false;
  let currentLeader = null;
  let offsetMs = 0; // server - local (ms)
  let medianDelay = 0;
  let leaderOffsetMs = 0; // leader's offset measured at leader device (server - leader_local)

  // WebRTC
  let pc = null;
  let dc = null;
  let leaderLabel = null;
  let dcPingInterval = null;

  // debug buffer
  const debugLines = [];
  function appendDebug(s) {
    const t = new Date().toISOString().slice(11,23) + ' ' + s;
    debugLines.push(t);
    if (debugLines.length > 200) debugLines.shift();
    debugLogEl.innerText = debugLines.slice().reverse().join('\n'); // newest first
  }

  // utilities
  function randLabel(){
    const s = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    return 'Beat-' + s.slice(0,4);
  }
  leaderLabelInput.value = randLabel();

  // audio helpers
  function ensureAudio(){
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  function scheduleClick(audioTime, isAccent){
    ensureAudio();
    if (!soundEnabled) return;
    try {
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
    } catch (e) { console.warn('scheduleClick err', e); }
  }

  // visual
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

  function updateVisual(beatIdx){
    const segs = Array.from(beatVisual.children);
    if (beatsPerMeasure > 0) {
      segs.forEach((s, idx) => {
        if (idx <= (beatIdx % beatsPerMeasure)) s.classList.add('active');
        else s.classList.remove('active');
      });
    } else {
      const seg = segs[0];
      if (!seg) return;
      // stronger flash: longer and bright red
      seg.classList.add('active');
      setTimeout(()=> seg.classList.remove('active'), 300);
    }
  }

  // convert local epoch ms -> audioCtx time
  function audioTimeFromLocalEpoch(localEpochMs){
    ensureAudio();
    const nowLocal = Date.now();
    const dt = (localEpochMs - nowLocal) / 1000.0;
    return audioCtx.currentTime + dt;
  }

  // scheduling loop (pre-schedule many beats)
  function schedulerTick(){
    if (!audioCtx) return;
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      const bn = nextBeatNumber;
      if (!scheduledBeats.has(bn)) {
        // compute local epoch ms for this note using mapping audioCtx -> Date.now
        const localPlayMs = Date.now() + Math.round((nextNoteTime - audioCtx.currentTime)*1000);
        const beatIdxForUI = bn; // absolute
        const isAccent = (beatsPerMeasure > 0) ? (bn % beatsPerMeasure === 0) : true;

        // schedule audio
        scheduleClick(nextNoteTime, isAccent && soundEnabled);
        // schedule visual at play time
        const delayMs = Math.max(0, localPlayMs - Date.now());
        setTimeout(()=> updateVisual(beatIdxForUI), delayMs);

        // leader sends message including serverScheduledMs and leaderOffsetMs (leader's measured offset)
        if (isLeader && dc && dc.readyState === 'open' && currentLeader) {
          const serverScheduledMs = localPlayMs + (leaderOffsetMs || 0); // server = local + leaderOffset
          const msg = {
            type: 'beat',
            beatNumber: bn,
            beatIndex: bn,
            beatsPerMeasure,
            bpm,
            serverScheduledMs,
            leaderOffsetMs: leaderOffsetMs || 0
          };
          try { dc.send(JSON.stringify(msg)); appendDebug(`leader sent beat bn=${bn} serverMs=${serverScheduledMs}`); } catch(e){ console.warn('dc send err', e); }
        }

        scheduledBeats.add(bn);
      }

      nextNoteTime += noteInterval;
      nextBeatNumber++;
    }
  }

  function startSchedulerAtLocalStart(localStartMs){
    ensureAudio();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    noteInterval = 60 / bpm;
    scheduledBeats.clear();

    const nowLocal = Date.now();
    if (!localStartMs || localStartMs <= nowLocal) {
      if (localStartMs) {
        // leader already started: compute how many beats elapsed
        const elapsed = nowLocal - localStartMs;
        const beatsSince = Math.floor(elapsed / (noteInterval*1000));
        lastPlayedBeatNumber = beatsSince;
        // update visual immediately to show current beat
        updateVisual(lastPlayedBeatNumber);
        // next beat is beatsSince + 1
        nextBeatNumber = beatsSince + 1;
        const nextLocalMs = localStartMs + (beatsSince + 1) * noteInterval * 1000;
        nextNoteTime = audioTimeFromLocalEpoch(nextLocalMs);
        appendDebug(`start aligned: nowLocal=${nowLocal} localStart=${localStartMs} beatsSince=${beatsSince} nextLocalMs=${nextLocalMs}`);
      } else {
        // immediate start (no leader)
        nextNoteTime = audioCtx.currentTime + 0.05;
        nextBeatNumber = 0;
        lastPlayedBeatNumber = -1;
        appendDebug('start immediate local (no leader)');
      }
    } else {
      // future start
      nextNoteTime = audioTimeFromLocalEpoch(localStartMs);
      nextBeatNumber = 0;
      lastPlayedBeatNumber = -1;
      appendDebug(`scheduled future start at localStart=${localStartMs}`);
    }

    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(schedulerTick, lookahead);
    isPlaying = true;
  }

  function stopScheduler(){
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    isPlaying = false;
    nextBeatNumber = 0;
    lastPlayedBeatNumber = -1;
    scheduledBeats.clear();
    dbgBeat.textContent = '-';
    renderSegments();
    updateVisual(0);
    appendDebug('stopped scheduler');
  }

  function resetSchedulerForBPMChange(){
    noteInterval = 60 / bpm;
    ensureAudio();
    nextNoteTime = audioCtx.currentTime + 0.05;
    appendDebug(`BPM changed -> noteInterval=${noteInterval}`);
  }

  // -------- timesync multi-sample (NTP-like) ----------
  async function timesyncMulti(samples = 12) {
    const results = [];
    for (let i=0;i<samples;i++){
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
          appendDebug(`timesync sample failed ${r.status} ${txt}`);
          await new Promise(r=>setTimeout(r,40));
          continue;
        }
        const j = await r.json(); // { t1,t2,t3, rtt, medianRTT }
        const T2 = j.t2, T3 = j.t3;
        const offset = ((T2 - T1) + (T3 - T4)) / 2;
        const delay = (T4 - T1) - (T3 - T2);
        results.push({ offset, delay, T1, T2, T3, T4 });
        appendDebug(`timesync sample ${i}: offset=${offset.toFixed(1)} delay=${delay.toFixed(1)}`);
      } catch (e) {
        console.warn('timesync sample err', e);
      }
      await new Promise(r => setTimeout(r, 30 + Math.random()*30));
    }

    if (results.length === 0) throw new Error('timesync failed');

    results.sort((a,b)=>a.delay - b.delay);
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
    appendDebug(`timesync done: offsetMs=${offsetMs} medianDelay=${medianDelay}`);
    return { offset: offsetMs, delay: medianDelay };
  }

  // ---------- leader list / create ----------
  async function refreshLeaderList(){
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { leaderSelect.innerHTML = '<option value="">(error)</option>'; return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) { leaderSelect.innerHTML = '<option value="">(no leaders)</option>'; return; }
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refresh leaders err', e);
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
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('create leader failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    currentLeader = leader;
    dbgLeaderStart.textContent = String(leader.startTime);
    appendDebug(`leader created label=${leader.label} bpm=${leader.bpm} beats=${leader.beatsPerMeasure} start=${leader.startTime}`);
    return leader;
  }

  // ---------- WebRTC signaling & DC ----------
  async function setupLeaderWebRTC(label){
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('beatSync');
    dc.onopen = ()=> {
      appendDebug('leader DC open');
    };
    dc.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'dc_ping') {
          const t2 = Date.now();
          const reply = { type:'dc_pong', t1: msg.t1, t2, t3: Date.now(), leaderOffsetMs: leaderOffsetMs || 0 };
          try { dc.send(JSON.stringify(reply)); } catch(e){ console.warn('dc_pong send fail', e); }
        } else {
          appendDebug('leader DC recv: ' + JSON.stringify(msg).slice(0,200));
        }
      } catch (e) { console.warn('leader dc parse err', e); }
    };
    pc.onicecandidate = e => { if (e.candidate) console.log('leader ice', e.candidate); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const r = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'offer', label, payload: offer }) });
    if (!r.ok) throw new Error('signal POST offer failed');
    // poll for answer
    let tries = 0;
    const pollAnswer = async () => {
      tries++;
      const q = `?type=answer&label=${encodeURIComponent(label)}`;
      try {
        const rr = await fetch(API_SIGNAL + q);
        if (!rr.ok) { if (tries < 20) return setTimeout(pollAnswer, 500); else throw new Error('poll answer failed'); }
        const j = await rr.json();
        if (j.payload) {
          await pc.setRemoteDescription(j.payload);
          appendDebug('leader set remote answer');
          return;
        } else {
          if (tries < 20) setTimeout(pollAnswer, 500);
        }
      } catch (e) {
        if (tries < 20) setTimeout(pollAnswer, 500);
      }
    };
    pollAnswer();
  }

  async function joinLeaderWebRTC(label){
    const q = `?type=offer&label=${encodeURIComponent(label)}`;
    const r = await fetch(API_SIGNAL + q);
    if (!r.ok) throw new Error('fetch offer failed: ' + r.status);
    const j = await r.json();
    if (!j.payload) throw new Error('no offer found');

    pc = new RTCPeerConnection();
    pc.ondatachannel = ev => {
      dc = ev.channel;
      dc.onopen = ()=> {
        appendDebug('follower DC open');
        startDCPingPong();
      };
      dc.onmessage = ev => handleLeaderDCMessage(ev.data);
    };
    await pc.setRemoteDescription(j.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const r2 = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'answer', label, payload: answer }) });
    if (!r2.ok) throw new Error('post answer failed: ' + r2.status);
    appendDebug('follower posted answer');
  }

  function handleLeaderDCMessage(raw){
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'beat') {
        // follower receives scheduled beat
        const serverMs = Number(msg.serverScheduledMs);
        const localPlayMs = serverMs - offsetMs;
        const audioWhen = audioTimeFromLocalEpoch(localPlayMs);
        const isAccent = (msg.beatsPerMeasure > 0) ? (msg.beatIndex % msg.beatsPerMeasure === 0) : true;
        // debug
        const now = Date.now();
        const delay = localPlayMs - now;
        appendDebug(`follower recv beat bn=${msg.beatNumber} serverMs=${serverMs} localPlayMs=${localPlayMs} delay=${delay.toFixed(1)}`);
        // schedule if not duplicate
        if (!scheduledBeats.has(msg.beatNumber)) {
          scheduleClick(audioWhen, isAccent && soundEnabled);
          const playDelay = Math.max(0, localPlayMs - Date.now());
          setTimeout(()=> updateVisual(msg.beatIndex), playDelay);
          scheduledBeats.add(msg.beatNumber);
        }
        dbgBeat.textContent = String(msg.beatIndex);
        // leaderOffsetMs info (for refinement) will be used by dc_pong handler
      } else if (msg.type === 'dc_pong') {
        // follower ping-pong reply
        const t1 = msg.t1;
        const t2 = msg.t2;
        const t3 = msg.t3;
        const leaderOff = typeof msg.leaderOffsetMs === 'number' ? msg.leaderOffsetMs : null;
        const t4 = Date.now();
        const offsetPeer = ((t2 - t1) + (t3 - t4)) / 2;
        const rtt = (t4 - t1) - (t3 - t2);
        appendDebug(`dc_pong offsetPeer=${offsetPeer.toFixed(1)} rtt=${rtt.toFixed(1)} leaderOff=${leaderOff}`);
        if (leaderOff !== null) {
          const refined = Math.round(leaderOff + offsetPeer);
          const alpha = 0.35;
          offsetMs = Math.round((1 - alpha) * offsetMs + alpha * refined);
          dbgOffset.textContent = offsetMs.toFixed(1);
          dbgDelay.textContent = rtt.toFixed(1);
        } else {
          // fallback smoothing if leaderOff missing
          const alpha = 0.2;
          offsetMs = Math.round((1 - alpha) * offsetMs + alpha * (offsetMs + offsetPeer));
          dbgOffset.textContent = offsetMs.toFixed(1);
        }
      } else {
        appendDebug('follower DC other: ' + JSON.stringify(msg).slice(0,200));
      }
    } catch (e) { console.warn('handleLeaderDCMessage err', e); }
  }

  // follower dc ping
  function startDCPingPong(){
    if (!dc || dc.readyState !== 'open') return;
    stopDCPingPong();
    dcPingInterval = setInterval(()=> {
      try {
        const t1 = Date.now();
        dc.send(JSON.stringify({ type:'dc_ping', t1 }));
      } catch (e) { console.warn('dc ping fail', e); }
    }, 2000);
  }
  function stopDCPingPong(){ if (dcPingInterval) { clearInterval(dcPingInterval); dcPingInterval = null; } }

  // -------- Buttons ----------
  startLocalBtn.addEventListener('click', () => {
    isLeader = false;
    bpm = Number(bpmRange.value); beatsPerMeasure = Number(beatsPerMeasureSel.value);
    noteInterval = 60 / bpm;
    const localStart = Date.now() + 50;
    startSchedulerAtLocalStart(localStart);
    appendDebug('local start pressed');
  });

  stopLocalBtn.addEventListener('click', () => { stopScheduler(); stopDCPingPong(); appendDebug('local stop pressed'); });

  startLeaderBtn.addEventListener('click', async () => {
    try {
      await timesyncMulti(12);
      leaderOffsetMs = offsetMs; // leader's offset to server baseline
      const leader = await createLeaderOnServer();
      currentLeader = leader;
      isLeader = true;

      // apply leader settings to UI
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();

      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = String(leader.startTime);
      startSchedulerAtLocalStart(localStart);

      await setupLeaderWebRTC(leader.label);
      setTimeout(refreshLeaderList, 400);
      appendDebug('startLeader done');
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
      await timesyncMulti(12); // follower baseline offsetMs
      const r = await fetch(API_LEADERS + '?label=' + encodeURIComponent(label));
      if (!r.ok) throw new Error('fetch leader failed: ' + r.status);
      const leader = await r.json();
      currentLeader = leader;

      // Apply leader settings BEFORE computing local start (important fix)
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();

      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = String(leader.startTime);

      // start scheduler aligned => this ensures follower uses same beat numbering
      startSchedulerAtLocalStart(localStart);

      // join WebRTC & start ping/pong
      await joinLeaderWebRTC(leader.label);
      appendDebug(`joined leader ${label}`);
    } catch (e) {
      console.error('join failed', e);
      alert('Join failed: ' + (e && e.message));
    }
  });

  // ---------- helpers ----------
  async function refreshLeaderList(){
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { leaderSelect.innerHTML = '<option value="">(error)</option>'; return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) { leaderSelect.innerHTML = '<option value="">(no leaders)</option>'; return; }
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refresh leaders err', e);
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
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('create leader failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    appendDebug(`server created leader ${leader.label} start=${leader.startTime}`);
    return leader;
  }

  // compute local epoch ms from server startTime
  function computeLocalStartFromLeader(serverStartMs){
    return Number(serverStartMs) - Number(offsetMs);
  }

  // audioTime from local epoch
  function audioTimeFromLocalEpoch(localEpochMs){
    ensureAudio();
    const nowLocal = Date.now();
    const dt = (localEpochMs - nowLocal) / 1000.0;
    return audioCtx.currentTime + dt;
  }

  // expose debug helper
  window._metronome = { timesyncMulti };

  // init
  function init(){
    bpm = Number(bpmRange.value);
    beatsPerMeasure = Number(beatsPerMeasureSel.value);
    soundEnabled = soundToggle.checked;
    noteInterval = 60 / bpm;
    renderSegments();
    updateVisual(0);
    refreshLeaderList();
    setInterval(refreshLeaderList, 5000);

    bpmRange.addEventListener('input', ()=> {
      bpm = Number(bpmRange.value);
      bpmVal.textContent = String(bpm);
      if (isPlaying) resetSchedulerForBPMChange();
    });
    beatsPerMeasureSel.addEventListener('change', () => {
      beatsPerMeasure = Number(beatsPerMeasureSel.value);
      renderSegments();
      updateVisual(0);
    });
    soundToggle.addEventListener('change', ()=> soundEnabled = soundToggle.checked);
    appendDebug('UI initialized');
  }

  init();
})();
