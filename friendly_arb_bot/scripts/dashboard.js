#!/usr/bin/env node
// Dashboard for The Friendly Circles Arb Bot
// Shows givebacks, trades, and bot status

const http = require("http");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const PORT = 3000;
const DATA_DIR = path.join(__dirname, "..", "data");
const STATE_FILE = path.join(DATA_DIR, "bot-state.json");
const HEARTBEAT_FILE = path.join(DATA_DIR, "heartbeat");
const LOG_FILE = path.join(DATA_DIR, "bot.log");
const LOGO_FILE = path.join(DATA_DIR, "logo.png");

const provider = new ethers.JsonRpcProvider("https://rpc.gnosischain.com");
const EOA = "0x53D5120518E2B7a87c53d0dE5590F91D85b7BA89";
const SAFE = "0x3F4cCACf2173553850258dE2E8495366a0F10c31";
const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
const GNOSIS_CRC = "0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A";
const erc20Abi = ["function balanceOf(address) view returns (uint256)"];

let balanceCache = { sdai: 0, crc: 0, xdai: 0, time: 0 };

const NAME_CACHE_FILE = path.join(DATA_DIR, "name-cache.json");
let nameCache = {};
try { nameCache = JSON.parse(fs.readFileSync(NAME_CACHE_FILE, "utf8")); } catch {}

function saveNameCache() {
  try { fs.writeFileSync(NAME_CACHE_FILE, JSON.stringify(nameCache)); } catch {}
}

async function getBalances() {
  const now = Date.now();
  if (now - balanceCache.time < 30_000) return balanceCache;
  try {
    const sdai = new ethers.Contract(SDAI, erc20Abi, provider);
    const crc = new ethers.Contract(GNOSIS_CRC, erc20Abi, provider);
    const [sBal, cBal, xBal] = await Promise.all([
      sdai.balanceOf(SAFE), crc.balanceOf(SAFE), provider.getBalance(EOA),
    ]);
    balanceCache = {
      sdai: parseFloat(ethers.formatEther(sBal)),
      crc: parseFloat(ethers.formatEther(cBal)),
      xdai: parseFloat(ethers.formatEther(xBal)),
      time: now,
    };
  } catch {}
  return balanceCache;
}

const NAME_TTL = 24 * 3600_000;
const PROFILES_URL = "https://rpc.aboutcircles.com/profiles/search";

