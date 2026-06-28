let refreshInterval = 30000;
let refreshTimer = null;

async function fetchData() {
  const indicator = document.getElementById('status-indicator');
  indicator.className = 'status-dot loading';

  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    refreshInterval = data.refreshInterval || 30000;
    render(data);
    indicator.className = 'status-dot';
    hideError();
  } catch (err) {
    indicator.className = 'status-dot error';
    showError(`Connection failed: ${err.message}`);
  }

  scheduleRefresh();
}

function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(fetchData, refreshInterval);
}

function showError(msg) {
  const banner = document.getElementById('error-banner');
  banner.textContent = msg;
  banner.classList.remove('hidden');
}

function hideError() {
  document.getElementById('error-banner').classList.add('hidden');
}

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatUptime(seconds) {
  if (!seconds) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function pct(used, total) {
  if (!total) return 0;
  return Math.round((used / total) * 100);
}

function progressColor(percent) {
  if (percent >= 90) return 'red';
  if (percent >= 75) return 'orange';
  if (percent >= 50) return 'yellow';
  return 'green';
}

function progressBar(percent) {
  const color = progressColor(percent);
  return `<div class="progress-bar"><div class="progress-fill ${color}" style="width:${percent}%"></div></div>`;
}

function renderOverviewCards(node) {
  const cpuPct = Math.round((node.cpu || 0) * 100);
  const memPct = pct(node.mem, node.maxmem);
  const runningVms = node.vms.filter(v => v.status === 'running').length;
  const runningLxcs = node.lxcs.filter(c => c.status === 'running').length;
  const totalGuests = node.vms.length + node.lxcs.length;
  const runningGuests = runningVms + runningLxcs;

  return `
    <div class="overview-grid">
      <div class="overview-card">
        <div class="label">CPU</div>
        <div class="value">${cpuPct}%</div>
        <div class="sub">${node.maxcpu || '—'} cores</div>
        ${progressBar(cpuPct)}
      </div>
      <div class="overview-card">
        <div class="label">Memory</div>
        <div class="value">${memPct}%</div>
        <div class="sub">${formatBytes(node.mem)} / ${formatBytes(node.maxmem)}</div>
        ${progressBar(memPct)}
      </div>
      <div class="overview-card">
        <div class="label">Guests</div>
        <div class="value">${runningGuests} <span style="font-size:14px;color:var(--text-dim)">/ ${totalGuests}</span></div>
        <div class="sub">${runningVms} VMs, ${runningLxcs} LXCs running</div>
      </div>
      <div class="overview-card">
        <div class="label">Uptime</div>
        <div class="value">${formatUptime(node.uptime)}</div>
        <div class="sub">${node.status === 'online' ? 'Online' : 'Offline'}</div>
      </div>
    </div>
  `;
}

function renderGuestCard(guest, type) {
  const isRunning = guest.status === 'running';
  const cpuPct = isRunning ? Math.round((guest.cpu || 0) * 100) : 0;
  const memPct = isRunning ? pct(guest.mem, guest.maxmem) : 0;
  const diskPct = pct(guest.disk, guest.maxdisk);
  const netIn = guest.netin || 0;
  const netOut = guest.netout || 0;

  return `
    <div class="guest-card">
      <div class="guest-card-header">
        <div class="guest-name">
          <div class="guest-icon ${type}">${type === 'vm' ? '⊞' : '⊡'}</div>
          <div class="guest-name-text">
            <strong>${guest.name || `${type.toUpperCase()} ${guest.vmid}`}</strong>
            <span class="vmid">${type.toUpperCase()} ${guest.vmid}</span>
          </div>
        </div>
        <span class="guest-status ${guest.status}">${guest.status}</span>
      </div>
      ${isRunning ? `
        <div class="guest-metrics">
          <div class="metric">
            <div class="metric-header">
              <span class="metric-label">CPU</span>
              <span class="metric-value">${cpuPct}%</span>
            </div>
            ${progressBar(cpuPct)}
          </div>
          <div class="metric">
            <div class="metric-header">
              <span class="metric-label">Memory</span>
              <span class="metric-value">${memPct}%</span>
            </div>
            ${progressBar(memPct)}
          </div>
          <div class="metric">
            <div class="metric-header">
              <span class="metric-label">Disk</span>
              <span class="metric-value">${formatBytes(guest.disk)} / ${formatBytes(guest.maxdisk)}</span>
            </div>
            ${progressBar(diskPct)}
          </div>
          <div class="metric">
            <div class="metric-header">
              <span class="metric-label">Network</span>
              <span class="metric-value">↓${formatBytes(netIn)} ↑${formatBytes(netOut)}</span>
            </div>
          </div>
        </div>
      ` : `
        <div class="guest-metrics">
          <div class="metric" style="grid-column: span 2">
            <div class="metric-header">
              <span class="metric-label">Disk Allocated</span>
              <span class="metric-value">${formatBytes(guest.maxdisk)}</span>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

function renderStorageCard(storage) {
  const usedPct = pct(storage.used, storage.total);
  const available = (storage.total || 0) - (storage.used || 0);

  return `
    <div class="storage-card">
      <div class="storage-card-header">
        <span class="storage-name">${storage.storage}</span>
        <span class="storage-type">${storage.type || '—'}</span>
      </div>
      ${progressBar(usedPct)}
      <div class="storage-usage">
        <span>${formatBytes(storage.used)} used</span>
        <span>${formatBytes(available)} free</span>
        <span>${formatBytes(storage.total)} total</span>
      </div>
    </div>
  `;
}

function render(data) {
  const dashboard = document.getElementById('dashboard');
  const updateEl = document.getElementById('last-update');

  const time = new Date(data.timestamp);
  updateEl.textContent = `Updated ${time.toLocaleTimeString()}`;

  let html = '';

  for (const host of data.hosts) {
    for (const node of host.nodes) {
      html += `<div class="node-section">`;

      html += `
        <div class="node-header">
          <h2>${node.name}</h2>
          <span class="node-status-badge ${node.status}">${node.status}</span>
          <span class="uptime">Uptime: ${formatUptime(node.uptime)}</span>
          ${data.hosts.length > 1 ? `<span class="host-label">${host.host}</span>` : ''}
        </div>
      `;

      html += renderOverviewCards(node);

      // VMs
      const sortedVms = [...node.vms].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (a.vmid || 0) - (b.vmid || 0);
      });

      if (sortedVms.length > 0) {
        html += `<div class="section-title">Virtual Machines <span class="count">${sortedVms.length}</span></div>`;
        html += `<div class="guest-grid">`;
        for (const vm of sortedVms) {
          html += renderGuestCard(vm, 'vm');
        }
        html += `</div>`;
      }

      // LXCs
      const sortedLxcs = [...node.lxcs].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (a.vmid || 0) - (b.vmid || 0);
      });

      if (sortedLxcs.length > 0) {
        html += `<div class="section-title">LXC Containers <span class="count">${sortedLxcs.length}</span></div>`;
        html += `<div class="guest-grid">`;
        for (const ct of sortedLxcs) {
          html += renderGuestCard(ct, 'lxc');
        }
        html += `</div>`;
      }

      // Storage
      const activeStorages = node.storages.filter(s => s.active);
      if (activeStorages.length > 0) {
        html += `<div class="section-title">Storage <span class="count">${activeStorages.length}</span></div>`;
        html += `<div class="storage-grid">`;
        for (const s of activeStorages) {
          html += renderStorageCard(s);
        }
        html += `</div>`;
      }

      html += `</div>`;
    }
  }

  if (!html) {
    html = `<div class="empty-state"><h3>No data</h3><p>Check your Proxmox connection settings.</p></div>`;
  }

  dashboard.innerHTML = html;
}

// Init
document.getElementById('refresh-btn').addEventListener('click', fetchData);
fetchData();
