const fs = require('fs');
const http = require('http');
const https = require('https');

// Docker Engine API client.
//
// Two modes:
//   - Unix socket (default): the dashboard runs on the Docker host itself
//     (VM 102), so /var/run/docker.sock is bind-mounted in.
//   - HTTP: set DOCKER_API_URL to a TCP endpoint, e.g. a docker-socket-proxy.
//
// Only read endpoints are used — this module never starts, stops or changes
// anything.

const SOCKET_PATH = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const API_URL = process.env.DOCKER_API_URL || '';
const HOST_LABEL = process.env.DOCKER_HOST_LABEL || 'Docker Host';
const STATS_ENABLED = process.env.DOCKER_STATS !== 'false';

function detectEnabled() {
  if (process.env.DOCKER_ENABLED === 'false') return false;
  if (API_URL) return true;
  try {
    return fs.statSync(SOCKET_PATH).isSocket();
  } catch {
    return false;
  }
}

const enabled = detectEnabled();

function requestOptions(endpoint) {
  if (API_URL) {
    const url = new URL(API_URL);
    return {
      mod: url.protocol === 'https:' ? https : http,
      opts: {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: endpoint,
        method: 'GET',
        rejectUnauthorized: false
      }
    };
  }
  return {
    mod: http,
    opts: { socketPath: SOCKET_PATH, path: endpoint, method: 'GET' }
  };
}

function dockerRaw(endpoint, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const { mod, opts } = requestOptions(endpoint);
    const req = mod.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(`Docker API ${res.statusCode} for ${endpoint}: ${body.toString('utf8').slice(0, 200)}`));
        } else {
          resolve(body);
        }
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy(new Error(`Docker API timeout for ${endpoint}`));
    });
    req.on('error', reject);
    req.end();
  });
}

async function dockerApi(endpoint, timeout) {
  const body = await dockerRaw(endpoint, timeout);
  if (!body.length) return null;
  return JSON.parse(body.toString('utf8'));
}

// Docker multiplexes stdout/stderr with an 8-byte frame header unless the
// container was created with a TTY, in which case the stream is plain text.
function demuxLogs(buf) {
  const lines = [];
  let offset = 0;
  const looksFramed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString('utf8');

  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset + 4);
    const chunk = buf.slice(offset + 8, offset + 8 + len);
    lines.push(chunk.toString('utf8'));
    offset += 8 + len;
  }
  return lines.join('');
}

function cpuPercent(stats) {
  const cpu = stats?.cpu_stats;
  const pre = stats?.precpu_stats;
  if (!cpu?.cpu_usage || !pre?.cpu_usage) return null;
  const cpuDelta = cpu.cpu_usage.total_usage - pre.cpu_usage.total_usage;
  const sysDelta = (cpu.system_cpu_usage || 0) - (pre.system_cpu_usage || 0);
  if (cpuDelta <= 0 || sysDelta <= 0) return 0;
  const cores = cpu.online_cpus || cpu.cpu_usage.percpu_usage?.length || 1;
  return (cpuDelta / sysDelta) * cores * 100;
}

function memUsage(stats) {
  const mem = stats?.memory_stats;
  if (!mem || !mem.usage) return { used: 0, limit: 0 };
  // cgroup v2 reports inactive_file, v1 reports cache — both are page cache
  // that Docker itself subtracts when computing `docker stats` output.
  const cache = mem.stats?.inactive_file ?? mem.stats?.cache ?? 0;
  return { used: Math.max(0, mem.usage - cache), limit: mem.limit || 0 };
}

function netTotals(stats) {
  const nets = stats?.networks;
  if (!nets) return { rx: 0, tx: 0 };
  let rx = 0, tx = 0;
  for (const n of Object.values(nets)) {
    rx += n.rx_bytes || 0;
    tx += n.tx_bytes || 0;
  }
  return { rx, tx };
}

function formatPorts(ports) {
  if (!Array.isArray(ports)) return [];
  const seen = new Set();
  const out = [];
  for (const p of ports) {
    const key = p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}/${p.Type}` : `${p.PrivatePort}/${p.Type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      host: p.PublicPort || null,
      container: p.PrivatePort,
      type: p.Type
    });
  }
  return out.sort((a, b) => (b.host ? 1 : 0) - (a.host ? 1 : 0) || (a.host || a.container) - (b.host || b.container));
}

function healthFromStatus(status) {
  const m = /\((healthy|unhealthy|health: starting)\)/.exec(status || '');
  if (!m) return null;
  return m[1] === 'health: starting' ? 'starting' : m[1];
}

function shortImage(image) {
  // Strip the sha256 form Docker sometimes reports for untagged local builds.
  if (image.startsWith('sha256:')) return image.slice(7, 19);
  return image;
}