async function resolveNames(addresses) {
  const now = Date.now();
  const result = {};
  const toResolve = [];
  for (const addr of addresses) {
    const lc = addr.toLowerCase();
    const cached = nameCache[lc];
    if (cached && now - cached.time < NAME_TTL) {
      result[lc] = cached.name;
    } else {
      toResolve.push(lc);
    }
  }
  if (toResolve.length === 0) return result;
  const fetchResults = await Promise.allSettled(
    toResolve.map(async (addr) => {
      try {
        const r = await fetch(`${PROFILES_URL}?address=${addr}`, { signal: AbortSignal.timeout(5000) });
        const data = await r.json();
        const name = Array.isArray(data) && data.length > 0 ? data[0].name || null : null;
        return { addr, name };
      } catch { return { addr, name: null }; }
    })
  );
  for (const r of fetchResults) {
    if (r.status === "fulfilled") {
      const { addr, name } = r.value;
      nameCache[addr] = { name, time: now };
      result[addr] = name;
    }
  }
  saveNameCache();
  return result;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

function readHeartbeat() {
  try { return JSON.parse(fs.readFileSync(HEARTBEAT_FILE, "utf8")); } catch { return {}; }
}

function readLogs(n = 200) {
  try {
    const data = fs.readFileSync(LOG_FILE, "utf8");
    const lines = data.trim().split("\n");
    return lines.slice(-n);
  } catch { return []; }
}

function parseTrades(state) {
  const trades = state.trades || [];
  return trades.slice(-100).reverse().map(t => ({
    time: t.time || t.timestamp,
    avatar: t.avatar,
    spend: t.spend,
    profit: t.actualProfit,
    roi: t.spend > 0 ? ((t.actualProfit / t.spend) * 100) : 0,
    txHash: t.txHash,
    type: t.type || "personal",
    givebackCrc: t.givebackCrc || 0,
  }));
}

function computeGivebackLeaderboard(state) {
  const trades = state.trades || [];
  const byAvatar = {};
  for (const t of trades) {
    if (!t.givebackCrc || t.givebackCrc <= 0) continue;
    const a = t.avatar?.toLowerCase();
    if (!a) continue;
    if (!byAvatar[a]) byAvatar[a] = { avatar: t.avatar, totalCrc: 0, count: 0 };
    byAvatar[a].totalCrc += t.givebackCrc;
    byAvatar[a].count++;
  }
  return Object.values(byAvatar).sort((a, b) => b.totalCrc - a.totalCrc);
}

// ============================================================================
// HTTP SERVER
// ============================================================================
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.url === "/logo.png") {
    try {
      const img = fs.readFileSync(LOGO_FILE);
      const ct = img[0] === 0xFF && img[1] === 0xD8 ? "image/jpeg" : "image/png";
      res.writeHead(200, { "Content-Type": ct, "Cache-Control": "public, max-age=3600" });
      res.end(img);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
    return;
  }

  if (req.url === "/api/status") {
    const state = readState();
    const hb = readHeartbeat();
    const bal = await getBalances();
    const trades = state.trades || [];
    const givebackTrades = trades.filter(t => t.givebackCrc > 0);
    const totalCrcGivenBack = givebackTrades.reduce((s, t) => s + t.givebackCrc, 0);
    const uniqueRecipients = new Set(givebackTrades.map(t => t.avatar?.toLowerCase())).size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      totalTrades: state.totalTrades || 0,
      totalProfit: state.totalProfit || 0,
      totalFailed: state.totalFailed || 0,
      totalCrcGivenBack,
      givebackCount: givebackTrades.length,
      uniqueRecipients,
      balances: bal,
      heartbeat: hb,
      universe: hb.universe || null,
      botRunning: hb.time ? (Date.now() - new Date(hb.time).getTime() < 120_000) : false,
    }));
    return;
  }

  if (req.url === "/api/trades") {
    const state = readState();
    const trades = parseTrades(state);
    const avatars = [...new Set(trades.map(t => t.avatar).filter(Boolean))];
    const names = await resolveNames(avatars);
    for (const t of trades) {
      t.name = names[t.avatar?.toLowerCase()] || null;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(trades));
    return;
  }

  if (req.url === "/api/leaderboard") {
    const state = readState();
    const lb = computeGivebackLeaderboard(state);
    const avatars = lb.map(e => e.avatar).filter(Boolean);
    const names = await resolveNames(avatars);
    for (const e of lb) {
      e.name = names[e.avatar?.toLowerCase()] || null;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lb));
    return;
  }

  if (req.url === "/api/logs") {
    const lines = readLogs(300);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(lines));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(DASHBOARD_HTML);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard running at http://0.0.0.0:${PORT}`);
});

