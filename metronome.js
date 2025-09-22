let audioCtx = null;
let currentTimer = null;
let bpm = 120;
let beatsPerMeasure = 0;
let beatCount = 0;

const circle = document.getElementById("circle");
const bpmInput = document.getElementById("bpm");
const bpmValue = document.getElementById("bpmValue");
const beatsInput = document.getElementById("beatsPerMeasure");

bpmInput.addEventListener("input", e => {
  bpm = parseInt(e.target.value, 10);
  bpmValue.textContent = bpm;
  if (currentTimer) restartMetronome();
});

beatsInput.addEventListener("input", e => {
  beatsPerMeasure = parseInt(e.target.value, 10);
});

document.getElementById("startBtn").addEventListener("click", startMetronome);
document.getElementById("stopBtn").addEventListener("click", stopMetronome);

function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
}

function playClick(isAccent) {
  const osc = audioCtx.createOscillator();
  const envelope = audioCtx.createGain();

  osc.frequency.value = isAccent ? 1000 : 700;
  envelope.gain.value = 1;

  osc.connect(envelope).connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + 0.1);
}

function flashCircle() {
  circle.style.background = "#4caf50";
  setTimeout(() => circle.style.background = "#ccc", 100);
}

function tick() {
  beatCount++;
  let isAccent = (beatsPerMeasure > 0) && ((beatCount - 1) % beatsPerMeasure === 0);
  playClick(isAccent);
  flashCircle();
}

function startMetronome(startTime = Date.now()) {
  initAudio();
  stopMetronome();
  beatCount = 0;
  const interval = (60 / bpm) * 1000;
  const delay = Math.max(0, startTime - Date.now()); // 用於同步
  setTimeout(() => {
    tick();
    currentTimer = setInterval(tick, interval);
  }, delay);
}

function stopMetronome() {
  if (currentTimer) {
    clearInterval(currentTimer);
    currentTimer = null;
  }
}

function restartMetronome() {
  if (currentTimer) {
    startMetronome();
  }
}

// =====================
// Leader/Follower
// =====================

const leaderBtn = document.getElementById("leaderBtn");
const followerBtn = document.getElementById("followerBtn");
const leaderList = document.getElementById("leaderList");

leaderBtn.addEventListener("click", async () => {
  // 向 server 註冊 Leader
  const res = await fetch("/api/leaders", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bpm, beatsPerMeasure })
  });
  const data = await res.json();
  alert(`Leader started: ${data.id}`);
});

followerBtn.addEventListener("click", async () => {
  const res = await fetch("/api/leaders");
  const leaders = await res.json();
  leaderList.innerHTML = leaders.map(l => 
    `<button onclick="joinLeader('${l.id}')">Join ${l.id}</button>`
  ).join("<br>");
});

async function joinLeader(id) {
  // 簡單 time sync
  const sync = await fetch("/api/timesync").then(r => r.json());
  const offset = sync.offset;

  // Leader config
  const res = await fetch(`/api/leaders?id=${id}`);
  const leader = await res.json();

  bpm = leader.bpm;
  beatsPerMeasure = leader.beatsPerMeasure;
  bpmInput.value = bpm;
  bpmValue.textContent = bpm;
  beatsInput.value = beatsPerMeasure;

  // 根據 leader 基準時間 + offset 啟動
  const startTime = leader.startTime + offset;
  startMetronome(startTime);
}

