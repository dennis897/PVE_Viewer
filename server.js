require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');

const { startNotifier, sendGotify, isGotifyEnabled } = require('./notifier');

const app = express();
const PORT = process.env.PORT || 3000;
const REFRESH_INTERVAL = parseInt(process.env.REFRESH_INTERVAL) || 30000;

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

function getHosts() {
  if (process.env.PROXMOX_HOSTS) {
    return process.env.PROXMOX_HOSTS.split(',').map(h => h.trim());
  }
  return [process.env.PROXMOX_HOST];
}

const PBS_HOST = process.env.PBS_HOST;
const PBS_TOKEN_ID = process.env.PBS_TOKEN_ID;
const PBS_TOKEN_SECRET = process.env.PBS_TOKEN_SECRET;
const pbsEnabled = !!(PBS_HOST && PBS_TOKEN_ID && PBS_TOKEN_SECRET);

async function pbsApi(endpoint) {
  const url = `${PBS_HOST}/api2/json${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `PBSAPIToken=${PBS_TOKEN_ID}:${PBS_TOKEN_SECRET}`
    },
    agent: httpsAgent
  });
  if (!res.ok) {
    throw new Error(`PBS API error: ${res.status} ${res.statusText} for ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

async function fetchPbsData() {
  if (!pbsEnabled) return null;

  const [datastores, nodeStatus, tasks] = await Promise.all([
    pbsApi('/admin/datastore').catch(e => { console.error('PBS datastores error:', e.message); return []; }),
    pbsApi('/nodes/localhost/status').catch(e => { console.error('PBS node status error:', e.message); return null; }),
    pbsApi('/nodes/localhost/tasks?limit=50&typefilter=backup').catch(e => { console.error('PBS tasks error:', e.message); return []; })
  ]);

  const datastoreDetails = await Promise.all(
    datastores.map(async (ds) => {
      const [status, snapshots] = await Promise.all([
        pbsApi(`/admin/datastore/${ds.store}/status`).catch(e => { console.error(`PBS datastore ${ds.store} status error:`, e.message); return null; }),
        pbsApi(`/admin/datastore/${ds.store}/snapshots`).catch(e => { console.error(`PBS datastore ${ds.store} snapshots error:`, e.message); return []; })
      ]);

      const guestBackups = {};
      for (const snap of snapshots) {
        const id = snap['backup-id'];
        const type = snap['backup-type'];
        const time = snap['backup-time'];
        const size = snap.size || 0;
        const key = `${type}/${id}`;

        if (!guestBackups[key] || time > guestBackups[key].lastBackup) {
          guestBackups[key] = {
            id,
            type,
            lastBackup: time,
            size,
            count: (guestBackups[key]?.count || 0) + 1
          };
        } else {
          guestBackups[key].count++;
        }
      }

      return {
        store: ds.store,
        comment: ds.comment,
        status,
        totalSnapshots: snapshots.length,
        guestBackups: Object.values(guestBackups).sort((a, b) => b.lastBackup - a.lastBackup)
      };
    })
  );

  const recentTasks = tasks.map(t => ({
    upid: t.upid,
    type: t.worker_type,
    id: t.worker_id,
    status: t.status,
    startTime: t.starttime,
    endTime: t.endtime,
    duration: t.endtime && t.starttime ? t.endtime - t.starttime : null
  }));

  return {
    host: PBS_HOST,
    nodeStatus: nodeStatus ? {
      uptime: nodeStatus.uptime,
      cpu: nodeStatus.cpu,
      cpuCount: nodeStatus.cpuinfo?.cpus || 0,
      mem: nodeStatus.memory?.used || 0,
      maxmem: nodeStatus.memory?.total || 0
    } : null,
    datastores: datastoreDetails,
    recentTasks
  };
}

async function pveApi(host, endpoint) {
  const url = `${host}/api2/json${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `PVEAPIToken=${process.env.PROXMOX_TOKEN_ID}=${process.env.PROXMOX_TOKEN_SECRET}`
    },
    agent: httpsAgent
  });
  if (!res.ok) {
    throw new Error(`Proxmox API error: ${res.status} ${res.statusText} for ${endpoint}`);
  }
  const json = await res.json();
  return json.data;
}

async function fetchHostData(host) {
  const nodes = await pveApi(host, '/nodes');
  const hostData = {
    host,
    nodes: []
  };

  for (const node of nodes) {
    const [nodeStatus, vms, lxcs, storages] = await Promise.all([
      pveApi(host, `/nodes/${node.node}/status`),
      pveApi(host, `/nodes/${node.node}/qemu`),
      pveApi(host, `/nodes/${node.node}/lxc`),
      pveApi(host, `/nodes/${node.node}/storage`)
    ]);

    const vmDetails = await Promise.all(
      vms.map(vm =>
        pveApi(host, `/nodes/${node.node}/qemu/${vm.vmid}/status/current`)
          .catch(() => vm)
      )
    );

    const lxcDetails = await Promise.all(
      lxcs.map(ct =>
        pveApi(host, `/nodes/${node.node}/lxc/${ct.vmid}/status/current`)
          .catch(() => ct)
      )
    );

    hostData.nodes.push({
      name: node.node,
      status: node.status,
      uptime: node.uptime,
      cpu: node.cpu,
      maxcpu: node.maxcpu,
      mem: node.mem,
      maxmem: node.maxmem,
      nodeStatus,
      vms: vmDetails,
      lxcs: lxcDetails,
      storages
    });
  }

  return hostData;
}

function parseSize(str) {
  const num = parseFloat(str);
  if (str.endsWith('T')) return num * 1024 * 1024 * 1024 * 1024;
  if (str.endsWith('G')) return num * 1024 * 1024 * 1024;
  if (str.endsWith('M')) return num * 1024 * 1024;
  if (str.endsWith('K')) return num * 1024;
  return num * 1024 * 1024 * 1024;
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const hosts = getHosts();
    const [results, pbsData] = await Promise.all([
      Promise.all(hosts.map(fetchHostData)),
      fetchPbsData().catch(err => { console.error('PBS fetch error:', err.message); return null; })
    ]);
    res.json({
      hosts: results,
      pbs: pbsData,
      refreshInterval: REFRESH_INTERVAL,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('API fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/guest/:node/:type/:vmid', async (req, res) => {
  try {
    const { node, type, vmid } = req.params;
    const host = getHosts()[0];
    const endpoint = type === 'qemu' ? 'qemu' : 'lxc';

    const [config, status, snapshots, rrdHour, rrdDay] = await Promise.all([
      pveApi(host, `/nodes/${node}/${endpoint}/${vmid}/config`),
      pveApi(host, `/nodes/${node}/${endpoint}/${vmid}/status/current`),
      pveApi(host, `/nodes/${node}/${endpoint}/${vmid}/snapshot`).catch(() => []),
      pveApi(host, `/nodes/${node}/${endpoint}/${vmid}/rrddata?timeframe=hour`).catch(() => []),
      pveApi(host, `/nodes/${node}/${endpoint}/${vmid}/rrddata?timeframe=day`).catch(() => [])
    ]);

    res.json({ config, status, snapshots, rrdHour, rrdDay });
  } catch (err) {
    console.error('Guest detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/storage/:node/:storage', async (req, res) => {
  try {
    const { node, storage } = req.params;
    const host = getHosts()[0];

    const [status, content, vms, lxcs, rrdHour, zfsPools, storageConfig] = await Promise.all([
      pveApi(host, `/nodes/${node}/storage/${storage}/status`),
      pveApi(host, `/nodes/${node}/storage/${storage}/content`).catch(() => []),
      pveApi(host, `/nodes/${node}/qemu`),
      pveApi(host, `/nodes/${node}/lxc`),
      pveApi(host, `/nodes/${node}/storage/${storage}/rrddata?timeframe=day`).catch(() => []),
      pveApi(host, `/nodes/${node}/disks/zfs`).catch(() => []),
      pveApi(host, `/storage/${storage}`).catch(() => null)
    ]);

    // For ZFS pools, get pool health and device layout
    let zfsDetail = null;
    if (status.type === 'zfspool' && Array.isArray(zfsPools)) {
      const poolMatch = zfsPools.find(p => p.name === storage || storage.startsWith(p.name));
      const zfsName = poolMatch ? poolMatch.name : storage;
      const poolInfo = await pveApi(host, `/nodes/${node}/disks/zfs/${zfsName}`).catch(() => null);
      if (poolInfo) {
        // Flatten the vdev tree to extract disk devices
        const devices = [];
        function walkVdevs(nodes) {
          if (!Array.isArray(nodes)) return;
          for (const n of nodes) {
            if (n.leaf) {
              devices.push({ name: n.name, state: n.msg || n.state || 'ONLINE' });
            }
            if (n.children) walkVdevs(n.children);
          }
        }
        walkVdevs(poolInfo.children);

        zfsDetail = {
          name: poolInfo.name || zfsName,
          state: poolInfo.state || poolMatch?.health || 'UNKNOWN',
          scan: poolInfo.scan || null,
          action: poolInfo.action || null,
          errors: poolInfo.errors || null,
          devices
        };
      }
    }

    const vmConfigs = await Promise.all(
      vms.map(vm =>
        pveApi(host, `/nodes/${node}/qemu/${vm.vmid}/config`)
          .then(cfg => ({ vmid: vm.vmid, name: vm.name, status: vm.status, type: 'qemu', config: cfg }))
          .catch(() => null)
      )
    );

    const lxcConfigs = await Promise.all(
      lxcs.map(ct =>
        pveApi(host, `/nodes/${node}/lxc/${ct.vmid}/config`)
          .then(cfg => ({ vmid: ct.vmid, name: ct.name, status: ct.status, type: 'lxc', config: cfg }))
          .catch(() => null)
      )
    );

    const allGuests = [...vmConfigs, ...lxcConfigs].filter(Boolean);
    const dependents = [];
    for (const guest of allGuests) {
      const cfg = guest.config;
      const disksOnStorage = [];
      for (const [key, val] of Object.entries(cfg)) {
        if (typeof val !== 'string') continue;
        if (!val.includes(`${storage}:`)) continue;
        const sizeMatch = val.match(/size=(\d+[GMTK]?)/i);
        let sizeBytes = 0;
        if (sizeMatch) {
          sizeBytes = parseSize(sizeMatch[1]);
        }
        disksOnStorage.push({ key, value: val, size: sizeBytes });
      }
      if (disksOnStorage.length > 0) {
        const totalAllocated = disksOnStorage.reduce((sum, d) => sum + d.size, 0);
        dependents.push({
          vmid: guest.vmid,
          name: guest.name,
          status: guest.status,
          type: guest.type,
          disks: disksOnStorage,
          totalAllocated
        });
      }
    }

    // For ZFS/pools where content API returns empty, fetch actual disk usage from guest status
    const guestUsage = await Promise.all(
      dependents.map(async (dep) => {
        try {
          const endpoint = dep.type === 'qemu' ? 'qemu' : 'lxc';
          const guestStatus = await pveApi(host, `/nodes/${node}/${endpoint}/${dep.vmid}/status/current`);
          return {
            ...dep,
            actualDisk: guestStatus.disk || 0,
            maxDisk: guestStatus.maxdisk || 0
          };
        } catch {
          return dep;
        }
      })
    );

    res.json({ status, content, dependents: guestUsage, rrdHour, zfsDetail, storageConfig });
  } catch (err) {
    console.error('Storage detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/notifier/status', (req, res) => {
  res.json({ enabled: isGotifyEnabled() });
});

app.post('/api/notifier/test', async (req, res) => {
  if (!isGotifyEnabled()) {
    return res.status(400).json({ error: 'Gotify not configured' });
  }
  try {
    await sendGotify('Test Notification', 'PVE Viewer notification system is working.', 5);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxmox View running at http://localhost:${PORT}`);
  console.log(`Monitoring: ${getHosts().join(', ')}`);
  if (pbsEnabled) console.log(`PBS: ${PBS_HOST}`);
  console.log(`Refresh interval: ${REFRESH_INTERVAL}ms`);
  startNotifier(fetchHostData, getHosts, pveApi);
});
