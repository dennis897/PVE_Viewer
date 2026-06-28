require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');

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
    const results = await Promise.all(hosts.map(fetchHostData));
    res.json({
      hosts: results,
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

    const [status, content, vms, lxcs, rrdHour, zfsPools] = await Promise.all([
      pveApi(host, `/nodes/${node}/storage/${storage}/status`),
      pveApi(host, `/nodes/${node}/storage/${storage}/content`).catch(() => []),
      pveApi(host, `/nodes/${node}/qemu`),
      pveApi(host, `/nodes/${node}/lxc`),
      pveApi(host, `/nodes/${node}/storage/${storage}/rrddata?timeframe=day`).catch(() => []),
      pveApi(host, `/nodes/${node}/disks/zfs`).catch(() => [])
    ]);

    // For ZFS pools, get dataset-level detail
    let zfsDetail = null;
    if (status.type === 'zfspool' && Array.isArray(zfsPools)) {
      const poolName = zfsPools.find(p => p.name === storage || storage.startsWith(p.name));
      const zfsName = poolName ? poolName.name : storage;
      zfsDetail = await pveApi(host, `/nodes/${node}/disks/zfs/${zfsName}`).catch(() => null);
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

    res.json({ status, content, dependents: guestUsage, rrdHour, zfsDetail });
  } catch (err) {
    console.error('Storage detail error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxmox View running at http://localhost:${PORT}`);
  console.log(`Monitoring: ${getHosts().join(', ')}`);
  console.log(`Refresh interval: ${REFRESH_INTERVAL}ms`);
});
