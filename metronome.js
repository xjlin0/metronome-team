let isLeader = false;
let leaderId = null;
let startTime = null;
let bpm = 120;
let beatsPerMeasure = 4;

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
    const hue = activeBeat === 0 ? 0 : 200;
    circle.style.backgroundColor = `hsl(${hue},70%,50%)`;
  }

  function startLocalMetronome() {
    const intervalMs = 60000 / bpm;
    let beat = 0;
    setInterval(() => {
      renderCircle(beat % beatsPerMeasure);
      if (isLeader && dataChannel?.readyState==='open') {
        dataChannel.send(JSON.stringify({ type:'beat', beat:beat%beatsPerMeasure, timestamp:Date.now(), bpm, beatsPerMeasure }));
      }
      beat++;
    }, intervalMs);
  }

  async function createLeader() {
    const res = await fetch(leadersAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    const data = await res.json();
    leaderId = data.id;
    startTime = data.startTime || null;
    bpm = data.bpm;
    beatsPerMeasure = data.beatsPerMeasure;
    bpmInput.value = bpm;
    beatsInput.value = beatsPerMeasure;
    alert('leader created: '+leaderId+'\nstartTime: '+startTime);
  }

  async function timesync() {
    const clientTime = Date.now();
    const res = await fetch(timesyncAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({clientTime})});
    if (!res.ok) { console.error(await res.text()); return; }
    const data = await res.json();
    const t4 = Date.now();
    const offset = ((data.t2-clientTime)+(data.t3-t4))/2;
    console.log('RTT offset debug (ms):', offset, 'RTT:', data.rtt);
  }

  async function setupLeaderConnection() {
    rtcConnection = new RTCPeerConnection();
    dataChannel = rtcConnection.createDataChannel('beatSync');
    dataChannel.onopen = ()=>console.log('DataChannel open');
    dataChannel.onmessage = e=>console.log('Follower beat:', e.data);
    rtcConnection.onicecandidate = e=>{ if(e.candidate) console.log('ICE candidate:',e.candidate); };
    const offer = await rtcConnection.createOffer();
    await rtcConnection.setLocalDescription(offer);
    await fetch(signalAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'offer',id:leaderId,payload:offer}) });
  }

  startBtn.onclick = async () => {
    isLeader=true;
    await createLeader();
    await timesync();
    startLocalMetronome();
    setupLeaderConnection();
  };

  joinBtn.onclick = async () => {
    isLeader=false;
    await timesync();
    startLocalMetronome();
    const leaderIdPrompt = prompt('Enter leader ID:');
    const offerRes = await fetch(`${signalAPI}?type=offer&id=${leaderIdPrompt}`);
    const { payload: offer } = await offerRes.json();
    if (!offer) return alert('Leader offer not found');
    rtcConnection = new RTCPeerConnection();
    rtcConnection.ondatachannel = e=>{
      dataChannel=e.channel;
      dataChannel.onmessage=ev=>console.log('Beat received:', ev.data);
    };
    await rtcConnection.setRemoteDescription(offer);
    const answer = await rtcConnection.createAnswer();
    await rtcConnection.setLocalDescription(answer);
    await fetch(signalAPI, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type:'answer',id:leaderIdPrompt,payload:answer}) });
  };

  // 首次訪問就能看到圈圈動起來
  startLocalMetronome();
});