// ============================================================================
// HTML
// ============================================================================
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>The Friendly Circles Arb Bot</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #fafbfc; color: #333; }

    .header { background: linear-gradient(135deg, #3c1361 0%, #6b2fa0 50%, #f178b6 100%); color: white; padding: 30px 24px 24px; }
    .header-inner { max-width: 1100px; margin: 0 auto; display: flex; align-items: center; gap: 20px; }
    .logo { width: 72px; height: 72px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.3); object-fit: cover; }
    .logo-placeholder { width: 72px; height: 72px; border-radius: 50%; border: 3px solid rgba(255,255,255,0.3); background: rgba(255,255,255,0.15); display: flex; align-items: center; justify-content: center; font-size: 36px; }
    .header h1 { font-size: 1.6em; font-weight: 700; }
    .header .tagline { font-size: 0.9em; opacity: 0.85; margin-top: 4px; }
    .header .status-pill { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 0.75em; font-weight: 600; margin-left: 12px; }
    .status-pill.online { background: #00c853; color: #fff; }
    .status-pill.offline { background: #ff5252; color: #fff; }

    .container { max-width: 1100px; margin: 0 auto; padding: 20px 24px; }

    .hero-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: -40px 0 24px; position: relative; z-index: 1; }
    .hero-card { background: white; border-radius: 12px; padding: 20px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); text-align: center; }
    .hero-card .big { font-size: 2em; font-weight: 700; color: #6b2fa0; }
    .hero-card .big.green { color: #00c853; }
    .hero-card .lbl { font-size: 0.8em; color: #888; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
    .hero-card .sub { font-size: 0.75em; color: #aaa; margin-top: 2px; }

    .tabs { display: flex; gap: 0; border-bottom: 2px solid #e0e0e0; margin-bottom: 16px; }
    .tab { padding: 10px 20px; cursor: pointer; color: #888; font-weight: 600; font-size: 0.9em; border-bottom: 2px solid transparent; margin-bottom: -2px; transition: all 0.2s; }
    .tab:hover { color: #6b2fa0; }
    .tab.active { color: #6b2fa0; border-bottom-color: #6b2fa0; }
    .section { display: none; }
    .section.active { display: block; }

    .leaderboard { background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.06); overflow: hidden; }
    .lb-row { display: flex; align-items: center; padding: 12px 20px; border-bottom: 1px solid #f0f0f0; transition: background 0.15s; }
    .lb-row:hover { background: #faf5ff; }
    .lb-rank { width: 32px; height: 32px; border-radius: 50%; background: #f0e6ff; color: #6b2fa0; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 0.85em; margin-right: 14px; flex-shrink: 0; }
    .lb-rank.gold { background: #fff3e0; color: #e65100; }
    .lb-rank.silver { background: #f5f5f5; color: #616161; }
    .lb-rank.bronze { background: #fbe9e7; color: #bf360c; }
    .lb-name { font-weight: 600; color: #333; }
    .lb-addr { font-size: 0.8em; color: #aaa; margin-left: 6px; }
    .lb-info { margin-left: auto; text-align: right; }
    .lb-crc { font-weight: 700; color: #6b2fa0; font-size: 1.1em; }
    .lb-count { font-size: 0.75em; color: #aaa; }

    table { width: 100%; border-collapse: collapse; font-size: 0.85em; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
    th { background: #f8f4fc; color: #6b2fa0; font-weight: 600; text-align: left; padding: 10px 14px; font-size: 0.8em; text-transform: uppercase; letter-spacing: 0.3px; }
    td { padding: 10px 14px; border-bottom: 1px solid #f5f5f5; }
    tr:hover td { background: #faf5ff; }
    .giveback-badge { display: inline-block; background: #e8f5e9; color: #2e7d32; padding: 2px 8px; border-radius: 10px; font-size: 0.8em; font-weight: 600; }
    .avatar-name { color: #6b2fa0; font-weight: 600; }
    .avatar-addr { color: #aaa; font-size: 0.85em; }
    a { color: #6b2fa0; text-decoration: none; }
    a:hover { text-decoration: underline; }

    #log-box { max-height: 500px; overflow-y: auto; background: #1a1a2e; padding: 14px; border-radius: 12px; font-family: 'Courier New', monospace; font-size: 0.78em; line-height: 1.6; color: #ccc; }
    .log-line { white-space: pre-wrap; word-break: break-all; }
    .log-line.trade { color: #69f0ae; font-weight: bold; }
    .log-line.error { color: #ff5252; }
    .log-line.warn { color: #ffd740; }
    .log-line.giveback { color: #ce93d8; font-weight: bold; }

    .safe-link { font-size: 0.8em; color: rgba(255,255,255,0.7); margin-top: 6px; }
    .safe-link a { color: rgba(255,255,255,0.9); }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-inner">
      <img src="/logo.png" class="logo" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="logo-placeholder" style="display:none">&#9829;</div>
      <div>
        <h1>The Friendly Circles Arb Bot <span id="bot-status" class="status-pill offline">OFFLINE</span></h1>
        <div class="tagline">Arbitraging CRC prices and giving profits back to the people</div>
        <div class="safe-link">Safe: <a href="https://gnosisscan.io/address/${SAFE}" target="_blank">${SAFE.slice(0,8)}...${SAFE.slice(-4)}</a> | <span id="updated">-</span></div>
      </div>
    </div>
  </div>

  <div class="container">
    <div class="hero-cards" id="cards"></div>

    <div class="tabs">
      <div class="tab active" data-tab="givebacks">Givebacks</div>
      <div class="tab" data-tab="trades">All Trades</div>
      <div class="tab" data-tab="logs">Logs</div>
    </div>

    <div id="givebacks" class="section active">
      <div class="leaderboard" id="leaderboard"></div>
    </div>

    <div id="trades" class="section">
      <table>
        <thead><tr><th>Time</th><th>Avatar</th><th>Spend</th><th>Profit</th><th>Giveback</th><th>TX</th></tr></thead>
        <tbody id="trades-body"></tbody>
      </table>
    </div>

    <div id="logs" class="section">
      <div id="log-box"></div>
    </div>
  </div>

  <script>
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
      });
    });

    function fmt(n, d=2) { return n != null ? Number(n).toFixed(d) : '-'; }
    function fmtAddr(a) { return a ? a.slice(0,8) + '..' + a.slice(-4) : '-'; }
    function fmtTime(t) {
      if (!t) return '-';
      const d = new Date(t);
      return d.toLocaleDateString(undefined, {month:'short',day:'numeric'}) + ' ' + d.toLocaleTimeString(undefined, {hour:'2-digit',minute:'2-digit'});
    }
    function fmtTxLink(h) {
      if (!h) return '-';
      return '<a href="https://gnosisscan.io/tx/' + h + '" target="_blank">' + h.slice(0,10) + '..</a>';
    }
    function circlesLink(avatar) { return 'https://explorer.aboutcircles.com/avatar/' + avatar; }
    function fmtAvatar(avatar, name) {
      const addr = fmtAddr(avatar);
      const link = circlesLink(avatar);
      if (name) return '<a href="' + link + '" target="_blank" class="avatar-name">' + esc(name) + '</a> <span class="avatar-addr">(' + addr + ')</span>';
      return '<a href="' + link + '" target="_blank" class="avatar-addr">' + addr + '</a>';
    }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    async function refresh() {
      try {
        const [status, trades, leaderboard, logs] = await Promise.all([
          fetch('/api/status').then(r => r.json()),
          fetch('/api/trades').then(r => r.json()),
          fetch('/api/leaderboard').then(r => r.json()),
          fetch('/api/logs').then(r => r.json()),
        ]);

        const b = status.balances || {};
        const running = status.botRunning;
        const pill = document.getElementById('bot-status');
        pill.textContent = running ? 'RUNNING' : 'OFFLINE';
        pill.className = 'status-pill ' + (running ? 'online' : 'offline');

        document.getElementById('cards').innerHTML =
          '<div class="hero-card"><div class="big green">' + fmt(status.totalCrcGivenBack, 0) + '</div><div class="lbl">CRC Given Back</div><div class="sub">to ' + status.uniqueRecipients + ' people</div></div>' +
          '<div class="hero-card"><div class="big">' + status.givebackCount + '</div><div class="lbl">Giveback Trades</div><div class="sub">of ' + status.totalTrades + ' total</div></div>' +
          '<div class="hero-card"><div class="big">' + fmt(b.sdai, 1) + '</div><div class="lbl">sDAI Balance</div><div class="sub">working capital</div></div>' +
          '<div class="hero-card"><div class="big">' + fmt(b.xdai, 2) + '</div><div class="lbl">xDAI (gas)</div><div class="sub">' + (status.universe ? status.universe.personal + ' personal, ' + status.universe.groups + ' group pools' : '-') + '</div></div>';

        // Leaderboard
        const lbEl = document.getElementById('leaderboard');
        if (leaderboard.length === 0) {
          lbEl.innerHTML = '<div style="padding:40px;text-align:center;color:#aaa">No givebacks yet. The bot will send CRC profits to arbed humans automatically.</div>';
        } else {
          lbEl.innerHTML = leaderboard.map((e, i) => {
            const rankCls = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
            const link = circlesLink(e.avatar);
            const name = e.name ? '<a href="' + link + '" target="_blank">' + esc(e.name) + '</a>' : '<a href="' + link + '" target="_blank">' + fmtAddr(e.avatar) + '</a>';
            const addrPart = e.name ? ' <span class="lb-addr">(' + fmtAddr(e.avatar) + ')</span>' : '';
            return '<div class="lb-row">' +
              '<div class="lb-rank ' + rankCls + '">' + (i+1) + '</div>' +
              '<div><span class="lb-name">' + name + '</span>' + addrPart + '</div>' +
              '<div class="lb-info"><div class="lb-crc">' + fmt(e.totalCrc, 0) + ' CRC</div><div class="lb-count">' + e.count + ' trade' + (e.count > 1 ? 's' : '') + '</div></div>' +
            '</div>';
          }).join('');
        }

        // Trades table
        document.getElementById('trades-body').innerHTML = trades.map(t => {
          const gb = t.givebackCrc > 0 ? '<span class="giveback-badge">+' + fmt(t.givebackCrc, 0) + ' CRC</span>' : '<span style="color:#ccc">-</span>';
          return '<tr>' +
            '<td>' + fmtTime(t.time) + '</td>' +
            '<td title="' + (t.avatar||'') + '">' + fmtAvatar(t.avatar, t.name) + '</td>' +
            '<td>' + fmt(t.spend, 2) + '</td>' +
            '<td>' + fmt(t.profit, 4) + '</td>' +
            '<td>' + gb + '</td>' +
            '<td>' + fmtTxLink(t.txHash) + '</td>' +
          '</tr>';
        }).join('');

        // Logs
        const logBox = document.getElementById('log-box');
        logBox.innerHTML = logs.slice().reverse().map(line => {
          let cls = 'log-line';
          if (line.includes('giveback')) cls += ' giveback';
          else if (line.includes(' \\$ ')) cls += ' trade';
          else if (line.includes(' X ') || line.includes('FAILED') || line.includes('error')) cls += ' error';
          else if (line.includes(' ! ') || line.includes('warn')) cls += ' warn';
          return '<div class="' + cls + '">' + line.replace(/</g, '&lt;') + '</div>';
        }).join('');

        document.getElementById('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
      } catch(e) {
        console.error('Refresh failed:', e);
      }
    }

    refresh();
    setInterval(refresh, 10000);
  </script>
</body>
</html>`;
