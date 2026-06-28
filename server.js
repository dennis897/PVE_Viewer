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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Proxmox View running at http://localhost:${PORT}`);
  console.log(`Monitoring: ${getHosts().join(', ')}`);
  console.log(`Refresh interval: ${REFRESH_INTERVAL}ms`);
});
