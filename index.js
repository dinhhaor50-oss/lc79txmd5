const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const app = express();
const PORT = process.env.PORT || 3000;

// Config
const API_URL = 'https://wtxmd52.tele68.com/v1/txmd5/lite-sessions?cp=R&cl=R&pf=web';
const WS_URL = 'wss://wtxmd52.tele68.com/txmd5/?EIO=4&transport=websocket';
const AT = process.env.AT_TOKEN || '5848a1b6c31c549ee87fa61fd1b3f3f6';
const POLL_INTERVAL = 20000;

let sessions = [];
let lastId = 0;
let pollCount = 0;
let lastPoll = null;
let wsClient = null;
let currentBetData = null; // tiền cược real-time

// ===== HTTP POLL (lịch sử) =====
function fetchSessions() {
  return new Promise((resolve, reject) => {
    https.get(`${API_URL}&at=${AT}`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function poll() {
  try {
    const data = await fetchSessions();
    if (!data.list) return;
    let newCount = 0;
    for (const item of data.list) {
      if (item.id <= lastId) continue;
      if (sessions.find(s => s.Phien === item.id)) continue;
      const record = {
        Phien: item.id, Hash: item._id,
        Xuc_xac_1: item.dices[0], Xuc_xac_2: item.dices[1], Xuc_xac_3: item.dices[2],
        Tong: item.point, Ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu',
        time: new Date().toISOString()
      };
      sessions.unshift(record);
      newCount++;
      console.log(`✅ #${record.Phien} | ${record.Xuc_xac_1}-${record.Xuc_xac_2}-${record.Xuc_xac_3} = ${record.Tong} → ${record.Ket_qua}`);
    }
    if (data.list.length > 0) lastId = Math.max(lastId, ...data.list.map(i => i.id));
    if (sessions.length > 500) sessions = sessions.slice(0, 500);
    pollCount++; lastPoll = new Date().toISOString();
  } catch(e) { console.error('❌ Poll error:', e.message); }
}

// ===== SOCKET.IO WS (tiền cược real-time) =====
function connectWS() {
  if (wsClient && wsClient.readyState === WebSocket.OPEN) return;
  console.log('🔌 Connecting WS...');

  wsClient = new WebSocket(WS_URL, {
    headers: { 'Origin': 'https://wtxmd52.tele68.com' },
    rejectUnauthorized: false
  });

  wsClient.on('open', () => {
    console.log('✅ WS connected!');
    // Socket.IO handshake
    wsClient.send('40/txmd5,');
  });

  wsClient.on('message', (data) => {
    try {
      const msg = data.toString();
      // Socket.IO format: 42/txmd5,["event", payload]
      const match = msg.match(/^42\/txmd5,(\[.+\])$/);
      if (!match) return;
      const arr = JSON.parse(match[1]);
      const evt = arr[0], payload = arr[1];

      if (evt === 'tick-update' && payload?.data) {
        currentBetData = {
          sessionId: payload.id,
          state: payload.state,
          totalUsers: payload.data.totalUniqueUsers,
          totalAmount: payload.data.totalAmount,
          taiUsers: payload.data.totalUsersPerType?.TAI || 0,
          xiuUsers: payload.data.totalUsersPerType?.XIU || 0,
          taiAmount: payload.data.totalAmountPerType?.TAI || 0,
          xiuAmount: payload.data.totalAmountPerType?.XIU || 0,
          updatedAt: new Date().toISOString()
        };
      }

      if (evt === 'session-result' || evt === 'result') {
        console.log('🎲 WS Result:', JSON.stringify(payload));
        poll(); // Trigger poll ngay khi có kết quả
      }
    } catch(e) {}
  });

  wsClient.on('close', (code) => {
    console.log(`🔴 WS closed: ${code} - retry in 5s`);
    setTimeout(connectWS, 5000);
  });

  wsClient.on('error', (e) => console.error('⚠️ WS:', e.message));

  // Socket.IO ping mỗi 25s
  setInterval(() => {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) wsClient.send('2');
  }, 25000);
}

// ===== API =====
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

app.get('/api/lichsu', (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const data = sessions.slice(0, limit);
  // Gắn bet data vào phiên hiện tại nếu có
  if (currentBetData && data.length > 0) {
    data[0]._betData = currentBetData;
  }
  res.json(data);
});

app.get('/api/bet', (req, res) => res.json(currentBetData || {}));

app.get('/api/status', (req, res) => res.json({
  sessions: sessions.length, lastId, pollCount, lastPoll,
  ws: wsClient ? ['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState] : 'NULL',
  currentBet: currentBetData,
  uptime: Math.floor(process.uptime()) + 's'
}));

app.get('/', (req, res) => res.send(`
  <h2>🎲 TX Collector</h2>
  <p>Sessions: ${sessions.length} | WS: ${wsClient?['CONNECTING','OPEN','CLOSING','CLOSED'][wsClient.readyState]:'NULL'}</p>
  <a href="/api/lichsu">/api/lichsu</a> | 
  <a href="/api/bet">/api/bet</a> | 
  <a href="/api/status">/api/status</a>
`));

// Start
app.listen(PORT, () => {
  console.log(`🚀 Port ${PORT}`);
  poll();
  setInterval(poll, POLL_INTERVAL);
  connectWS();
});
