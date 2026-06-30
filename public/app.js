let refreshInterval = 30000;
let refreshTimer = null;
let currentNodes = [];
let nodeDataMap = {};

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
      <div class="overview-card clickable" onclick="toggleBreakdown('cpu', '${node.name}')">
        <div class="label">CPU <span class="breakdown-hint">▾</span></div>
        <div class="value">${cpuPct}%</div>
        <div class="sub">${node.maxcpu || '—'} cores</div>
        ${progressBar(cpuPct)}
      </div>
      <div class="overview-card clickable" onclick="toggleBreakdown('mem', '${node.name}')">
        <div class="label">Memory <span class="breakdown-hint">▾</span></div>
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
    <div id="breakdown-${node.name}" class="breakdown-panel hidden"></div>
  `;
}

function toggleBreakdown(metric, nodeName) {
  const panel = document.getElementById(`breakdown-${nodeName}`);
  const node = nodeDataMap[nodeName];
  if (!node) return;

  const isOpen = !panel.classList.contains('hidden') && panel.dataset.metric === metric;
  if (isOpen) {
    panel.classList.add('hidden');
    panel.dataset.metric = '';
    return;
  }

  panel.dataset.metric = metric;
  panel.classList.remove('hidden');

  const allGuests = [
    ...node.vms.map(v => ({ ...v, gtype: 'VM' })),
    ...node.lxcs.map(c => ({ ...c, gtype: 'LXC' }))
  ].filter(g => g.status === 'running');

  let ranked;
  if (metric === 'cpu') {
    ranked = allGuests.map(g => {
      const guestCores = g.maxcpu || 1;
      const nodeContrib = ((g.cpu || 0) * guestCores) / (node.maxcpu || 1) * 100;
      return { ...g, contribution: nodeContrib, detail: `${Math.round((g.cpu || 0) * 100)}% of ${guestCores} core${guestCores > 1 ? 's' : ''}` };
    }).sort((a, b) => b.contribution - a.contribution);
  } else {
    ranked = allGuests.map(g => {
      const nodeContrib = (g.mem || 0) / (node.maxmem || 1) * 100;
      return { ...g, contribution: nodeContrib, detail: `${formatBytes(g.mem)} / ${formatBytes(g.maxmem)} allocated` };
    }).sort((a, b) => b.contribution - a.contribution);
  }

  const label = metric === 'cpu' ? 'CPU' : 'Memory';
  const totalPct = metric === 'cpu' ? Math.round((node.cpu || 0) * 100) : pct(node.mem, node.maxmem);
  const accountedPct = ranked.reduce((sum, g) => sum + g.contribution, 0);
  const systemPct = Math.max(0, totalPct - accountedPct);

  let html = `<div class="breakdown-header">
    <span class="breakdown-title">${label} Breakdown by Guest</span>
    <span class="breakdown-close" onclick="event.stopPropagation();document.getElementById('breakdown-${nodeName}').classList.add('hidden')">✕</span>
  </div>`;

  html += `<div class="breakdown-list">`;
  for (const g of ranked) {
    const name = g.name || `${g.gtype} ${g.vmid}`;
    const contribRounded = g.contribution.toFixed(1);
    const barWidth = Math.max(1, (g.contribution / Math.max(totalPct, 1)) * 100);
    const color = g.gtype === 'VM' ? 'var(--accent)' : 'var(--purple)';

    html += `<div class="breakdown-row">
      <div class="breakdown-row-header">
        <span class="breakdown-guest-name">
          <span class="guest-icon mini ${g.gtype.toLowerCase()}">${g.gtype === 'VM' ? '⊞' : '⊡'}</span>
          ${name}
          <span class="breakdown-vmid">${g.gtype} ${g.vmid}</span>
        </span>
        <span class="breakdown-pct">${contribRounded}%</span>
      </div>
      <div class="breakdown-bar-row">
        <div class="progress-bar breakdown-bar"><div class="progress-fill" style="width:${barWidth}%;background:${color}"></div></div>
        <span class="breakdown-detail">${g.detail}</span>
      </div>
    </div>`;
  }

  if (systemPct > 0.5) {
    const barWidth = Math.max(1, (systemPct / Math.max(totalPct, 1)) * 100);
    html += `<div class="breakdown-row">
      <div class="breakdown-row-header">
        <span class="breakdown-guest-name">
          <span class="guest-icon mini system">⚙</span>
          System / Proxmox
        </span>
        <span class="breakdown-pct">${systemPct.toFixed(1)}%</span>
      </div>
      <div class="breakdown-bar-row">
        <div class="progress-bar breakdown-bar"><div class="progress-fill" style="width:${barWidth}%;background:var(--text-dim)"></div></div>
        <span class="breakdown-detail">Host OS, hypervisor, and overhead</span>
      </div>
    </div>`;
  }

  html += `</div>`;
  panel.innerHTML = html;
}

function renderGuestCard(guest, type, nodeName) {
  const isRunning = guest.status === 'running';
  const cpuPct = isRunning ? Math.round((guest.cpu || 0) * 100) : 0;
  const memPct = isRunning ? pct(guest.mem, guest.maxmem) : 0;
  const diskPct = pct(guest.disk, guest.maxdisk);
  const swapPct = pct(guest.swap, guest.maxswap);
  const hasSwap = guest.maxswap && guest.maxswap > 0;
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
              <span class="metric-label">${hasSwap ? 'Swap' : 'Network'}</span>
              <span class="metric-value">${hasSwap ? `${formatBytes(guest.swap)} / ${formatBytes(guest.maxswap)}` : `↓${formatBytes(netIn)} ↑${formatBytes(netOut)}`}</span>
            </div>
            ${hasSwap ? progressBar(swapPct) : ''}
          </div>
        </div>
        ${hasSwap ? `
          <div style="margin-top:8px">
            <div class="metric-header" style="font-size:12px">
              <span class="metric-label">Network</span>
              <span class="metric-value">↓${formatBytes(netIn)} ↑${formatBytes(netOut)}</span>
            </div>
          </div>
        ` : ''}
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

function generateRecommendations(node) {
  const recs = [];
  const allGuests = [
    ...node.vms.map(v => ({ ...v, gtype: 'VM' })),
    ...node.lxcs.map(c => ({ ...c, gtype: 'LXC' }))
  ].filter(g => g.status === 'running');

  // Node-level checks
  const nodeCpuPct = Math.round((node.cpu || 0) * 100);
  const nodeMemPct = pct(node.mem, node.maxmem);

  if (nodeCpuPct >= 90) {
    recs.push({ severity: 'critical', icon: '!!', message: `Node CPU at ${nodeCpuPct}% — consider migrating workloads to another node or adding CPU resources` });
  } else if (nodeCpuPct >= 75) {
    recs.push({ severity: 'warning', icon: '!', message: `Node CPU at ${nodeCpuPct}% — monitor for sustained high usage, consider load balancing` });
  }

  if (nodeMemPct >= 90) {
    recs.push({ severity: 'critical', icon: '!!', message: `Node memory at ${nodeMemPct}% (${formatBytes(node.mem)} / ${formatBytes(node.maxmem)}) — risk of OOM, consider adding RAM or migrating guests` });
  } else if (nodeMemPct >= 80) {
    recs.push({ severity: 'warning', icon: '!', message: `Node memory at ${nodeMemPct}% — approaching capacity, plan for expansion` });
  }

  // Guest-level checks
  for (const guest of allGuests) {
    const name = guest.name || `${guest.gtype} ${guest.vmid}`;

    // Disk usage
    if (guest.maxdisk > 0 && guest.disk > 0) {
      const diskPctVal = pct(guest.disk, guest.maxdisk);
      if (diskPctVal >= 95) {
        recs.push({ severity: 'critical', icon: '!!', message: `${name} disk at ${diskPctVal}% — resize disk immediately to prevent data loss` });
      } else if (diskPctVal >= 85) {
        recs.push({ severity: 'warning', icon: '!', message: `${name} disk at ${diskPctVal}% (${formatBytes(guest.disk)} / ${formatBytes(guest.maxdisk)}) — consider resizing disk soon` });
      } else if (diskPctVal >= 75) {
        recs.push({ severity: 'info', icon: 'i', message: `${name} disk at ${diskPctVal}% — monitor disk growth, plan for resize` });
      }
    }

    // Memory usage
    const memPctVal = pct(guest.mem, guest.maxmem);
    if (memPctVal >= 95) {
      recs.push({ severity: 'critical', icon: '!!', message: `${name} memory at ${memPctVal}% — increase memory allocation to prevent OOM kills` });
    } else if (memPctVal >= 85) {
      recs.push({ severity: 'warning', icon: '!', message: `${name} memory at ${memPctVal}% (${formatBytes(guest.mem)} / ${formatBytes(guest.maxmem)}) — consider increasing memory` });
    }

    // Swap usage (LXCs primarily)
    if (guest.maxswap > 0 && guest.swap > 0) {
      const swapPctVal = pct(guest.swap, guest.maxswap);
      if (swapPctVal >= 80) {
        recs.push({ severity: 'warning', icon: '!', message: `${name} swap at ${swapPctVal}% (${formatBytes(guest.swap)} / ${formatBytes(guest.maxswap)}) — high swap indicates memory pressure, consider increasing RAM` });
      } else if (swapPctVal >= 50) {
        recs.push({ severity: 'info', icon: 'i', message: `${name} using ${swapPctVal}% swap — moderate swap usage may impact performance, consider more memory` });
      }
    }

    // CPU usage
    const cpuPctVal = Math.round((guest.cpu || 0) * 100);
    if (cpuPctVal >= 90) {
      recs.push({ severity: 'warning', icon: '!', message: `${name} CPU at ${cpuPctVal}% — consider adding more vCPU cores` });
    }
  }

  // Storage pool checks
  for (const stor of node.storages.filter(s => s.active && s.total > 0)) {
    const storPct = pct(stor.used, stor.total);
    if (storPct >= 95) {
      recs.push({ severity: 'critical', icon: '!!', message: `Storage "${stor.storage}" at ${storPct}% — critical, expand storage or clean up immediately` });
    } else if (storPct >= 85) {
      recs.push({ severity: 'warning', icon: '!', message: `Storage "${stor.storage}" at ${storPct}% (${formatBytes(stor.used)} / ${formatBytes(stor.total)}) — consider expanding or cleaning old backups/snapshots` });
    } else if (storPct >= 75) {
      recs.push({ severity: 'info', icon: 'i', message: `Storage "${stor.storage}" at ${storPct}% — monitor usage and plan for expansion` });
    }
  }

  // Sort by severity
  const order = { critical: 0, warning: 1, info: 2 };
  recs.sort((a, b) => order[a.severity] - order[b.severity]);

  return recs;
}

function renderRecommendations(recs) {
  const critCount = recs.filter(r => r.severity === 'critical').length;
  const warnCount = recs.filter(r => r.severity === 'warning').length;
  const infoCount = recs.filter(r => r.severity === 'info').length;

  let summary = [];
  if (critCount > 0) summary.push(`${critCount} critical`);
  if (warnCount > 0) summary.push(`${warnCount} warning`);
  if (infoCount > 0) summary.push(`${infoCount} info`);

  let html = `<div class="recommendations-section">
    <div class="section-title" style="cursor:pointer" onclick="toggleRecs(this)">
      Recommendations <span class="count">${recs.length}</span>
      <span class="rec-summary">${summary.join(', ')}</span>
      <span class="rec-toggle">▾</span>
    </div>
    <div class="rec-list">`;

  for (const rec of recs) {
    html += `<div class="rec-item rec-${rec.severity}">
      <span class="rec-icon">${rec.icon}</span>
      <span class="rec-message">${rec.message}</span>
    </div>`;
  }

  html += `</div></div>`;
  return html;
}

function toggleRecs(el) {
  const list = el.nextElementSibling;
  const toggle = el.querySelector('.rec-toggle');
  if (list.style.display === 'none') {
    list.style.display = '';
    toggle.textContent = '▾';
  } else {
    list.style.display = 'none';
    toggle.textContent = '▸';
  }
}

function render(data) {
  const dashboard = document.getElementById('dashboard');
  const updateEl = document.getElementById('last-update');

  const time = new Date(data.timestamp);
  updateEl.textContent = `Updated ${time.toLocaleTimeString()}`;

  let pveHtml = '';
  nodeDataMap = {};

  for (const host of data.hosts) {
    for (const node of host.nodes) {
      nodeDataMap[node.name] = node;
      pveHtml += `<div class="node-section">`;

      pveHtml += `
        <div class="node-header">
          <h2>${node.name}</h2>
          <span class="node-status-badge ${node.status}">${node.status}</span>
          <span class="uptime">Uptime: ${formatUptime(node.uptime)}</span>
          ${data.hosts.length > 1 ? `<span class="host-label">${host.host}</span>` : ''}
        </div>
      `;

      pveHtml += renderOverviewCards(node);

      const recs = generateRecommendations(node);
      if (recs.length > 0) {
        pveHtml += renderRecommendations(recs);
      }

      // VMs
      const sortedVms = [...node.vms].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (a.vmid || 0) - (b.vmid || 0);
      });

      if (sortedVms.length > 0) {
        pveHtml += `<div class="section-title">Virtual Machines <span class="count">${sortedVms.length}</span></div>`;
        pveHtml += `<div class="guest-grid">`;
        for (const vm of sortedVms) {
          pveHtml += renderGuestCard(vm, 'vm', node.name);
        }
        pveHtml += `</div>`;
      }

      // LXCs
      const sortedLxcs = [...node.lxcs].sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return (a.vmid || 0) - (b.vmid || 0);
      });

      if (sortedLxcs.length > 0) {
        pveHtml += `<div class="section-title">LXC Containers <span class="count">${sortedLxcs.length}</span></div>`;
        pveHtml += `<div class="guest-grid">`;
        for (const ct of sortedLxcs) {
          pveHtml += renderGuestCard(ct, 'lxc', node.name);
        }
        pveHtml += `</div>`;
      }

      // Storage
      const activeStorages = node.storages.filter(s => s.active);
      if (activeStorages.length > 0) {
        pveHtml += `<div class="section-title">Storage <span class="count">${activeStorages.length}</span></div>`;
        pveHtml += `<div class="storage-grid">`;
        for (const s of activeStorages) {
          pveHtml += renderStorageCard(s, node.name);
        }
        pveHtml += `</div>`;
      }

      pveHtml += `</div>`;
    }
  }

  let html = '';
  const hasPbs = !!data.pbs;

  if (hasPbs) {
    html += `<div class="dashboard-columns">`;
    html += `<div class="dashboard-col pve-col">${pveHtml}</div>`;
    const allPveGuests = [];
    for (const host of data.hosts) {
      for (const node of host.nodes) {
        for (const vm of node.vms) allPveGuests.push({ id: String(vm.vmid), type: 'vm', name: vm.name, status: vm.status });
        for (const ct of node.lxcs) allPveGuests.push({ id: String(ct.vmid), type: 'ct', name: ct.name, status: ct.status });
      }
    }
    html += `<div class="dashboard-col pbs-col">${renderPbsSection(data.pbs, allPveGuests)}</div>`;
    html += `</div>`;
  } else {
    html = pveHtml;
  }

  if (!html) {
    html = `<div class="empty-state"><h3>No data</h3><p>Check your Proxmox connection settings.</p></div>`;
  }

  dashboard.innerHTML = html;
}

function backupAgeClass(epochSecs) {
  if (!epochSecs) return 'backup-missing';
  const ageHours = (Date.now() / 1000 - epochSecs) / 3600;
  if (ageHours <= 26) return 'backup-fresh';
  if (ageHours <= 50) return 'backup-aging';
  if (ageHours <= 168) return 'backup-stale';
  return 'backup-old';
}

// PBS Section
function renderPbsSection(pbs, pveGuests) {
  let html = `<div class="node-section pbs-section">`;

  html += `<div class="node-header">
    <h2>
      <span class="pbs-icon">🛡</span>
      Proxmox Backup Server
    </h2>
    <span class="node-status-badge online">online</span>`;

  if (pbs.nodeStatus) {
    html += `<span class="uptime">Uptime: ${formatUptime(pbs.nodeStatus.uptime)}</span>`;
  }
  html += `</div>`;

  if (pbs.nodeStatus) {
    const cpuPct = Math.round((pbs.nodeStatus.cpu || 0) * 100);
    const memPct = pct(pbs.nodeStatus.mem, pbs.nodeStatus.maxmem);

    html += `<div class="overview-grid">
      <div class="overview-card">
        <div class="label">CPU</div>
        <div class="value">${cpuPct}%</div>
        <div class="sub">${pbs.nodeStatus.cpuCount} cores</div>
        ${progressBar(cpuPct)}
      </div>
      <div class="overview-card">
        <div class="label">Memory</div>
        <div class="value">${memPct}%</div>
        <div class="sub">${formatBytes(pbs.nodeStatus.mem)} / ${formatBytes(pbs.nodeStatus.maxmem)}</div>
        ${progressBar(memPct)}
      </div>`;

    if (pbs.datastores.length > 0) {
      const ds = pbs.datastores[0];
      const totalSnaps = pbs.datastores.reduce((sum, d) => sum + d.totalSnapshots, 0);
      html += `<div class="overview-card">
        <div class="label">Snapshots</div>
        <div class="value">${totalSnaps}</div>
        <div class="sub">${pbs.datastores.length} datastore${pbs.datastores.length > 1 ? 's' : ''}</div>
      </div>`;
    }

    const recentOk = pbs.recentTasks.filter(t => t.status === 'OK').length;
    const recentFail = pbs.recentTasks.filter(t => t.status && t.status !== 'OK').length;
    html += `<div class="overview-card">
      <div class="label">Recent Backups</div>
      <div class="value">${recentOk} <span style="font-size:14px;color:var(--green)">OK</span>${recentFail > 0 ? ` <span style="font-size:14px;color:var(--red)">${recentFail} failed</span>` : ''}</div>
      <div class="sub">last ${pbs.recentTasks.length} tasks</div>
    </div>`;

    html += `</div>`;
  }

  // Datastores
  for (const ds of pbs.datastores) {
    const used = ds.status?.used || 0;
    const total = ds.status?.total || 0;
    const avail = ds.status?.avail || (total - used);
    const usedPct = pct(used, total);

    html += `<div class="section-title">Datastore: ${ds.store} <span class="count">${ds.totalSnapshots} snapshots</span></div>`;
    html += `<div class="pbs-datastore-card">
      <div class="pbs-ds-usage">
        <div class="pbs-ds-usage-header">
          <span>${formatBytes(used)} used of ${formatBytes(total)}</span>
          <span>${formatBytes(avail)} free</span>
        </div>
        ${progressBar(usedPct)}
      </div>
    </div>`;

    // Guest backup table
    const backedUpIds = new Set(ds.guestBackups.map(gb => `${gb.type}/${gb.id}`));

    html += `<div class="pbs-backup-grid">`;
    for (const gb of ds.guestBackups) {
      const typeLabel = gb.type === 'vm' ? 'VM' : gb.type === 'ct' ? 'LXC' : gb.type.toUpperCase();
      const ago = formatTimeAgo(gb.lastBackup);
      const iconClass = gb.type === 'vm' ? 'vm' : 'lxc';
      const ageClass = backupAgeClass(gb.lastBackup);
      const pveMatch = (pveGuests || []).find(g => String(g.id) === String(gb.id));
      const displayName = pveMatch ? pveMatch.name : `${typeLabel} ${gb.id}`;

      html += `<div class="pbs-backup-card ${ageClass}">
        <div class="pbs-backup-header">
          <span class="pbs-backup-name">
            <span class="guest-icon mini ${iconClass}">${gb.type === 'vm' ? '⊞' : '⊡'}</span>
            ${displayName}
            <span class="breakdown-vmid">${typeLabel} ${gb.id}</span>
          </span>
          <span class="pbs-backup-count">${gb.count} backup${gb.count !== 1 ? 's' : ''}</span>
        </div>
        <div class="pbs-backup-detail">
          <span>Last: ${ago}</span>
          <span>${formatBytes(gb.size)}</span>
        </div>
      </div>`;
    }

    // Show PVE guests with no backups
    if (pveGuests) {
      const unprotected = pveGuests.filter(g => {
        const pbsType = g.type === 'ct' ? 'ct' : 'vm';
        return !backedUpIds.has(`${pbsType}/${g.id}`);
      });
      for (const g of unprotected) {
        const typeLabel = g.type === 'ct' ? 'LXC' : 'VM';
        const iconClass = g.type === 'ct' ? 'lxc' : 'vm';
        html += `<div class="pbs-backup-card backup-missing">
          <div class="pbs-backup-header">
            <span class="pbs-backup-name">
              <span class="guest-icon mini ${iconClass}">${g.type === 'ct' ? '⊡' : '⊞'}</span>
              ${g.name || `${typeLabel} ${g.id}`}
              <span class="breakdown-vmid">${typeLabel} ${g.id}</span>
            </span>
            <span class="pbs-backup-count" style="color:var(--red)">not backed up</span>
          </div>
          <div class="pbs-backup-detail">
            <span style="color:var(--red)">No backups found</span>
          </div>
        </div>`;
      }
    }

    html += `</div>`;
  }

  // Recent tasks
  if (pbs.recentTasks.length > 0) {
    html += `<div class="section-title" style="cursor:pointer" onclick="togglePbsTasks(this)">
      Recent Backup Tasks <span class="count">${pbs.recentTasks.length}</span>
      <span class="rec-toggle">▸</span>
    </div>`;
    html += `<div class="pbs-tasks-list" style="display:none">`;
    for (const task of pbs.recentTasks) {
      const isOk = task.status === 'OK';
      const statusClass = isOk ? 'running' : 'stopped';
      const statusText = isOk ? 'OK' : (task.status || 'unknown');
      const time = task.startTime ? new Date(task.startTime * 1000).toLocaleString() : '—';
      const dur = task.duration ? formatDuration(task.duration) : '—';

      html += `<div class="pbs-task-row">
        <span class="guest-status ${statusClass}" style="min-width:50px;text-align:center">${statusText}</span>
        <span class="pbs-task-id">${task.id || '—'}</span>
        <span class="pbs-task-time">${time}</span>
        <span class="pbs-task-dur">${dur}</span>
      </div>`;
    }
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function formatTimeAgo(epochSecs) {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - epochSecs;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}

function formatDuration(secs) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function togglePbsTasks(el) {
  const list = el.nextElementSibling;
  const toggle = el.querySelector('.rec-toggle');
  if (list.style.display === 'none') {
    list.style.display = '';
    toggle.textContent = '▾';
  } else {
    list.style.display = 'none';
    toggle.textContent = '▸';
  }
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
  const { status, content, dependents, rrdHour, zfsDetail, storageConfig } = data;
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

  // Storage configuration
  if (storageConfig) {
    html += `<div class="detail-section">
      <h3>Configuration</h3>
      <div class="detail-grid">`;
    if (storageConfig.content) html += detailItem('Content Types', storageConfig.content.split(',').join(', '));
    if (storageConfig.pool) html += detailItem('ZFS Pool', storageConfig.pool);
    if (storageConfig.path) html += detailItem('Path', storageConfig.path);
    if (storageConfig.mountpoint) html += detailItem('Mount Point', storageConfig.mountpoint);
    if (storageConfig.nodes) html += detailItem('Nodes', storageConfig.nodes);
    if (storageConfig.shared !== undefined) html += detailItem('Shared', storageConfig.shared ? 'Yes' : 'No');
    if (storageConfig.sparse !== undefined) html += detailItem('Thin Provision', storageConfig.sparse ? 'Yes' : 'No');
    if (storageConfig.blocksize) html += detailItem('Block Size', storageConfig.blocksize);
    html += `</div></div>`;
  }

  // ZFS pool health and devices
  if (zfsDetail) {
    const stateColor = zfsDetail.state === 'ONLINE' ? 'var(--green)' :
                       zfsDetail.state === 'DEGRADED' ? 'var(--yellow)' : 'var(--red)';

    html += `<div class="detail-section">
      <h3>ZFS Pool Health</h3>
      <div class="detail-grid">
        <div class="detail-item">
          <div class="label">Pool State</div>
          <div class="value" style="color:${stateColor}">${zfsDetail.state}</div>
        </div>`;
    if (zfsDetail.errors) {
      html += `<div class="detail-item">
        <div class="label">Errors</div>
        <div class="value">${zfsDetail.errors}</div>
      </div>`;
    }
    if (zfsDetail.scan) {
      html += `<div class="detail-item full">
        <div class="label">Last Scrub/Scan</div>
        <div class="value" style="font-size:12px">${zfsDetail.scan}</div>
      </div>`;
    }
    if (zfsDetail.action) {
      html += `<div class="detail-item full">
        <div class="label">Action</div>
        <div class="value" style="font-size:12px">${zfsDetail.action}</div>
      </div>`;
    }
    html += `</div>`;

    if (zfsDetail.devices && zfsDetail.devices.length > 0) {
      html += `<div style="margin-top:12px">
        <div style="font-size:12px;color:var(--text-dim);margin-bottom:8px">DEVICES (${zfsDetail.devices.length})</div>
        <div class="dependents-list">`;
      for (const dev of zfsDetail.devices) {
        const devColor = dev.state === 'ONLINE' ? 'var(--green)' :
                         dev.state === 'DEGRADED' ? 'var(--yellow)' : 'var(--red)';
        html += `<div class="dependent-card">
          <div class="dep-name" style="font-size:13px;font-family:monospace">${dev.name}</div>
          <span style="color:${devColor};font-size:12px;font-weight:500">${dev.state}</span>
        </div>`;
      }
      html += `</div></div>`;
    }

    html += `</div>`;
  }

  // Dependents with disk allocation breakdown
  if (dependents && dependents.length > 0) {
    const totalAllocatedAll = dependents.reduce((sum, d) => sum + (d.totalAllocated || 0), 0);
    const totalActualUsed = dependents.reduce((sum, d) => sum + (d.actualDisk || 0), 0);

    html += `<div class="detail-section">
      <h3>Guest Disk Usage (${dependents.length} guests)</h3>`;

    if (totalAllocatedAll > 0 || totalActualUsed > 0) {
      html += `<div class="detail-grid" style="margin-bottom:14px">
        <div class="detail-item">
          <div class="label">Total Allocated</div>
          <div class="value">${formatBytes(totalAllocatedAll)}</div>
        </div>
        <div class="detail-item">
          <div class="label">Actual Used</div>
          <div class="value">${formatBytes(totalActualUsed)}</div>
        </div>
      </div>`;
    }

    const sortedDeps = [...dependents].sort((a, b) => (b.totalAllocated || b.maxDisk || 0) - (a.totalAllocated || a.maxDisk || 0));
    const maxAlloc = Math.max(...sortedDeps.map(d => d.totalAllocated || d.maxDisk || 0), 1);

    html += `<div class="dependents-list">`;
    for (const dep of sortedDeps) {
      const typeLabel = dep.type === 'qemu' ? 'VM' : 'LXC';
      const allocated = dep.totalAllocated || dep.maxDisk || 0;
      const actual = dep.actualDisk || 0;
      const diskPctUsed = dep.maxDisk ? pct(actual, dep.maxDisk) : 0;
      const barWidth = Math.max(2, (allocated / maxAlloc) * 100);

      let diskDetails = '';
      if (dep.disks && dep.disks.length > 0) {
        diskDetails = dep.disks.map(d => {
          const diskLabel = d.key;
          const sizeStr = d.size ? formatBytes(d.size) : '—';
          return `<span style="font-size:12px;color:var(--text-dim)">${diskLabel}: ${sizeStr}</span>`;
        }).join(' &nbsp; ');
      }

      html += `<div class="dependent-card" style="flex-direction:column;align-items:stretch;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <div>
            <div class="dep-name">${dep.name || `${typeLabel} ${dep.vmid}`}</div>
            <div class="dep-id">${typeLabel} ${dep.vmid}</div>
          </div>
          <span class="guest-status ${dep.status}">${dep.status}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:13px">
          <span>Allocated: <strong>${formatBytes(allocated)}</strong></span>
          ${actual > 0 ? `<span>Used: <strong>${formatBytes(actual)}</strong> (${diskPctUsed}%)</span>` : ''}
        </div>
        <div class="progress-bar"><div class="progress-fill ${progressColor(diskPctUsed)}" style="width:${diskPctUsed || barWidth}%"></div></div>
        ${diskDetails ? `<div style="display:flex;gap:12px;flex-wrap:wrap">${diskDetails}</div>` : ''}
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

