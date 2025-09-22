let isLeader = false;
let leaderLabel = null;
let startTime = null;
let bpm = 120;
let beatsPerMeasure = 0;
let offset = 0;
let intervalId = null;
let currentBeat = 0;
let soundEnabled = true;
let dataChannel = null;
let rtcConnection = null;

const leadersAPI = '/api/leaders';
const timesyncAPI = '/api/timesync';
const signalAPI = '/api/signal';

// DOM
const circle = document.getElementById('circle');
const bpmInput = document.getElementById('bpm');
const beatsInput = document.getElementById('beats');
const soundCheckbox = document.getElementById('sound');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const startLeaderBtn = document.getElementById('startLeader');
const joinFollowerBtn = document.getElementById('joinFollower');
const leaderLabelInput = document.getElementById('leaderLabel');

function playClick() {
  if (!soundEnabled) return;
  const audio = new Audio(currentBeat===0?'https://actions.google.com/sounds/v1/alarms/beep_short.ogg':'https://actions.google.com/sounds/v1/alarms/beep.ogg');
  audio.play();
}

function renderCircle() {
  const hue = (beatsPerMeasure>0 && currentBeat===0) ? 0 : 200;
  circle.style.backgroundColor = `hsl(${hue},70%,50%)`;
}

function startMetronome() {
  if (intervalId) clearInterval(intervalId);
  const intervalMs = 60000/bpm;
  intervalId = setInterval(()=>{
    currentBeat = beatsPerMeasure>0 ? (currentBeat+1)%beatsPerMeasure : 0;
    renderCircle();
    playClick();
    if (isLeader && dataChannel?.readyState==='open') {
      dataChannel.send(JSON.stringify({type:'beat', beat:currentBeat, timestamp:Date.now(), bpm, beatsPerMeasure}));
    }
  }, intervalMs);
}

function stopMetronome() {
  if (intervalId) clearInterval(intervalId);
  intervalId = null;
  currentBeat = 0;
  renderCircle();
}

// UI events
bpmInput.oninput = () => { bpm = parseInt(bpmInput.value); if(intervalId) startMetronome(); };
beatsInput.oninput = () => { beatsPerMeasure = parseInt(beatsInput.value); currentBeat=0; renderCircle(); };
soundCheckbox.onchange = () => { soundEnabled = soundCheckbox.checked; };

startBtn.onclick = ()=>startMetronome();
stopBtn.onclick = ()=>stopMetronome();

async function timesync() {
  const t1 = Date.now();
  const res = await fetch(timesyncAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientTime:t1})});
  if(!res.ok){ console.error(await res.text()); return; }
  const {clientTime,t2,t3} = await res.json();
  const t4 = Date.now();
  offset = ((t2-clientTime)+(t3-t4))/2;
  console.log('RTT offset ms:', offset);
}

// Leader API
async function createLeader() {
  const label = leaderLabelInput.value;
  const res = await fetch(leadersAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({label})});
  const data = await res.json();
  leaderLabel = data.label;
  bpm = data.bpm;
  beatsPerMeasure = data.beatsPerMeasure;
  bpmInput.value = bpm;
  beatsInput.value = beatsPerMeasure;
  alert('Leader created: '+leaderLabel);
}

// Leader/Follower WebRTC
async function setupLeaderConnection() {
  rtcConnection = new RTCPeerConnection();
  dataChannel = rtcConnection.createDataChannel('beatSync');
  dataChannel.onopen = ()=>console.log('Leader DataChannel open');
  dataChannel.onmessage = e=>console.log('Follower beat:', e.data);
  rtcConnection.onicecandidate = e=>{ if(e.candidate) console.log('ICE:',e.candidate); };
  const offer = await rtcConnection.createOffer();
  await rtcConnection.setLocalDescription(offer);
  await fetch(signalAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'offer',id:leaderLabel,payload:offer})});
}

async function joinLeader() {
  const label = prompt('Enter Leader Label:');
  const res = await fetch(`${signalAPI}?type=offer&id=${label}`);
  const data = await res.json();
  if(!data.payload){ alert('Leader offer not found'); return; }
  rtcConnection = new RTCPeerConnection();
  rtcConnection.ondatachannel = e=>{
    dataChannel = e.channel;
    dataChannel.onmessage = ev=>{
      const beatData = JSON.parse(ev.data);
      const serverTime = beatData.timestamp;
      const adjustedStart = serverTime + offset;
      startMetronome(); // start locally
    };
  };
  await rtcConnection.setRemoteDescription(data.payload);
  const answer = await rtcConnection.createAnswer();
  await rtcConnection.setLocalDescription(answer);
  await fetch(signalAPI,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'answer',id:label,payload:answer})});
}

startLeaderBtn.onclick = async ()=>{
  isLeader=true;
  await timesync();
  await createLeader();
  setupLeaderConnection();
};

joinFollowerBtn.onclick = async ()=>{
  isLeader=false;
  await timesync();
  joinLeader();
};
