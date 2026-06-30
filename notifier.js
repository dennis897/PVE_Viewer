const fetch = require('node-fetch');
const https = require('https');

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

const GOTIFY_URL = process.env.GOTIFY_URL;
const GOTIFY_TOKEN = process.env.GOTIFY_TOKEN;
const NOTIFY_INTERVAL = parseInt(process.env.NOTIFY_INTERVAL) || 60000;
const NOTIFY_COOLDOWN = parseInt(process.env.NOTIFY_COOLDOWN) || 900000;
const CPU_SUSTAIN_MINUTES = parseInt(process.env.CPU_SUSTAIN_MINUTES) || 60;

const THRESHOLDS = {
  guestMemory: 0.90,
  guestCpu: 0.90,
  guestSwap: 0.90,
  guestDisk: 0.95,
  nodeMemory: 0.90,
  nodeCpu: 0.90,
  storage: 0.95,
};

const state = {
  guestStatus: {},
  cpuHistory: {},
  lastNotified: {},
};

function alertKey(type, id) {
  return `${type}:${id}`;
}

function canNotify(key) {
  const last = state.lastNotified[key];
  if (!last) return true;
  return Date.now() - last >= NOTIFY_COOLDOWN;
}

function markNotified(key) {
  state.lastNotified[key] = Date.now();
}

function clearNotified(key) {
  delete state.lastNotified[key];
}

async function sendGotify(title, message, priority = 5) {
  if (!GOTIFY_URL || !GOTIFY_TOKEN) return;
  try {
    const url = `${GOTIFY_URL}/message?token=${GOTIFY_TOKEN}`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: `PVE: ${title}`,
        message,
        priority,
        extras: { 'client::display': { contentType: 'text/plain' } }
      })
    });
  } catch (err) {
    console.error('Gotify send error:', err.message);
  }
}

function pct(used, max) {
  if (!max) return 0;
  return used / max;
}

function fmtPct(ratio) {
  return (ratio * 100).toFixed(1) + '%';
}

