// metronome.js
// Hybrid: Audio Broadcast + Local Clock-Sync fallback
// Features:
// - WebAudio precise multi-beat scheduling (schedule-ahead buffer)
// - Timesync (NTP-like multi-sample median smoothing)
// - WebRTC: audio track (leader -> followers) + DataChannel beat messages
// - dc ping/pong for continuous offset refinement
// - Fallback: when audio stream lost, local scheduler unmutes and continues
// - Rich debug visible in #debugLog and console.table
(() => {
  // ----- CONFIG -----
  const API_LEADERS = '/api/leaders';
  const API_TIMESYNC = '/api/timesync';
  const API_SIGNAL = '/api/signal'; // signaling endpoint for offer/answer polling
  const SAMPLES_TIMESYNC = 16; // how many timesync samples to take at start
  const TIMESYNC_SAMPLE_INTERVAL_MS = 40;
  const SCHEDULE_AHEAD_DEFAULT = 1.2; // seconds
  const SCHEDULER_LOOKAHEAD_MS = 25; // scheduler tick interval
  const DC_PING_INTERVAL_MS = 2000; // ping/pong interval
  const AUDIO_FALLBACK_MS = 800; // if audio stream missing longer than this -> fallback to local
  const AUDIO_RECOVER_MS = 400; // when audio resumes, wait this long to prefer audio again

  // ----- DOM -----
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

  // ----- STATE -----
  let audioCtx = null;
  let schedulerTimer = null;
  let nextNoteTime = 0;        // audioCtx time for next scheduled note
  let noteInterval = 60 / 120; // seconds per beat (init)
  let scheduleAheadTime = SCHEDULE_AHEAD_DEFAULT;
  let lookahead = SCHEDULER_LOOKAHEAD_MS;
  let nextBeatNumber = 0;      // absolute index of next beat to schedule
  let lastPlayedBeatNumber = -1;
  let scheduledBeats = new Set();
  let bpm = Number((bpmRange && bpmRange.value) || 120);
  let beatsPerMeasure = Number((beatsPerMeasureSel && beatsPerMeasureSel.value) || 4);
  let soundEnabled = soundToggle ? soundToggle.checked : true;
  let isPlaying = false;
  let isLeader = false;
  let currentLeader = null; // object from server
  let offsetMs = 0; // server - local (ms)
  let medianDelay = 0;
  let leaderOffsetMs = 0; // leader's measured offset (server - leader_local)

  // WebRTC
  let pc = null;
  let dc = null;
  let localStreamForLeader = null; // MediaStream (leader's generated click track)
  let incomingAudioEl = null; // audio element for follower to play incoming stream
  let lastAudioPacketMs = 0; // last time we heard audio packet -> for fallback detection
  let audioFallbackActive = false;
  let audioRecoverTimer = null;

  // DC ping
  let dcPingInterval = null;

  // debug storage
  const debugLines = [];
  function appendDebug(line) {
    const t = new Date().toISOString().slice(11,23) + ' ' + line;
    debugLines.push(t);
    if (debugLines.length > 600) debugLines.shift();
    if (debugLogEl) debugLogEl.innerText = debugLines.slice().reverse().join('\n');
    console.log(t);
  }

  // table buffer for copy/paste
  const tableBuffer = [];
  function pushTableRow(row) {
    tableBuffer.push(row);
    if (tableBuffer.length > 400) tableBuffer.shift();
    // show compact text line too
    appendDebug(JSON.stringify(row));
    try { console.table([row]); } catch(e){}
  }

  // generate random label default
  function randLabel() {
    const s = Math.random().toString(36).slice(2).toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
    return 'Beat-' + s.slice(0,4);
  }
  if (leaderLabelInput && !leaderLabelInput.value) leaderLabelInput.value = randLabel();

  // ----- AUDIO HELPERS -----
  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  // create a short click buffer and return MediaStreamTrack for leader broadcast
  function createClickStreamForLeader() {
    // We'll create a MediaStreamDestination and schedule short clicks into it.
    ensureAudioCtx();
    const dest = audioCtx.createMediaStreamDestination();
    // We'll generate clicks live when scheduler schedules; but to give a track immediately we need dest.stream
    return dest.stream;
  }

  function scheduleClickAtAudioTime(audioTime, isAccent) {
    ensureAudioCtx();
    if (!soundEnabled && (!isLeader || !audioFallbackActive)) return; // if soundDisabled and not fallback
    try {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = isAccent ? 1400 : 900;
      // envelope
      g.gain.setValueAtTime(0.0001, audioTime);
      g.gain.linearRampToValueAtTime(0.8, audioTime + 0.001);
      g.gain.exponentialRampToValueAtTime(0.001, audioTime + 0.09);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(audioTime);
      o.stop(audioTime + 0.10);
    } catch (e) {
      console.warn('scheduleClickAtAudioTime error', e);
      appendDebug('scheduleClickAtAudioTime error: ' + (e && e.message));
    }
  }

  // ----- VISUAL -----
  function renderSegments() {
    if (!beatVisual) return;
    beatVisual.innerHTML = '';
    if (beatsPerMeasure > 0) {
      for (let i=0;i<beatsPerMeasure;i++){
        const seg = document.createElement('div');
        seg.className = 'segment';
        seg.dataset.index = String(i);
        seg.style.flexBasis = `${100 / beatsPerMeasure}%`;
        seg.style.transition = 'background 120ms ease';
        beatVisual.appendChild(seg);
      }
    } else {
      const seg = document.createElement('div');
      seg.className = 'segment flash';
      seg.style.flexBasis = '100%';
      seg.style.transition = 'background 150ms ease';
      seg.style.background = '#000';
      beatVisual.appendChild(seg);
    }
  }

  function updateVisual(beatIdx) {
    if (!beatVisual) return;
    const segs = Array.from(beatVisual.children);
    if (beatsPerMeasure > 0) {
      segs.forEach((s, idx) => {
        if (idx === (beatIdx % beatsPerMeasure)) {
          s.style.background = '#ffb545'; // accent
        } else {
          s.style.background = '#e6e6e6';
        }
      });
    } else {
      const seg = segs[0];
      if (!seg) return;
      // toggling high-contrast
      seg.style.background = seg.style.background === '#000' ? '#fff' : '#000';
    }
  }

  // ----- Time conversions -----
  function audioTimeFromLocalEpochMs(localEpochMs) {
    ensureAudioCtx();
    const nowLocal = Date.now();
    const dt = (localEpochMs - nowLocal) / 1000.0;
    return audioCtx.currentTime + dt;
  }

  // ----- Scheduler (multi-beat pre-scheduling) -----
  function schedulerTick() {
    if (!audioCtx) return;
    while (nextNoteTime < audioCtx.currentTime + scheduleAheadTime) {
      const bn = nextBeatNumber;
      if (!scheduledBeats.has(bn)) {
        // compute local epoch ms for this note
        const localPlayMs = Date.now() + Math.round((nextNoteTime - audioCtx.currentTime) * 1000);
        const isAccent = (beatsPerMeasure > 0) ? (bn % beatsPerMeasure === 0) : true;

        // schedule local audio (this is the local click; may be muted while incoming audio stream plays)
        if (!audioFallbackActive) {
          // if audio stream active and follower, we may keep local silent to avoid double click
          // but still schedule so fallback is seamless when audio lost
        }
        scheduleClickAtAudioTime(nextNoteTime, isAccent);

        // update visual at play time
        const delayMs = Math.max(0, localPlayMs - Date.now());
        setTimeout(()=> updateVisual(bn), delayMs);

        // leader will broadcast beat message including serverScheduledMs
        if (isLeader && dc && dc.readyState === 'open' && currentLeader) {
          // leaderScheduledServerMs = localPlayMs + leaderOffsetMs (server = leader_local + leaderOffset)
          const serverScheduledMs = Math.round(localPlayMs + (leaderOffsetMs || 0));
          const msg = {
            type: 'beat',
            beatNumber: bn,
            beatIndex: bn,
            beatsPerMeasure,
            bpm,
            serverScheduledMs,
            leaderOffsetMs: leaderOffsetMs || 0
          };
          try {
            dc.send(JSON.stringify(msg));
            appendDebug(`leader dc.send beat bn=${bn} serverMs=${serverScheduledMs}`);
            pushTableRow({
              kind: 'leader_send',
              bn,
              serverMs: serverScheduledMs,
              localMs: localPlayMs,
              now: Date.now(),
              diff: Date.now() - localPlayMs
            });
          } catch (e) {
            appendDebug('leader dc.send err: ' + (e && e.message));
            console.warn('leader dc send err', e);
          }
        }

        scheduledBeats.add(bn);
      }
      // advance
      nextNoteTime += noteInterval;
      nextBeatNumber++;
    }
  }

  function startSchedulerAtLocalStart(localStartMs) {
    ensureAudioCtx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    noteInterval = 60 / bpm;
    scheduledBeats.clear();

    const nowLocal = Date.now();

    if (currentLeader && currentLeader.startTime) {
      // follower path: align to server baseline
      try {
        const serverStart = Number(currentLeader.startTime);
        const nowServer = Date.now() + Number(offsetMs); // server = local + offset
        if (nowServer < serverStart) {
          // future start
          const nextLocalMs = serverStart - offsetMs;
          nextNoteTime = audioTimeFromLocalEpochMs(nextLocalMs);
          nextBeatNumber = 0;
          lastPlayedBeatNumber = -1;
          appendDebug(`scheduled future leader start: serverStart=${serverStart} nowServer=${nowServer} nextLocalMs=${Math.round(nextLocalMs)}`);
          pushTableRow({ kind:'follower_start_future', serverStart, nextLocalMs, now: Date.now() });
        } else {
          // already started -> compute beatsSince using server timeline (avoid local drift)
          const beatsSince = Math.floor((nowServer - serverStart) / (noteInterval * 1000));
          lastPlayedBeatNumber = beatsSince;
          updateVisual(lastPlayedBeatNumber);
          const nextServerMs = serverStart + (beatsSince + 1) * noteInterval * 1000;
          const nextLocalMs = nextServerMs - offsetMs;
          nextNoteTime = audioTimeFromLocalEpochMs(nextLocalMs);
          nextBeatNumber = beatsSince + 1;
          appendDebug(`start aligned (follower): nowServer=${nowServer} serverStart=${serverStart} beatsSince=${beatsSince} nextServerMs=${Math.round(nextServerMs)} nextLocalMs=${Math.round(nextLocalMs)}`);
          pushTableRow({ kind:'follower_start_aligned', serverStart, nextServerMs, nextLocalMs, beatsSince });
        }
      } catch (e) {
        appendDebug('startSchedulerAtLocalStart follower error: ' + (e && e.message));
        // fallback to local start
        if (localStartMs && localStartMs > nowLocal) {
          nextNoteTime = audioTimeFromLocalEpochMs(localStartMs);
          nextBeatNumber = 0;
          lastPlayedBeatNumber = -1;
        } else if (localStartMs) {
          const elapsed = nowLocal - localStartMs;
          const beatsSince = Math.floor(elapsed / (noteInterval*1000));
          lastPlayedBeatNumber = beatsSince;
          updateVisual(lastPlayedBeatNumber);
          nextBeatNumber = beatsSince + 1;
          const nextLocalMs = localStartMs + (beatsSince + 1) * noteInterval * 1000;
          nextNoteTime = audioTimeFromLocalEpochMs(nextLocalMs);
        } else {
          nextNoteTime = audioCtx.currentTime + 0.05;
          nextBeatNumber = 0;
          lastPlayedBeatNumber = -1;
        }
      }
    } else {
      // local-only behavior (leader or standalone)
      if (!localStartMs || localStartMs <= nowLocal) {
        if (localStartMs) {
          const elapsed = nowLocal - localStartMs;
          const beatsSince = Math.floor(elapsed / (noteInterval*1000));
          lastPlayedBeatNumber = beatsSince;
          updateVisual(lastPlayedBeatNumber);
          nextBeatNumber = beatsSince + 1;
          const nextLocalMs = localStartMs + (beatsSince + 1) * noteInterval * 1000;
          nextNoteTime = audioTimeFromLocalEpochMs(nextLocalMs);
          appendDebug(`start aligned local: nowLocal=${nowLocal} localStart=${localStartMs} beatsSince=${beatsSince} nextLocalMs=${Math.round(nextLocalMs)}`);
          pushTableRow({ kind:'local_start_aligned', localStartMs, nextLocalMs, beatsSince });
        } else {
          nextNoteTime = audioCtx.currentTime + 0.05;
          nextBeatNumber = 0;
          lastPlayedBeatNumber = -1;
          appendDebug('start immediate local (no leader)');
          pushTableRow({ kind:'local_start_immediate', now: Date.now() });
        }
      } else {
        nextNoteTime = audioTimeFromLocalEpochMs(localStartMs);
        nextBeatNumber = 0;
        lastPlayedBeatNumber = -1;
        appendDebug(`scheduled future start at localStart=${localStartMs}`);
      }
    }

    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(schedulerTick, lookahead);
    isPlaying = true;
  }

  function stopScheduler() {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
    isPlaying = false;
    nextBeatNumber = 0;
    lastPlayedBeatNumber = -1;
    scheduledBeats.clear();
    if (dbgBeat) dbgBeat.textContent = '-';
    renderSegments();
    appendDebug('stopped scheduler');
  }

  function resetSchedulerForBpmChange() {
    noteInterval = 60 / bpm;
    ensureAudioCtx();
    nextNoteTime = audioCtx.currentTime + 0.05;
    appendDebug(`BPM changed -> noteInterval=${noteInterval}`);
  }

  // ----- timesync (NTP-like multi-sample) -----
  async function timesyncMulti(samples = SAMPLES_TIMESYNC) {
    const results = [];
    for (let i=0;i<samples;i++){
      const T1 = Date.now();
      try {
        const r = await fetch(API_TIMESYNC, {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ clientTime: T1 })
        });
        const T4 = Date.now();
        if (!r.ok) {
          const txt = await r.text();
          appendDebug(`timesync sample failed ${r.status} ${txt}`);
          await new Promise(r => setTimeout(r, TIMESYNC_SAMPLE_INTERVAL_MS));
          continue;
        }
        const j = await r.json(); // expect { t1, t2, t3 } or { t1, t2, t3, rtt }
        // server-side we designed: return t2 (recv), t3 (send)
        const T2 = Number(j.t2);
        const T3 = Number(j.t3);
        const offset = ((T2 - T1) + (T3 - T4)) / 2;
        const delay = (T4 - T1) - (T3 - T2);
        results.push({ offset, delay, T1, T2, T3, T4 });
        appendDebug(`timesync sample ${i}: offset=${offset.toFixed(1)} delay=${delay.toFixed(1)}`);
        pushTableRow({ kind:'timesync_sample', i, offset, delay });
      } catch (e) {
        appendDebug('timesync sample exception: ' + (e && e.message));
      }
      await new Promise(r => setTimeout(r, TIMESYNC_SAMPLE_INTERVAL_MS + Math.random() * 40));
    }

    if (results.length === 0) throw new Error('timesync failed (no samples)');

    // sort by delay and keep lower half (less jitter)
    results.sort((a,b)=>a.delay - b.delay);
    const keep = results.slice(0, Math.max(3, Math.floor(results.length/2)));
    const offsets = keep.map(x=>x.offset).sort((a,b)=>a-b);
    const delays = keep.map(x=>x.delay).sort((a,b)=>a-b);
    const medianOffset = offsets[Math.floor(offsets.length/2)];
    const medianDelayVal = delays[Math.floor(delays.length/2)];

    offsetMs = Math.round(medianOffset);
    medianDelay = medianDelayVal;
    if (dbgLocal) dbgLocal.textContent = String(Date.now());
    if (dbgOffset) dbgOffset.textContent = offsetMs.toFixed(1);
    if (dbgDelay) dbgDelay.textContent = medianDelay.toFixed(1);
    appendDebug(`timesync done: offsetMs=${offsetMs} medianDelay=${medianDelay.toFixed(1)}`);
    pushTableRow({ kind:'timesync_done', offsetMs, medianDelay });
    return { offset: offsetMs, medianDelay };
  }

  // ----- Leader list & create -----
  async function refreshLeaderList() {
    try {
      const r = await fetch(API_LEADERS);
      if (!r.ok) { leaderSelect.innerHTML = '<option value="">(error)</option>'; return; }
      const arr = await r.json();
      if (!Array.isArray(arr) || arr.length === 0) { leaderSelect.innerHTML = '<option value="">(no leaders)</option>'; return; }
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
    const r = await fetch(API_LEADERS, { method:'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(payload) });
    if (!r.ok) {
      const txt = await r.text();
      throw new Error('createLeaderOnServer failed: ' + r.status + ' ' + txt);
    }
    const leader = await r.json();
    currentLeader = leader;
    if (dbgLeaderStart) dbgLeaderStart.textContent = String(leader.startTime);
    appendDebug(`server created leader ${leader.label} start=${leader.startTime}`);
    pushTableRow({ kind:'server_created_leader', label: leader.label, start: leader.startTime });
    return leader;
  }

  // ----- WebRTC signaling & DataChannel + audio track -----
  // Utility: small sleep
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function setupLeaderWebRTC(label) {
    pc = new RTCPeerConnection();
    // create audio track (MediaStream) from an AudioContext destination so followers can hear leader's clicks
    ensureAudioCtx();
    const dest = audioCtx.createMediaStreamDestination();
    localStreamForLeader = dest.stream; // keep reference to stop later
    // Note: scheduleClick uses audioCtx.destination for local monitor; we also want a stream for followers.
    // We'll connect scheduled clicks also to dest: when scheduling, we can create oscillator -> dest as well as destination
    // For simplicity, when scheduling click we will also send a short buffer to dest via connecting osc->g->dest.
    // We'll add the track(s) to PeerConnection:
    const tracks = localStreamForLeader.getAudioTracks();
    for (const t of tracks) pc.addTrack(t, localStreamForLeader);

    dc = pc.createDataChannel('beatSync');
    dc.onopen = () => { appendDebug('leader DC open'); pushTableRow({ kind:'dc_open', role:'leader' }); };
    dc.onmessage = (ev) => {
      // handle ping
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'dc_ping') {
          // reply quickly
          const t2 = Date.now();
          const reply = { type: 'dc_pong', t1: msg.t1, t2, t3: Date.now(), leaderOffsetMs: leaderOffsetMs || 0 };
          try { dc.send(JSON.stringify(reply)); }
          catch(e) { appendDebug('leader dc_pong send failed: ' + (e && e.message)); }
        } else {
          appendDebug('leader DC rx: ' + JSON.stringify(msg).slice(0,200));
        }
      } catch (e) { appendDebug('leader DC message parse err: ' + (e && e.message)); }
    };
    pc.onicecandidate = e => { /* ICE candidates logged to console for diagnostics */ if (e.candidate) console.log('leader ice', e.candidate); };

    // create offer and POST to signaling server
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const body = { type:'offer', label, payload: offer };
    const r = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('signal POST offer failed: ' + r.status);
    appendDebug('leader offer posted to signaling server');
    // poll for answer (server stores answer when follower posts)
    let tries = 0;
    while (tries < 40) {
      tries++;
      try {
        const q = `?type=answer&label=${encodeURIComponent(label)}`;
        const rr = await fetch(API_SIGNAL + q);
        if (rr.ok) {
          const j = await rr.json();
          if (j && j.payload) {
            await pc.setRemoteDescription(j.payload);
            appendDebug('leader set remote answer');
            pushTableRow({ kind:'leader_set_remote_answer', tries });
            return;
          }
        }
      } catch (e) {
        // ignore and retry
      }
      await sleep(300);
    }
    throw new Error('polling for answer timed out');
  }

  async function joinLeaderWebRTC(label) {
    const q = `?type=offer&label=${encodeURIComponent(label)}`;
    const r = await fetch(API_SIGNAL + q);
    if (!r.ok) throw new Error('fetch offer failed: ' + r.status);
    const j = await r.json();
    if (!j.payload) throw new Error('no offer found for label ' + label);

    pc = new RTCPeerConnection();
    pc.ontrack = (ev) => {
      // follower receives leader's audio track here
      handleIncomingStream(ev.streams && ev.streams[0]);
    };
    pc.ondatachannel = ev => {
      dc = ev.channel;
      dc.onopen = () => {
        appendDebug('follower DC open');
        startDCPingPong();
      };
      dc.onmessage = (ev) => handleLeaderDCMessage(ev.data);
    };
    await pc.setRemoteDescription(j.payload);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    const r2 = await fetch(API_SIGNAL, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type:'answer', label, payload: answer }) });
    if (!r2.ok) throw new Error('post answer failed: ' + r2.status);
    appendDebug('follower posted answer');
  }

  function handleIncomingStream(stream) {
    if (!stream) return;
    // attach to an audio element for playback and monitoring
    if (!incomingAudioEl) {
      incomingAudioEl = document.createElement('audio');
      incomingAudioEl.autoplay = true;
      incomingAudioEl.muted = false; // follower hears it
      incomingAudioEl.playsInline = true;
      incomingAudioEl.style.display = 'none';
      document.body.appendChild(incomingAudioEl);

      // monitor playback to detect audio activity
      incomingAudioEl.addEventListener('playing', () => {
        lastAudioPacketMs = Date.now();
        appendDebug('incoming audio playing');
      });
      incomingAudioEl.addEventListener('pause', () => {
        appendDebug('incoming audio paused');
      });
      incomingAudioEl.addEventListener('ended', () => {
        appendDebug('incoming audio ended');
      });
    }
    try {
      incomingAudioEl.srcObject = stream;
      lastAudioPacketMs = Date.now();
      appendDebug('incoming stream attached');
      pushTableRow({ kind:'incoming_stream_attached', now: Date.now() });
      // When audio plays, prefer audio-stream over local clicks; schedule fallback detection
      // Start monitor
      startAudioMonitor();
    } catch (e) {
      appendDebug('handleIncomingStream err: ' + (e && e.message));
    }
  }

  // audio monitor: detect when audio stream stops and fallback
  let audioMonitorInterval = null;
  function startAudioMonitor() {
    stopAudioMonitor();
    audioMonitorInterval = setInterval(() => {
      const now = Date.now();
      // if we haven't heard audio for longer than threshold, trigger fallback
      if (now - lastAudioPacketMs > AUDIO_FALLBACK_MS) {
        if (!audioFallbackActive) {
          appendDebug('Audio stream missing -> enabling local fallback');
          pushTableRow({ kind:'audio_fallback_start', now });
          audioFallbackActive = true;
          // we should unmute local clicks (they were scheduled but maybe silent)
          // If scheduler already running and local clicks scheduled, they will play (unless we had logic to silence)
          // If scheduler not running, start it aligned to server start
          if (!isPlaying) {
            // align to leader if known
            if (currentLeader && currentLeader.startTime) {
              const localStart = computeLocalStartFromLeader(currentLeader.startTime);
              startSchedulerAtLocalStart(localStart);
            } else {
              startSchedulerAtLocalStart(Date.now() + 50);
            }
          }
        }
      } else {
        // audio stream present
        if (audioFallbackActive) {
          // we heard audio again recently -> schedule gentle switch back to audio-stream dominant
          if (audioRecoverTimer) clearTimeout(audioRecoverTimer);
          audioRecoverTimer = setTimeout(() => {
            audioFallbackActive = false;
            appendDebug('Audio stream recovered -> disable local fallback (prefer incoming audio)');
            pushTableRow({ kind:'audio_fallback_recover', now: Date.now() });
          }, AUDIO_RECOVER_MS);
        }
      }
    }, 120);
  }
  function stopAudioMonitor() {
    if (audioMonitorInterval) { clearInterval(audioMonitorInterval); audioMonitorInterval = null; }
    if (audioRecoverTimer) { clearTimeout(audioRecoverTimer); audioRecoverTimer = null; }
  }

  // ----- DataChannel handling (follower side) -----
  function handleLeaderDCMessage(raw) {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'beat') {
        // follower receives scheduled beat
        const serverMs = Number(msg.serverScheduledMs);
        const localPlayMs = serverMs - offsetMs;
        const audioWhen = audioTimeFromLocalEpochMs(localPlayMs);
        const isAccent = (msg.beatsPerMeasure > 0) ? (msg.beatIndex % msg.beatsPerMeasure === 0) : true;
        const now = Date.now();
        const diff = localPlayMs - now;

        appendDebug(`follower recv beat bn=${msg.beatNumber} serverMs=${Math.round(serverMs)} localPlayMs=${Math.round(localPlayMs)} diff=${diff.toFixed(1)}`);
        // print structured debug row
        const tableRow = {
          kind: 'follower_recv_beat',
          beatNumber: msg.beatNumber,
          beatIndex: msg.beatIndex,
          serverScheduledMs: Math.round(serverMs),
          localScheduledMs: Math.round(localPlayMs),
          nowLocalMs: now,
          diffMs: +(localPlayMs - now).toFixed(2)
        };
        pushTableRow(tableRow);

        // Resync logic if beatNumber differs a lot
        const bn = Number(msg.beatNumber);
        if (typeof nextBeatNumber === 'number') {
          const diffBn = bn - nextBeatNumber;
          if (Math.abs(diffBn) > 1) {
            appendDebug(`Resync: leader bn=${bn} local next=${nextBeatNumber} diff=${diffBn}`);
            scheduledBeats.clear();
            nextBeatNumber = bn + 1;
            const nextServerMs = serverMs + (noteInterval * 1000);
            const nextLocalMs = nextServerMs - offsetMs;
            nextNoteTime = audioTimeFromLocalEpochMs(nextLocalMs);
            appendDebug(`Resynced nextLocalMs=${Math.round(nextLocalMs)} nextBeatNumber=${nextBeatNumber}`);
            pushTableRow({ kind:'resync', bn, diffBn, nextLocalMs: Math.round(nextLocalMs) });
          }
        }

        // schedule local click so fallback is seamless; if audio stream is current and not fallback active, we might not hear it (audio stream will be heard instead)
        if (!scheduledBeats.has(bn)) {
          scheduleClickAtAudioTime(audioWhen, isAccent && soundEnabled);
          const playDelay = Math.max(0, localPlayMs - Date.now());
          setTimeout(()=> updateVisual(msg.beatIndex), playDelay);
          scheduledBeats.add(bn);
        }
        if (dbgBeat) dbgBeat.textContent = String(msg.beatIndex);

      } else if (msg.type === 'dc_pong') {
        const t1 = msg.t1, t2 = msg.t2, t3 = msg.t3;
        const leaderOff = typeof msg.leaderOffsetMs === 'number' ? msg.leaderOffsetMs : null;
        const t4 = Date.now();
        const offsetPeer = ((t2 - t1) + (t3 - t4)) / 2;
        const rtt = (t4 - t1) - (t3 - t2);
        appendDebug(`dc_pong offsetPeer=${offsetPeer.toFixed(1)} rtt=${rtt.toFixed(1)} leaderOff=${leaderOff}`);
        if (leaderOff !== null) {
          const refined = Math.round(leaderOff + offsetPeer);
          const alpha = 0.35;
          offsetMs = Math.round((1 - alpha) * offsetMs + alpha * refined);
          if (dbgOffset) dbgOffset.textContent = offsetMs.toFixed(1);
          if (dbgDelay) dbgDelay.textContent = rtt.toFixed(1);
          pushTableRow({ kind:'dc_pong_refine', offsetMs, rtt });
        } else {
          const alpha = 0.2;
          offsetMs = Math.round((1 - alpha) * offsetMs + alpha * (offsetMs + offsetPeer));
          if (dbgOffset) dbgOffset.textContent = offsetMs.toFixed(1);
          pushTableRow({ kind:'dc_pong_fallback', offsetMs, rtt });
        }

      } else {
        appendDebug('follower DC other: ' + JSON.stringify(msg).slice(0,200));
      }
    } catch (e) {
      console.warn('handleLeaderDCMessage err', e);
      appendDebug('handleLeaderDCMessage err: ' + (e && e.message));
    }
  }

  // follower ping
  function startDCPingPong() {
    if (!dc || dc.readyState !== 'open') return;
    stopDCPingPong();
    dcPingInterval = setInterval(() => {
      try {
        const t1 = Date.now();
        dc.send(JSON.stringify({ type:'dc_ping', t1 }));
        pushTableRow({ kind:'dc_ping', t1 });
      } catch (e) {
        appendDebug('dc ping send fail: ' + (e && e.message));
      }
    }, DC_PING_INTERVAL_MS);
  }
  function stopDCPingPong() {
    if (dcPingInterval) { clearInterval(dcPingInterval); dcPingInterval = null; }
  }

  // ----- Buttons (UI handlers) -----
  startLocalBtn.addEventListener('click', () => {
    isLeader = false;
    bpm = Number(bpmRange.value); beatsPerMeasure = Number(beatsPerMeasureSel.value);
    noteInterval = 60 / bpm;
    const localStart = Date.now() + 50;
    startSchedulerAtLocalStart(localStart);
    appendDebug('local start pressed');
    pushTableRow({ kind:'ui', action:'local_start', localStart });
  });

  stopLocalBtn.addEventListener('click', () => {
    stopScheduler();
    stopDCPingPong();
    appendDebug('local stop pressed');
    pushTableRow({ kind:'ui', action:'local_stop' });
  });

  startLeaderBtn.addEventListener('click', async () => {
    try {
      // timesync to server baseline
      await timesyncMulti(SAMPLES_TIMESYNC);
      leaderOffsetMs = offsetMs; // leader's offset to server baseline
      // create leader on server
      const leader = await createLeaderOnServer();
      currentLeader = leader;
      isLeader = true;

      // apply leader settings
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();

      // compute local start using server startTime
      const localStart = computeLocalStartFromLeader(leader.startTime);
      if (dbgLeaderStart) dbgLeaderStart.textContent = String(leader.startTime);
      // start local scheduler aligned
      startSchedulerAtLocalStart(localStart);

      // setup leader WebRTC: add audio track + DC
      await setupLeaderWebRTC(leader.label);

      // refresh list and UI
      setTimeout(refreshLeaderList, 400);
      appendDebug('startLeader done');
      pushTableRow({ kind:'ui', action:'startLeader', label: leader.label, start: leader.startTime });
    } catch (e) {
      console.error('start leader failed', e);
      alert('Start leader failed: ' + (e && e.message));
      appendDebug('start leader failed: ' + (e && e.message));
    }
  });

  joinLeaderBtn.addEventListener('click', async () => {
    const sel = leaderSelect.value;
    if (!sel) return alert('請先選擇一個 leader');
    const label = decodeURIComponent(sel);
    try {
      // timesync baseline for follower
      await timesyncMulti(SAMPLES_TIMESYNC);
      const r = await fetch(API_LEADERS + '?label=' + encodeURIComponent(label));
      if (!r.ok) throw new Error('fetch leader failed: ' + r.status);
      const leader = await r.json();
      currentLeader = leader;

      // apply leader settings BEFORE computing local start
      bpm = leader.bpm || bpm;
      beatsPerMeasure = leader.beatsPerMeasure || beatsPerMeasure;
      bpmRange.value = bpm; bpmVal.textContent = String(bpm);
      beatsPerMeasureSel.value = String(beatsPerMeasure);
      renderSegments();

      const localStart = computeLocalStartFromLeader(leader.startTime);
      if (dbgLeaderStart) dbgLeaderStart.textContent = String(leader.startTime);

      // start local scheduler aligned (keeps local timing ready for fallback)
      startSchedulerAtLocalStart(localStart);

      // join WebRTC audio/DC
      await joinLeaderWebRTC(leader.label);
      appendDebug(`joined leader ${label}`);
      pushTableRow({ kind:'ui', action:'join', label });
    } catch (e) {
      console.error('join failed', e);
      alert('Join failed: ' + (e && e.message));
      appendDebug('join failed: ' + (e && e.message));
    }
  });

  // ----- helpers -----
  async function refreshLeaderListPeriodic() {
    try {
      await refreshLeaderList();
    } catch (e) { /* ignore */ }
    setTimeout(refreshLeaderListPeriodic, 6000);
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
    appendDebug(`server created leader ${leader.label} start=${leader.startTime}`);
    pushTableRow({ kind:'server_created_leader', label: leader.label, start: leader.startTime });
    return leader;
  }

  // convert server start time -> local ms by subtracting our offset (server - local)
  function computeLocalStartFromLeader(serverStartMs) {
    return Number(serverStartMs) - Number(offsetMs);
  }

  // expose debug
  window._metronome = {
    timesyncMulti,
    pushTableRow,
    getTableBuffer: () => tableBuffer.slice()
  };

  // ----- INIT UI + events -----
  function init() {
    bpm = Number(bpmRange.value);
    beatsPerMeasure = Number(beatsPerMeasureSel.value);
    soundEnabled = soundToggle.checked;
    noteInterval = 60 / bpm;
    renderSegments();
    updateVisual(0);
    refreshLeaderList();
    refreshLeaderListPeriodic();

    bpmRange.addEventListener('input', () => {
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

  function resetSchedulerForBPMChange() {
    noteInterval = 60 / bpm;
    ensureAudioCtx();
    nextNoteTime = audioCtx.currentTime + 0.05;
    appendDebug(`BPM changed -> noteInterval=${noteInterval}`);
  }

  // ----- Start audio monitor heartbeat (called when audio stream present) -----
  // We'll update lastAudioPacketMs periodically based on audio context time to indicate activity.
  // Since ontrack events don't always guarantee continuous events, rely on incomingAudioEl playing to mark alive.
  // We set lastAudioPacketMs when ontrack/playing events occur.

  // ----- Boot -----
  init();

  // ---------- End closure ----------
})();
