let refreshInterval = 30000;
let refreshTimer = null;
let currentNodes = [];

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

function renderGuestCard(guest, type, nodeName) {
  const isRunning = guest.status === 'running';
  const cpuPct = isRunning ? Math.round((guest.cpu || 0) * 100) : 0;
  const memPct = isRunning ? pct(guest.mem, guest.maxmem) : 0;
  const diskPct = pct(guest.disk, guest.maxdisk);
  const netIn = guest.netin || 0;
  const netOut = guest.netout || 0;
  const apiType = type === 'vm' ? 'qemu' : 'lxc';

  return `
    <div class="guest-card" data-node="${nodeName}" data-type="${apiType}" data-vmid="${guest.vmid}" onclick="openDetail(this)">
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

function renderStorageCard(storage, nodeName) {
  const usedPct = pct(storage.used, storage.total);
  const available = (storage.total || 0) - (storage.used || 0);

  return `
    <div class="storage-card" data-node="${nodeName}" data-storage="${storage.storage}" onclick="openStorageDetail(this)">
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
          html += renderGuestCard(vm, 'vm', node.name);
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
          html += renderGuestCard(ct, 'lxc', node.name);
        }
        html += `</div>`;
      }

      // Storage
      const activeStorages = node.storages.filter(s => s.active);
      if (activeStorages.length > 0) {
        html += `<div class="section-title">Storage <span class="count">${activeStorages.length}</span></div>`;
        html += `<div class="storage-grid">`;
        for (const s of activeStorages) {
          html += renderStorageCard(s, node.name);
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

// Detail panel
function openDetail(el) {
  const node = el.dataset.node;
  const type = el.dataset.type;
  const vmid = el.dataset.vmid;
  const name = el.querySelector('.guest-name-text strong').textContent;

  document.getElementById('detail-title').textContent = `${name} (${type === 'qemu' ? 'VM' : 'LXC'} ${vmid})`;
  document.getElementById('detail-body').innerHTML = '<div class="detail-loading">Loading...</div>';
  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');

  fetch(`/api/guest/${node}/${type}/${vmid}`)
    .then(r => r.json())
    .then(data => renderDetail(data, type))
    .catch(err => {
      document.getElementById('detail-body').innerHTML = `<div class="detail-loading">Error: ${err.message}</div>`;
    });
}

function closeDetail() {
  document.getElementById('detail-overlay').classList.remove('open');
  document.getElementById('detail-panel').classList.remove('open');
}

function renderDetail(data, type) {
  const body = document.getElementById('detail-body');
  const { config, status, snapshots, rrdHour } = data;
  let html = '';

  // Status section
  const isRunning = status.status === 'running';
  const cpuPct = Math.round((status.cpu || 0) * 100);
  const memPct = pct(status.mem, status.maxmem);
  const diskPct = pct(status.disk, status.maxdisk);

  html += `<div class="detail-section">
    <h3>Current Status</h3>
    <div class="detail-grid">
      <div class="detail-item">
        <div class="label">Status</div>
        <div class="value"><span class="guest-status ${status.status}">${status.status}</span></div>
      </div>
      <div class="detail-item">
        <div class="label">Uptime</div>
        <div class="value">${formatUptime(status.uptime)}</div>
      </div>
      <div class="detail-item">
        <div class="label">CPU Usage</div>
        <div class="value">${cpuPct}%</div>
        ${progressBar(cpuPct)}
      </div>
      <div class="detail-item">
        <div class="label">Memory</div>
        <div class="value">${formatBytes(status.mem)} / ${formatBytes(status.maxmem)} (${memPct}%)</div>
        ${progressBar(memPct)}
      </div>
      <div class="detail-item">
        <div class="label">Disk</div>
        <div class="value">${formatBytes(status.disk)} / ${formatBytes(status.maxdisk)} (${diskPct}%)</div>
        ${progressBar(diskPct)}
      </div>
      <div class="detail-item">
        <div class="label">Network</div>
        <div class="value">↓ ${formatBytes(status.netin)} ↑ ${formatBytes(status.netout)}</div>
      </div>
    </div>
  </div>`;

  // Config section
  html += `<div class="detail-section">
    <h3>Configuration</h3>
    <div class="detail-grid">`;

  if (type === 'qemu') {
    html += detailItem('Cores', config.cores || '—');
    html += detailItem('Sockets', config.sockets || '1');
    html += detailItem('Memory', formatBytes((config.memory || 0) * 1024 * 1024));
    html += detailItem('BIOS', config.bios || 'SeaBIOS');
    html += detailItem('Machine', config.machine || 'default');
    html += detailItem('OS Type', config.ostype || '—');
    if (config.boot) html += detailItem('Boot Order', config.boot, true);
    if (config.scsi0 || config.virtio0 || config.ide0 || config.sata0) {
      const disk = config.scsi0 || config.virtio0 || config.ide0 || config.sata0;
      html += detailItem('Primary Disk', disk, true);
    }
    if (config.net0) html += detailItem('Network', config.net0, true);
    if (config.agent) html += detailItem('QEMU Agent', config.agent);
  } else {
    html += detailItem('Cores', config.cores || '—');
    html += detailItem('Memory', formatBytes((config.memory || 0) * 1024 * 1024));
    html += detailItem('Swap', formatBytes((config.swap || 0) * 1024 * 1024));
    html += detailItem('OS Type', config.ostype || '—');
    if (config.rootfs) html += detailItem('Root FS', config.rootfs, true);
    if (config.net0) html += detailItem('Network', config.net0, true);
    if (config.hostname) html += detailItem('Hostname', config.hostname);
    if (config.nameserver) html += detailItem('DNS', config.nameserver);
    html += detailItem('Unprivileged', config.unprivileged ? 'Yes' : 'No');
  }

  html += `</div></div>`;

  // Historical charts (last hour)
  if (rrdHour && rrdHour.length > 0) {
    html += `<div class="detail-section">
      <h3>Last Hour</h3>
      ${renderMiniChart(rrdHour, 'cpu', 'CPU %', v => Math.round((v || 0) * 100), '%')}
      ${renderMiniChart(rrdHour, 'mem', 'Memory', v => v || 0, '', true)}
      ${renderMiniChart(rrdHour, 'netin', 'Network In', v => v || 0, '', true)}
      ${renderMiniChart(rrdHour, 'netout', 'Network Out', v => v || 0, '', true)}
    </div>`;
  }

  // Snapshots
  const realSnapshots = (snapshots || []).filter(s => s.name !== 'current');
  if (realSnapshots.length > 0) {
    html += `<div class="detail-section">
      <h3>Snapshots (${realSnapshots.length})</h3>
      <div class="snapshot-list">`;
    for (const snap of realSnapshots) {
      const date = snap.snaptime ? new Date(snap.snaptime * 1000).toLocaleString() : '—';
      html += `<div class="snapshot-item">
        <span class="snap-name">${snap.name}</span>
        <span class="snap-date">${date}</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  body.innerHTML = html;
}

function detailItem(label, value, full) {
  return `<div class="detail-item${full ? ' full' : ''}">
    <div class="label">${label}</div>
    <div class="value">${value}</div>
  </div>`;
}

function renderMiniChart(rrdData, key, label, transform, suffix, isBytes) {
  const values = rrdData.map(d => transform(d[key])).filter(v => !isNaN(v));
  if (values.length === 0) return '';

  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const latest = values[values.length - 1];
  const w = 480;
  const h = 50;

  const points = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / (max - min || 1)) * h;
    return `${x},${y}`;
  }).join(' ');

  const latestLabel = isBytes ? formatBytes(latest) : `${latest}${suffix}`;

  return `<div class="chart-container">
    <div class="chart-label">
      <span>${label}</span>
      <span>${latestLabel}</span>
    </div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${points}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>
    </svg>
  </div>`;
}

// Storage detail panel
function openStorageDetail(el) {
  const node = el.dataset.node;
  const storage = el.dataset.storage;

  document.getElementById('detail-title').textContent = `Storage: ${storage}`;
  document.getElementById('detail-body').innerHTML = '<div class="detail-loading">Loading...</div>';
  document.getElementById('detail-overlay').classList.add('open');
  document.getElementById('detail-panel').classList.add('open');

  fetch(`/api/storage/${node}/${storage}`)
    .then(r => r.json())
    .then(data => renderStorageDetail(data, storage))
    .catch(err => {
      document.getElementById('detail-body').innerHTML = `<div class="detail-loading">Error: ${err.message}</div>`;
    });
}

function renderStorageDetail(data, storageName) {
  const body = document.getElementById('detail-body');
  const { status, content, dependents, rrdHour } = data;
  let html = '';

  // Overall status
  const usedPct = pct(status.used, status.total);
  const available = (status.total || 0) - (status.used || 0);

  html += `<div class="detail-section">
    <h3>Overview</h3>
    <div class="detail-grid">
      <div class="detail-item">
        <div class="label">Type</div>
        <div class="value">${status.type || '—'}</div>
      </div>
      <div class="detail-item">
        <div class="label">Status</div>
        <div class="value"><span class="guest-status ${status.active ? 'running' : 'stopped'}">${status.active ? 'Active' : 'Inactive'}</span></div>
      </div>
      <div class="detail-item">
        <div class="label">Used</div>
        <div class="value">${formatBytes(status.used)} (${usedPct}%)</div>
        ${progressBar(usedPct)}
      </div>
      <div class="detail-item">
        <div class="label">Available</div>
        <div class="value">${formatBytes(available)}</div>
      </div>
      <div class="detail-item full">
        <div class="label">Total Capacity</div>
        <div class="value">${formatBytes(status.total)}</div>
      </div>
    </div>
  </div>`;

  // Content breakdown
  if (content && content.length > 0) {
    const sorted = [...content].sort((a, b) => (b.size || 0) - (a.size || 0));
    const maxSize = sorted[0]?.size || 1;

    const byType = {};
    for (const item of sorted) {
      const ct = item.content || 'unknown';
      if (!byType[ct]) byType[ct] = { count: 0, size: 0 };
      byType[ct].count++;
      byType[ct].size += item.size || 0;
    }

    html += `<div class="detail-section">
      <h3>Space by Type</h3>
      <div class="detail-grid">`;
    for (const [type, info] of Object.entries(byType).sort((a, b) => b[1].size - a[1].size)) {
      html += `<div class="detail-item">
        <div class="label">${type} (${info.count})</div>
        <div class="value">${formatBytes(info.size)}</div>
      </div>`;
    }
    html += `</div></div>`;

    html += `<div class="detail-section">
      <h3>Contents (${sorted.length} items)</h3>
      <div style="overflow-x:auto;">
      <table class="content-table">
        <thead><tr>
          <th>Name</th>
          <th>Type</th>
          <th>Size</th>
          <th style="width:120px"></th>
        </tr></thead>
        <tbody>`;

    for (const item of sorted.slice(0, 50)) {
      const name = (item.volid || '').replace(`${storageName}:`, '');
      const barWidth = Math.max(2, ((item.size || 0) / maxSize) * 100);
      html += `<tr>
        <td>${name}</td>
        <td>${item.content || '—'}</td>
        <td>${formatBytes(item.size)}</td>
        <td><div class="size-bar"><div class="size-bar-fill" style="width:${barWidth}%;height:6px;border-radius:3px;background:var(--accent);min-width:2px"></div></div></td>
      </tr>`;
    }
    if (sorted.length > 50) {
      html += `<tr><td colspan="4" style="color:var(--text-dim);text-align:center">...and ${sorted.length - 50} more items</td></tr>`;
    }

    html += `</tbody></table></div></div>`;
  }

  // Dependents
  if (dependents && dependents.length > 0) {
    html += `<div class="detail-section">
      <h3>Dependent Guests (${dependents.length})</h3>
      <div class="dependents-list">`;
    for (const dep of dependents) {
      const typeLabel = dep.type === 'qemu' ? 'VM' : 'LXC';
      html += `<div class="dependent-card">
        <div>
          <div class="dep-name">${dep.name || `${typeLabel} ${dep.vmid}`}</div>
          <div class="dep-id">${typeLabel} ${dep.vmid}</div>
        </div>
        <span class="guest-status ${dep.status}">${dep.status}</span>
      </div>`;
    }
    html += `</div></div>`;
  }

  // Historical chart
  if (rrdHour && rrdHour.length > 0) {
    html += `<div class="detail-section">
      <h3>Last 24 Hours</h3>
      ${renderMiniChart(rrdHour, 'used', 'Space Used', v => v || 0, '', true)}
    </div>`;
  }

  body.innerHTML = html;
}

// Init
document.getElementById('refresh-btn').addEventListener('click', fetchData);
document.getElementById('detail-overlay').addEventListener('click', closeDetail);
document.getElementById('detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
fetchData();