function fmtBytes(bytes) {
  if (bytes >= 1099511627776) return (bytes / 1099511627776).toFixed(1) + ' TB';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function trackCpu(id, cpuRatio) {
  const now = Date.now();
  if (!state.cpuHistory[id]) state.cpuHistory[id] = [];
  state.cpuHistory[id].push({ time: now, cpu: cpuRatio });
  const cutoff = now - (CPU_SUSTAIN_MINUTES * 60 * 1000);
  state.cpuHistory[id] = state.cpuHistory[id].filter(e => e.time >= cutoff);
}

function isCpuSustained(id) {
  const history = state.cpuHistory[id];
  if (!history || history.length < 2) return false;
  const window = CPU_SUSTAIN_MINUTES * 60 * 1000;
  const span = history[history.length - 1].time - history[0].time;
  if (span < window * 0.9) return false;
  return history.every(e => e.cpu >= THRESHOLDS.guestCpu);
}

async function checkAlerts(fetchHostData, getHosts, pveApi) {
  const alerts = [];

  try {
    const hosts = getHosts();
    const results = await Promise.all(hosts.map(fetchHostData));

    for (const hostData of results) {
      for (const node of hostData.nodes) {
        const nodeId = `${hostData.host}/${node.name}`;

        if (node.status !== 'online') {
          const key = alertKey('node-down', nodeId);
          if (canNotify(key)) {
            alerts.push({ title: 'Node Offline', message: `Node ${node.name} is ${node.status}`, priority: 8 });
            markNotified(key);
          }
        } else {
          const downKey = alertKey('node-down', nodeId);
          if (state.lastNotified[downKey]) {
            alerts.push({ title: 'Node Recovered', message: `Node ${node.name} is back online`, priority: 3 });
            clearNotified(downKey);
          }
        }

        const nodeMemPct = pct(node.mem, node.maxmem);
        if (nodeMemPct >= THRESHOLDS.nodeMemory) {
          const key = alertKey('node-mem', nodeId);
          if (canNotify(key)) {
            alerts.push({
              title: 'Node Memory Critical',
              message: `${node.name}: ${fmtPct(nodeMemPct)} memory used (${fmtBytes(node.mem)} / ${fmtBytes(node.maxmem)})`,
              priority: 7
            });
            markNotified(key);
          }
        }

        trackCpu(nodeId, node.cpu);
        if (isCpuSustained(nodeId)) {
          const key = alertKey('node-cpu', nodeId);
          if (canNotify(key)) {
            alerts.push({
              title: 'Node CPU Sustained High',
              message: `${node.name}: CPU above ${fmtPct(THRESHOLDS.nodeCpu)} for ${CPU_SUSTAIN_MINUTES}+ minutes (current: ${fmtPct(node.cpu)})`,
              priority: 7
            });
            markNotified(key);
          }
        }

        const allGuests = [
          ...node.vms.map(g => ({ ...g, gtype: 'VM' })),
          ...node.lxcs.map(g => ({ ...g, gtype: 'LXC' }))
        ];

        for (const guest of allGuests) {
          const guestId = `${nodeId}/${guest.gtype}-${guest.vmid}`;
          const label = `${guest.gtype} ${guest.vmid} (${guest.name || 'unnamed'})`;
          const prevStatus = state.guestStatus[guestId];

          if (prevStatus === 'running' && guest.status !== 'running') {
            const key = alertKey('guest-down', guestId);
            if (canNotify(key)) {
              alerts.push({
                title: `${guest.gtype} Down`,
                message: `${label} on ${node.name} is now ${guest.status}`,
                priority: 7
              });
              markNotified(key);
            }
          }

          if (prevStatus && prevStatus !== 'running' && guest.status === 'running') {
            const downKey = alertKey('guest-down', guestId);
            if (state.lastNotified[downKey]) {
              alerts.push({
                title: `${guest.gtype} Recovered`,
                message: `${label} on ${node.name} is running again`,
                priority: 3
              });
              clearNotified(downKey);
            }
          }

          state.guestStatus[guestId] = guest.status;

          if (guest.status !== 'running') continue;

          const memPct = pct(guest.mem, guest.maxmem);
          if (memPct >= THRESHOLDS.guestMemory) {
            const key = alertKey('guest-mem', guestId);
            if (canNotify(key)) {
              alerts.push({
                title: `${guest.gtype} Memory Critical`,
                message: `${label}: ${fmtPct(memPct)} memory (${fmtBytes(guest.mem)} / ${fmtBytes(guest.maxmem)})`,
                priority: 6
              });
              markNotified(key);
            }
          }

          trackCpu(guestId, guest.cpu);
          if (isCpuSustained(guestId)) {
            const key = alertKey('guest-cpu', guestId);
            if (canNotify(key)) {
              alerts.push({
                title: `${guest.gtype} CPU Sustained High`,
                message: `${label}: CPU above ${fmtPct(THRESHOLDS.guestCpu)} for ${CPU_SUSTAIN_MINUTES}+ minutes (current: ${fmtPct(guest.cpu)})`,
                priority: 6
              });
              markNotified(key);
            }
          }

          if (guest.maxswap > 0) {
            const swapPct = pct(guest.swap, guest.maxswap);
            if (swapPct >= THRESHOLDS.guestSwap) {
              const key = alertKey('guest-swap', guestId);
              if (canNotify(key)) {
                alerts.push({
                  title: `${guest.gtype} Swap Critical`,
                  message: `${label}: ${fmtPct(swapPct)} swap used (${fmtBytes(guest.swap)} / ${fmtBytes(guest.maxswap)})`,
                  priority: 6
                });
                markNotified(key);
              }
            }
          }

          if (guest.maxdisk > 0) {
            const diskPct = pct(guest.disk, guest.maxdisk);
            if (diskPct >= THRESHOLDS.guestDisk) {
              const key = alertKey('guest-disk', guestId);
              if (canNotify(key)) {
                alerts.push({
                  title: `${guest.gtype} Disk Critical`,
                  message: `${label}: ${fmtPct(diskPct)} disk used (${fmtBytes(guest.disk)} / ${fmtBytes(guest.maxdisk)})`,
                  priority: 6
                });
                markNotified(key);
              }
            }
          }
        }

        for (const stor of node.storages) {
          if (!stor.active) continue;
          const storId = `${nodeId}/${stor.storage}`;
          const storPct = pct(stor.used, stor.total);
          if (storPct >= THRESHOLDS.storage) {
            const key = alertKey('storage', storId);
            if (canNotify(key)) {
              alerts.push({
                title: 'Storage Critical',
                message: `${stor.storage} on ${node.name}: ${fmtPct(storPct)} full (${fmtBytes(stor.used)} / ${fmtBytes(stor.total)})`,
                priority: 7
              });
              markNotified(key);
            }
          }
        }

        try {
          const zfsPools = await pveApi(hostData.host, `/nodes/${node.name}/disks/zfs`);
          if (Array.isArray(zfsPools)) {
            for (const pool of zfsPools) {
              if (pool.health && pool.health !== 'ONLINE') {
                const key = alertKey('zfs', `${nodeId}/${pool.name}`);
                if (canNotify(key)) {
                  alerts.push({
                    title: 'ZFS Pool Degraded',
                    message: `ZFS pool ${pool.name} on ${node.name}: ${pool.health}`,
                    priority: 8
                  });
                  markNotified(key);
                }
              }
            }
          }
        } catch (_) {}
      }
    }
  } catch (err) {
    console.error('Notification check error:', err.message);
  }

  for (const alert of alerts) {
    await sendGotify(alert.title, alert.message, alert.priority);
  }

  if (alerts.length > 0) {
    console.log(`[Notifier] Sent ${alerts.length} alert(s)`);
  }
}

function startNotifier(fetchHostData, getHosts, pveApi) {
  if (!GOTIFY_URL || !GOTIFY_TOKEN) {
    console.log('[Notifier] Disabled — GOTIFY_URL and GOTIFY_TOKEN not set');
    return;
  }

  console.log(`[Notifier] Enabled — checking every ${NOTIFY_INTERVAL / 1000}s, cooldown ${NOTIFY_COOLDOWN / 1000}s`);
  console.log(`[Notifier] CPU sustained threshold: ${CPU_SUSTAIN_MINUTES} minutes`);
  console.log(`[Notifier] Gotify: ${GOTIFY_URL}`);

  setTimeout(() => {
    checkAlerts(fetchHostData, getHosts, pveApi).catch(err => {
      console.error('[Notifier] Initial check error:', err.message);
    });
  }, 5000);

  setInterval(() => {
    checkAlerts(fetchHostData, getHosts, pveApi).catch(err => {
      console.error('[Notifier] Check error:', err.message);
    });
  }, NOTIFY_INTERVAL);
}

module.exports = { startNotifier };