async function fetchDockerData() {
  if (!enabled) return null;

  const [version, info, containers] = await Promise.all([
    dockerApi('/version').catch(() => null),
    dockerApi('/info').catch(() => null),
    dockerApi('/containers/json?all=1')
  ]);

  const running = containers.filter(c => c.State === 'running');

  // Stats are only meaningful for running containers, and each call costs a
  // ~1s sample window on the daemon side — so they run in parallel and any
  // failure degrades to "no stats" rather than failing the whole request.
  const statsById = {};
  if (STATS_ENABLED) {
    await Promise.all(
      running.map(async c => {
        try {
          statsById[c.Id] = await dockerApi(`/containers/${c.Id}/stats?stream=false`, 15000);
        } catch {
          statsById[c.Id] = null;
        }
      })
    );
  }

  const mapped = containers.map(c => {
    const labels = c.Labels || {};
    const stats = statsById[c.Id] || null;
    const mem = memUsage(stats);
    const net = netTotals(stats);
    const cpu = cpuPercent(stats);

    return {
      id: c.Id.slice(0, 12),
      name: (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, ''),
      image: shortImage(c.Image || ''),
      state: c.State,
      status: c.Status,
      health: healthFromStatus(c.Status),
      created: c.Created,
      stack: labels['com.docker.compose.project'] || null,
      service: labels['com.docker.compose.service'] || null,
      networks: Object.keys(c.NetworkSettings?.Networks || {}),
      ports: formatPorts(c.Ports),
      cpu: cpu === null ? null : Math.round(cpu * 10) / 10,
      mem: mem.used,
      memLimit: mem.limit,
      netIn: net.rx,
      netOut: net.tx
    };
  });

  // Group by compose project. Containers started outside compose (plain
  // `docker run`) have no project label and land in a catch-all group.
  const stackMap = {};
  for (const c of mapped) {
    const key = c.stack || '(standalone)';
    if (!stackMap[key]) stackMap[key] = { name: key, managed: !!c.stack, containers: [] };
    stackMap[key].containers.push(c);
  }

  const stacks = Object.values(stackMap)
    .map(s => ({
      ...s,
      containers: s.containers.sort((a, b) => {
        if (a.state === 'running' && b.state !== 'running') return -1;
        if (a.state !== 'running' && b.state === 'running') return 1;
        return a.name.localeCompare(b.name);
      }),
      running: s.containers.filter(c => c.state === 'running').length
    }))
    .sort((a, b) => {
      if (a.managed !== b.managed) return a.managed ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

  return {
    label: HOST_LABEL,
    source: API_URL || SOCKET_PATH,
    version: version ? { version: version.Version, apiVersion: version.ApiVersion } : null,
    info: info ? {
      name: info.Name,
      os: info.OperatingSystem,
      kernel: info.KernelVersion,
      cpus: info.NCPU,
      memTotal: info.MemTotal,
      images: info.Images,
      containers: info.Containers,
      running: info.ContainersRunning,
      stopped: info.ContainersStopped,
      paused: info.ContainersPaused
    } : null,
    totals: {
      containers: mapped.length,
      running: running.length,
      stopped: mapped.length - running.length,
      unhealthy: mapped.filter(c => c.health === 'unhealthy').length,
      cpu: mapped.reduce((sum, c) => sum + (c.cpu || 0), 0),
      mem: mapped.reduce((sum, c) => sum + (c.mem || 0), 0)
    },
    stacks,
    statsAvailable: STATS_ENABLED
  };
}

async function fetchContainerDetail(id, tail = 200) {
  if (!enabled) return null;

  const [inspect, logs] = await Promise.all([
    dockerApi(`/containers/${id}/json`),
    dockerRaw(`/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${tail}`)
      .then(demuxLogs)
      .catch(err => `Could not read logs: ${err.message}`)
  ]);

  const labels = inspect.Config?.Labels || {};

  const mounts = (inspect.Mounts || []).map(m => ({
    type: m.Type,
    source: m.Name || m.Source,
    destination: m.Destination,
    mode: m.RW ? 'rw' : 'ro'
  }));

  const netSettings = inspect.NetworkSettings?.Networks || {};
  const networks = Object.entries(netSettings).map(([name, n]) => ({
    name,
    ip: n.IPAddress || null,
    gateway: n.Gateway || null
  }));

  const portBindings = [];
  for (const [container, bindings] of Object.entries(inspect.NetworkSettings?.Ports || {})) {
    if (!bindings) {
      portBindings.push({ container, host: null });
      continue;
    }
    const hosts = [...new Set(bindings.map(b => b.HostPort))];
    portBindings.push({ container, host: hosts.join(', ') });
  }

  return {
    id: inspect.Id.slice(0, 12),
    name: (inspect.Name || '').replace(/^\//, ''),
    image: inspect.Config?.Image || '',
    imageId: shortImage(inspect.Image || ''),
    command: [inspect.Path, ...(inspect.Args || [])].join(' ').trim(),
    created: inspect.Created,
    state: inspect.State?.Status,
    startedAt: inspect.State?.StartedAt,
    finishedAt: inspect.State?.FinishedAt,
    exitCode: inspect.State?.ExitCode,
    error: inspect.State?.Error || null,
    restartCount: inspect.RestartCount || 0,
    restartPolicy: inspect.HostConfig?.RestartPolicy?.Name || 'no',
    health: inspect.State?.Health ? {
      status: inspect.State.Health.Status,
      failingStreak: inspect.State.Health.FailingStreak,
      lastLog: inspect.State.Health.Log?.slice(-1)[0]?.Output || null
    } : null,
    stack: labels['com.docker.compose.project'] || null,
    service: labels['com.docker.compose.service'] || null,
    memLimit: inspect.HostConfig?.Memory || 0,
    cpuLimit: inspect.HostConfig?.NanoCpus ? inspect.HostConfig.NanoCpus / 1e9 : 0,
    networks,
    portBindings,
    mounts,
    logs
  };
}

module.exports = {
  dockerEnabled: enabled,
  dockerSource: API_URL || SOCKET_PATH,
  fetchDockerData,
  fetchContainerDetail
};
