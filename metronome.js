// metronome.js
let isLeader = false;
let leaderId = null;
let startTime = null;
let bpm = 120;
let beatsPerMeasure = 4;
let offset = 0;

const leadersAPI = '/api/leaders';
const timesyncAPI = '/api/timesync';
const signalAPI = '/api/signal';

let rtcConnection;
let dataChannel;

// DOM elements
document.addEventListener('DOMContentLoaded', () => {
  const circle = document.getElementById('circle');
  const bpmInput = document.getElementById('bpm');
  const beatsInput = document.getElementById('beats');
  const startBtn = document.getElementById('startLeader');
  const joinBtn = document.getElementById('joinFollower');

  bpmInput.onchange = () => bpm = parseInt(bpmInput.value);
  beatsInput.onchange = () => beatsPerMeasure = parseInt(beatsInput.value);

  function renderCircle(activeBeat) {
    const hue = activeBeat === 0 ? 0 : 200; // 起拍紅色，其他拍藍色
    circle.style.backgroundColor = `hsl(${hue},70%,50%)`;
  }

  function startLocalMetronome(startTimestamp = Date.now()) {
    const intervalMs = 60000 / bpm;
    let beat = 0;
    function tick() {
      const now = Date.now() + offset;
      const elapsed = now - startTimestamp;
      beat = Math.floor(elapsed / intervalMs) % beatsPerMeasure;
      renderCircle(beat);
      if (isLeader && dataChannel?.readyState === 'open') {
        dataChannel.send(JSON.stringify({ type: 'beat', beat, timestamp: Date.now(), bpm, beatsPerMeasure }));
      }
      requestAnimationFrame(tick);
    }
    tick();
  }

  async function timesync() {
    const clientTime = Date.now();
    const res = await fetch(timesyncAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientTime })
    });
    if (!res.ok) { console.error(await res.text()); return; }
    const data = await res.json();
    const t4 = Date.now();
    offset = ((data.t2 - clientTime) + (data.t3 - t4)) / 2;
    console.log('RTT offset (ms):', offset, 'RTT:', data.rtt);
  }

  async function createLeader() {
    const res = await fetch(leadersAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const data = await res.json();
    leaderId = data.id;
    bpm = data.bpm;
    beatsPerMeasure = data.beatsPerMeasure;
    bpmInput.value = bpm;
    beatsInput.value = beatsPerMeasure;
    startTime = Date.now() + offset;
    alert('Leader created: '+leaderId);
  }

  async function setupLeaderConnection() {
    rtcConnection = new RTCPeerConnection();
    dataChannel = rtcConnection.createDataChannel('beatSync');
    dataChannel.onopen = ()=>console.log('DataChannel open');
    dataChannel.onmessage = e=>{
      const msg = JSON.parse(e.data);
      console.log('Follower beat:', msg);
    };
    rtcConnection.onicecandidate = e=>{ if(e.candidate) console.log('ICE candidate:',e.candidate); };
    const offer = await rtcConnection.createOffer();
    await rtcConnection.setLocalDescription(offer);
    await fetch(signalAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'offer',id:leaderId,payload:offer}) });
  }

  async function joinLeader() {
    const leaderIdPrompt = prompt('Enter leader ID:');
    const offerRes = await fetch(`${signalAPI}?type=offer&id=${leaderIdPrompt}`);
    const { payload: offer } = await offerRes.json();
    if (!offer) return alert('Leader offer not found');
    rtcConnection = new RTCPeerConnection();
    rtcConnection.ondatachannel = e=>{
      dataChannel = e.channel;
      dataChannel.onmessage = ev => {
        const beatData = JSON.parse(ev.data);
        const serverTime = beatData.timestamp;
        const adjustedStart = serverTime + offset;
        startLocalMetronome(adjustedStart);
      };
    };
    await rtcConnection.setRemoteDescription(offer);
    const answer = await rtcConnection.createAnswer();
    await rtcConnection.setLocalDescription(answer);
    await fetch(signalAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'answer',id:leaderIdPrompt,payload:answer}) });
  }

  startBtn.onclick = async () => {
    isLeader = true;
    await timesync();
    await createLeader();
    startLocalMetronome(startTime);
    setupLeaderConnection();
  };

  joinBtn.onclick = async () => {
    isLeader = false;
    await timesync();
    joinLeader();
  };

  // 首次訪問就能看到圈圈動起來
  startLocalMetronome(Date.now());
});