// Gotify test button
const testNotifyBtn = document.getElementById('test-notify-btn');

fetch('/api/notifier/status').then(r => r.json()).then(data => {
  if (data.enabled) testNotifyBtn.classList.remove('hidden');
}).catch(() => {});

testNotifyBtn.addEventListener('click', async () => {
  testNotifyBtn.disabled = true;
  testNotifyBtn.textContent = '🔔 Sending...';
  testNotifyBtn.className = 'notify-btn';
  try {
    const res = await fetch('/api/notifier/test', { method: 'POST' });
    if (res.ok) {
      testNotifyBtn.textContent = '🔔 Sent!';
      testNotifyBtn.classList.add('success');
    } else {
      const err = await res.json();
      testNotifyBtn.textContent = '🔔 Failed';
      testNotifyBtn.classList.add('error');
      console.error('Notify test failed:', err.error);
    }
  } catch (e) {
    testNotifyBtn.textContent = '🔔 Failed';
    testNotifyBtn.classList.add('error');
  }
  testNotifyBtn.disabled = false;
  setTimeout(() => {
    testNotifyBtn.textContent = '🔔 Test';
    testNotifyBtn.className = 'notify-btn';
  }, 3000);
});

// Init
document.getElementById('refresh-btn').addEventListener('click', fetchData);
document.getElementById('detail-overlay').addEventListener('click', closeDetail);
document.getElementById('detail-close').addEventListener('click', closeDetail);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDetail(); });
fetchData();
