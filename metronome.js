// metronome.js - full front-end logic
(() => {
  // API endpoints
  const API_LEADERS = '/api/leaders';
  const API_TIMESYNC = '/api/timesync';
  const API_SIGNAL = '/api/signal';

  // DOM
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

  const circle = document.getElementById('circle');
  const dbgLocal = document.getElementById('dbgLocal');
  const dbgOffset = document.getElementById('dbgOffset');
  const dbgDelay = document.getElementById('dbgDelay');
  const dbgLeaderStart = document.getElementById('dbgLeaderStart');
  const dbgBeat = document.getElementById('dbgBeat');

  // state
  let audioCtx = null;
  let playingTimer = null; // interval id
  let beatIndex = 0;
  let bpm = Number(bpmRange.value || 120);
  let beatsPerMeasure = Number(beatsPerMeasureInput.value || 0);
  let soundEnabled = soundToggle.checked;
  let isLeader = false;
  let currentLeader = null; // leader object from server
  let offsetMs = 0; // server - local (ms) computed by timesync
  let medianDelay = 0;

  // WebRTC pieces
  let pc = null;
  let dc = null;
  let leaderLabel = null;

  // utility: random Beat-XXXX
  function randLabel() {
    const s = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    return 'Beat-' + s.slice(0,4);
  }

  // init label on load
  leaderLabelInput.value = randLabel();

  // UI bindings
  bpmRange.addEventListener('input', (e) => {
    bpm = Number(e.target.value);
    bpmVal.textContent = bpm;
    // if playing, immediately restart scheduler so interval applies
    if (playingTimer) startLocalScheduler(currentLeader ? computeLocalStartFromLeader(currentLeader.startTime) : null, true);
  });
  bpmVal.textContent = bpm;

  beatsPerMeasureInput.addEventListener('input', (e) => {
    beatsPerMeasure = Math.max(0, Number(e.target.value));
    beatIndex = 0;
  });

  soundToggle.addEventListener('change', (e) => { soundEnabled = e.target.checked; });

  startLocalBtn.addEventListener('click', () => {
    isLeader = false;
    startLocalScheduler(null);
  });
  stopLocalBtn.addEventListener('click', () => stopLocalScheduler());

  // play click via WebAudio (short burst)
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  function playClick(isAccent, atTime = 0) {
    if (!soundEnabled) return;
    try {
      ensureAudio();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = isAccent ? 1000 : 700;
      g.gain.setValueAtTime(0.0001, audioCtx.currentTime + atTime);
      g.gain.linearRampToValueAtTime(0.8, audioCtx.currentTime + atTime + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + atTime + 0.12);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(audioCtx.currentTime + atTime);
      o.stop(audioCtx.currentTime + atTime + 0.13);
    } catch (e) {
      console.warn('playClick err', e);
    }
  }

  // visual flash for beat; accent uses scale+border for colorblind accessibility
  function flashVisual(isAccent) {
    if (isAccent) {
      circle.style.transform = 'scale(1.18)';
      circle.style.border = '6px solid #333';
      circle.style.background = '#ffd54f'; // accent color
      setTimeout(()=> {
        circle.style.transform='scale(1)';
        circle.style.border='none';
        circle.style.background='';
      }, 140);
    } else {
      circle.style.transform='scale(1.06)';
      circle.style.background = '#81d4fa';
      setTimeout(()=> {
        circle.style.transform='scale(1)';
        circle.style.background='';
      }, 120);
    }
  }

  // scheduling: we use setInterval for beat tick but use audioCtx to play for better precision
  function startLocalScheduler(leaderLocalStart = null, restart=false) {
    // leaderLocalStart: a local epoch ms at which the leader's scheduled start occurs (if provided),
    //                    if null -> start immediately.
    stopLocalScheduler();

    beatIndex = 0;
    const intervalMs = 60000 / bpm;

    // if leaderLocalStart provided and in the future, wait until that moment; if in past, compute offset
    if (leaderLocalStart) {
      const now = Date.now();
      const delta = leaderLocalStart - now;
      if (delta > 50) {
        // schedule to begin at that local time
        setTimeout(()=> {
          runInterval(intervalMs);
        }, delta);
        return;
      } else {
        // already started on leader: compute how many beats elapsed and schedule next accordingly
        const elapsed = now - leaderLocalStart;
        const beatsSince = Math.floor(elapsed / intervalMs);
        beatIndex = beatsSince + 1;
        const nextDelay = intervalMs - (elapsed % intervalMs);
        setTimeout(()=> runInterval(intervalMs), Math.max(0, nextDelay));
        return;
      }
    }

    // otherwise start immediate
    runInterval(intervalMs);
  }

  function runInterval(intervalMs) {
    // first immediate beat
    doBeat();
    // then periodic
    playingTimer = setInterval(() => {
      doBeat();
    }, intervalMs);
  }

  function stopLocalScheduler() {
    if (playingTimer) {
      clearInterval(playingTimer);
      playingTimer = null;
    }
    beatIndex = 0;
    dbgBeat.textContent = '-';
  }

  function doBeat() {
    const isAccent = (beatsPerMeasure > 0) ? (beatIndex % beatsPerMeasure === 0) : false;
    // play sound using audioCtx (start immediately)
    playClick(isAccent, 0);
    // flash visual
    flashVisual(isAccent);
    dbgBeat.textContent = String(beatIndex);
    // if leader, broadcast beat message over DataChannel (include server timestamp)
    if (isLeader && dc && dc.readyState === 'open' && currentLeader) {
      // compute server timestamp: leaderLocal + offsetMs (server - local) => serverTime = Date.now() + offsetMs
      const serverTs = Date.now() + offsetMs;
      const msg = { type: 'beat', beatIndex: beatIndex, bpm, beatsPerMeasure, serverTs };
      try { dc.send(JSON.stringify(msg)); } catch(e){ console.warn('dc send err', e); }
    }
    beatIndex++;
  }

  // --------- timesync multi-sample (NTP-style) ---------
  // returns { offset, delay, samples[] } where offset = medianOffset (ms)
  async function timesyncMulti(samples = 12, endpoint = API_TIMESYNC) {
    const results = [];
    for (let i=0;i<samples;i++) {
      const T1 = Date.now();
      let resp;
      try {
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ clientTime: T1 })
        });
        const T4 = Date.now();
        if (!r.ok) {
          const txt = await r.text();
          console.warn('timesync sample failed:', r.status, txt);
          await new Promise(r=>setTimeout(r,50));
          continue;
        }
        resp = await r.json(); // { t1, t2, t3, rtt, medianRTT }
        const T2 = resp.t2;
        const T3 = resp.t3;
        const offset = ((T2 - T1) + (T3 - T4)) / 2; // server - local
        const delay = (T4 - T1) - (T3 - T2);
        results.push({ offset, delay, T1, T2, T3, T4 });
      } catch (e) {
        console.warn('timesync sample exception', e);
      }
      // small sleep
      await new Promise(r=>setTimeout(r, 30 + Math.random()*40));
    }

    if (results.length === 0) throw new Error('timesync: no samples');

    // sort by delay and take best half
    results.sort((a,b)=>a.delay - b.delay);
    const keep = results.slice(0, Math.max(3, Math.floor(results.length/2)));
    const offsets = keep.map(r=>r.offset).sort((a,b)=>a-b);
    const delays = keep.map(r=>r.delay).sort((a,b)=>a-b);
    const medianOffset = offsets[Math.floor(offsets.length/2)];
    const medianDelay = delays[Math.floor(delays.length/2)];
    // update debug
    dbgLocal.textContent = String(Date.now());
    dbgOffset.textContent = medianOffset.toFixed(1);
    dbgDelay.textContent = medianDelay.toFixed(1);

    // set global offsetMs
    offsetMs = Math.round(medianOffset);
    medianDelay = medianDelay;
    return { offset: offsetMs, delay: medianDelay, samples: results };
  }

  // compute local epoch ms that corresponds to leader.startTime (server epoch ms)
  function computeLocalStartFromLeader(leaderStartServerMs) {
    // serverTime = local + offsetMs -> local = server - offsetMs
    return Number(leaderStartServerMs) - Number(offsetMs);
  }

  // --------- Leader creation / list / update ----------
  async function refreshLeaderList() {
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) {
        console.warn('leader list fetch failed', r.status);
        leaderSelect.innerHTML = '<option value="">(error)</option>';
        return;
      }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        leaderSelect.innerHTML = '<option value="">(no leaders)</option>';
        return;
      }
      // populate select with label and id stored in value
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refreshLeaderList err', e);
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
    const r = await fetch(API_LEADERS, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('leader create failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    currentLeader = leader;
    leaderLabel = leader.label;
    console.log('created leader', leader);
    dbgLeaderStart.textContent = leader.startTime;
    return leader;
  }

  // --------- WebRTC signaling logic ----------
  async function setupLeaderWebRTC(label) {
    pc = new RTCPeerConnection();
    dc = pc.createDataChannel('beatSync');
    dc.onopen = ()=>console.log('dc open (leader)');
    dc.onclose = ()=>console.log('dc closed (leader)');
    dc.onmessage = e=>console.log('leader dc recv:', e.data);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        // we don't send ICE via server in this simple demo; browsers will try ICE trickle but peers may still connect
        console.log('leader ICE candidate', e.candidate);
      }
    };
    // create offer and store on server
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // POST offer to signaling server
    const r = await fetch(API_SIGNAL, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ type:'offer', label, payload: offer }) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('signal offer post failed: ' + r.status + ' ' + txt);
    }
    // poll for answer
    let attempts = 0;
    const pollAnswer = async () => {
      attempts++;
      const q = `?type=answer&label=${encodeURIComponent(label)}`;
      const resp = await fetch(API_SIGNAL + q);
      if (!resp.ok) { if (attempts < 20) return setTimeout(pollAnswer, 500); else throw new Error('poll answer failed'); }
      const json = await resp.json();
      if (json.payload) {
        await pc.setRemoteDescription(json.payload);
        console.log('leader got answer and set remote desc');
        return;
      } else {
        if (attempts < 20) setTimeout(pollAnswer, 500); else console.warn('no answer received');
      }
    };
    pollAnswer();
  }

  async function joinLeaderWebRTC(label) {
    // fetch offer from server
    const q = `?type=offer&label=${encodeURIComponent(label)}`;
    const r = await fetch(API_SIGNAL + q);
    if (!r.ok) throw new Error('fetch offer failed: ' + r.status);
    const json = await r.json();
    if (!json.payload) throw new Error('no offer found for label ' + label);
    pc = new RTCPeerConnection();
    pc.ondatachannel = (ev) => {
      dc = ev.channel;
      dc.onopen = ()=>console.log('dc open (follower)');
      dc.onmessage = handleLeaderMessageFromDC;
    };
    await pc.setRemoteDescription(json.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // POST answer
    const r2 = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'answer', label, payload: answer }) });
    if (!r2.ok) {
      const txt = await r2.text();
      throw new Error('post answer failed: ' + r2.status + ' ' + txt);
    }
    console.log('follower posted answer');
  }

  // when follower receives beat msg via DC
  function handleLeaderMessageFromDC(ev) {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'beat') {
        // msg.serverTs is server timestamp when leader played (we use serverTs)
        const serverTs = msg.serverTs || msg.serverTs === 0 ? msg.serverTs : (Date.now() + offsetMs);
        // follower should compute local time to play = serverTs - offsetMs (server - local)
        // BUT here we have per-client offsetMs computed earlier
        const localPlay = serverTs - offsetMs;
        const delay = localPlay - Date.now();
        if (delay <= 20) {
          // already should play
          doImmediateBeatFromMsg(msg);
        } else {
          setTimeout(()=> doImmediateBeatFromMsg(msg), delay);
        }
      }
    } catch (e) {
      console.warn('handleLeaderMessageFromDC err', e);
    }
  }

  function doImmediateBeatFromMsg(msg) {
    const isAccent = (msg.beatsPerMeasure>0) ? (msg.beatIndex % msg.beatsPerMeasure === 0) : false;
    playClick(isAccent, 0);
    flashVisual(isAccent);
    // update debug beat index
    dbgBeat.textContent = String(msg.beatIndex);
  }

  function flashVisual(isAccent) {
    if (isAccent) {
      circle.style.transform = 'scale(1.18)';
      circle.style.border = '5px solid #222';
      circle.style.background = '#ffd740';
      setTimeout(()=> {
        circle.style.transform='scale(1)'; circle.style.border='none'; circle.style.background=''; 
      }, 140);
    } else {
      circle.style.transform = 'scale(1.06)';
      circle.style.background = '#81d4fa';
      setTimeout(()=> { circle.style.transform='scale(1)'; circle.style.background=''; }, 120);
    }
  }

  // --------- Button handlers for Leader / Join ----------
  startLeaderBtn.addEventListener('click', async () => {
    try {
      // compute timesync (multi-sample) to determine offset relative to server
      await timesyncMultiAndApply();
      // create leader on server
      const leader = await createLeaderOnServer();
      currentLeader = leader;
      isLeader = true;
      leaderLabel = leader.label;
      // use leader.startTime to schedule local start
      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = leader.startTime;
      // start local scheduler aligned (will begin when leader.startTime arrives)
      startLocalScheduler(localStart);
      // setup WebRTC and publish offer
      await setupLeaderWebRTC(leader.label);
      // refresh leader list
      setTimeout(refreshLeaderList, 500);
    } catch (e) {
      console.error('startLeader err', e);
      alert('Start leader failed: ' + (e && e.message));
    }
  });

  joinLeaderBtn.addEventListener('click', async () => {
    const sel = leaderSelect.value;
    if (!sel) return alert('請先選擇一個 Leader');
    const label = decodeURIComponent(sel);
    try {
      // timesync multi-sample for offset
      await timesyncMultiAndApply();
      // fetch leader detail
      const res = await fetch(API_LEADERS + '?label=' + encodeURIComponent(label));
      if (!res.ok) { alert('fetch leader failed'); return; }
      const leader = await res.json();
      currentLeader = leader;
      // compute local start time
      const localStart = computeLocalStartFromLeader(leader.startTime);
      dbgLeaderStart.textContent = leader.startTime;
      // start local scheduler aligned
      startLocalScheduler(localStart);
      // join webrtc and start listening for DC beat messages
      await joinLeaderWebRTC(leader.label);
    } catch (e) {
      console.error('join err', e);
      alert('Join failed: ' + (e && e.message));
    }
  });

  async function createLeaderOnServer() {
    const payload = {
      label: (leaderLabelInput.value || '').trim() || randLabel(),
      bpm: Number(bpmRange.value),
      beatsPerMeasure: Number(beatsPerMeasureInput.value),
      allowChangesByOthers: !!allowChangesInput.checked,
      startTime: Date.now() + 1500
    };
    const r = await fetch(API_LEADERS, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('create leader failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    return leader;
  }

  // timesync wrapper to call multi-sample and apply results
  async function timesyncMultiAndApply() {
    try {
      const res = await timesyncMulti(12);
      // res.offset stored in offsetMs by timesyncMulti
      // set global offsetMs already
      // assign dbg fields already inside timesyncMulti
      return res;
    } catch (e) {
      console.warn('timesyncMulti failed', e);
      throw e;
    }
  }

  // --------- helper: refresh leader list periodically ----------
  async function refreshLeaderList() {
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { console.warn('leader list fetch failed'); return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) {
        leaderSelect.innerHTML = '<option value="">(no leaders)</option>';
        return;
      }
      leaderSelect.innerHTML = arr.map(l => `<option value="${encodeURIComponent(l.label)}">${l.label} — BPM:${l.bpm} / beats:${l.beatsPerMeasure}</option>`).join('');
    } catch (e) {
      console.warn('refreshLeaderList err', e);
    }
  }

  // --------- initial load ----------
  // populate label and leader list
  leaderLabelInput.value = randLabel();
  refreshLeaderList();
  setInterval(refreshLeaderList, 5000);

  // Expose minimal globals for debugging
  window._metronome = {
    timesyncMultiAndApply,
    computeLocalStartFromLeader
  };
})();
