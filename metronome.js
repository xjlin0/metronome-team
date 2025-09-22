// metronome.js
let isLeader = false;
let leaderId = null;
let startTime = null;
let bpm = 120;
let beatsPerMeasure = 4;

const leadersAPI = '/api/leaders';
const timesyncAPI = '/api/timesync';

const circle = document.getElementById('circle');
const bpmInput = document.getElementById('bpm');
const beatsInput = document.getElementById('beats');
const startBtn = document.getElementById('startLeader');
const joinBtn = document.getElementById('joinFollower');

let rtcConnection;
let dataChannel;
let followerOffsets = [];

// -----------------------
// UI
// -----------------------
function renderCircle(activeBeat, measureBeat) {
  const hue = activeBeat === 0 ? 0 : 200; // 起拍紅色，其他藍色
  circle.style.backgroundColor = `hsl(${hue}, 70%, 50%)`;
}

function startLocalMetronome(offset = 0) {
  const intervalMs = (60_000 / bpm);
  let beat = 0;
  setInterval(() => {
    renderCircle(beat % beatsPerMeasure, beat % beatsPerMeasure);
    if (isLeader && dataChannel?.readyState === 'open') {
      dataChannel.send(JSON.stringify({ type: 'beat', beat: beat % beatsPerMeasure, timestamp: Date.now() }));
    }
    beat++;
  }, intervalMs);
}

// -----------------------
// API Calls
// -----------------------
async function createLeader() {
  const res = await fetch(leadersAPI, { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  const data = await res.json();
  leaderId = data.id;
  startTime = data.startTime || null;
  alert('leader created: ' + leaderId + '\nstartTime: ' + startTime);
  return data;
}

async function timesync() {
  const clientTime = Date.now();
  const res = await fetch(timesyncAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientTime })
  });
  if (!res.ok) {
    console.error(await res.text());
    return null;
  }
  const data = await res.json();
  const t4 = Date.now();
  const offset = ((data.t2 - clientTime) + (data.t3 - t4)) / 2;
  console.log('RTT offset debug (ms):', offset, 'RTT:', data.rtt);
  return offset;
}

// -----------------------
// WebRTC / DataChannel
// -----------------------
async function setupLeaderConnection() {
  rtcConnection = new RTCPeerConnection();
  dataChannel = rtcConnection.createDataChannel('beatSync');

  dataChannel.onopen = () => console.log('DataChannel open');
  dataChannel.onmessage = (e) => console.log('Leader received:', e.data);

  rtcConnection.onicecandidate = (e) => {
    if (e.candidate) {
      console.log('ICE candidate:', e.candidate);
    }
  };

  // Leader creates offer
  const offer = await rtcConnection.createOffer();
  await rtcConnection.setLocalDescription(offer);

  console.log('Offer created, send to signaling server (not implemented demo)');
}

async function joinAsFollower(offer) {
  isLeader = false;
  rtcConnection = new RTCPeerConnection();
  rtcConnection.ondatachannel = (e) => {
    dataChannel = e.channel;
    dataChannel.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'beat') {
        // follower 收到 beat, 計算延遲 offset
        console.log('Follower beat received', msg.beat, 'timestamp', msg.timestamp);
      }
    };
  };
  await rtcConnection.setRemoteDescription(offer);
  const answer = await rtcConnection.createAnswer();
  await rtcConnection.setLocalDescription(answer);
  console.log('Answer created, send back to leader via signaling server');
}

// -----------------------
// Event Listeners
// -----------------------
startBtn.onclick = async () => {
  isLeader = true;
  await createLeader();
  await timesync();
  startLocalMetronome();
  setupLeaderConnection();
};

joinBtn.onclick = async () => {
  isLeader = false;
  await timesync();
  startLocalMetronome();
  // joinAsFollower(offer) // signaling server 未實作
};

// -----------------------
// Immediate UI render
// -----------------------
startLocalMetronome(); // 保證首次訪問就能看到圈圈動起來
