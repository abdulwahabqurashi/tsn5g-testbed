/**
 * DS-TT Dashboard — Frontend Application
 *
 * Polls the DS-TT REST API and renders status, stats, modem,
 * gPTP, and bridge information in the dashboard panels.
 */

const REFRESH_INTERVAL = 2000; // ms

let currentPanel = 'overview';
let refreshTimer = null;

// --- Navigation ---

document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const panel = btn.dataset.panel;
        switchPanel(panel);
    });
});

function switchPanel(panel) {
    currentPanel = panel;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-panel="${panel}"]`).classList.add('active');
    document.getElementById(`panel-${panel}`).classList.add('active');
    refreshData();
}

// --- API Fetching ---

async function fetchApi(endpoint) {
    try {
        const resp = await fetch(`/api/${endpoint}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return await resp.json();
    } catch (e) {
        console.error(`API fetch /api/${endpoint} failed:`, e);
        return null;
    }
}

// --- Data Refresh ---

async function refreshData() {
    const now = new Date().toLocaleTimeString();
    document.getElementById('last-update').textContent = now;

    switch (currentPanel) {
        case 'overview':
            await refreshOverview();
            break;
        case 'modem':
            await refreshModem();
            break;
        case 'bridge':
            await refreshBridge();
            break;
        case 'gptp':
            await refreshGptp();
            break;
        case 'stats':
            await refreshStats();
            break;
    }

    // Always update health badge
    await refreshHealthBadge();
}

// --- Overview Panel ---

async function refreshOverview() {
    const status = await fetchApi('status');
    if (!status) return;

    // Modem card
    const m = status.modem || {};
    setText('ov-modem-reg', m.registered ? badge('Registered', 'ok') : badge('Not Registered', 'err'));
    setText('ov-modem-pdu', m.pdu_active ? badge('Active', 'ok') : badge('Inactive', 'warn'));
    setText('ov-modem-mac', m.mac_address || '--');
    const rsrp = m.signal?.rsrp;
    setText('ov-modem-rsrp', rsrp != null ? `${rsrp} dBm` : '--');

    // Bridge card
    const b = status.bridge || {};
    setText('ov-bridge-name', b.name || '--');
    setText('ov-bridge-status', b.created ? badge('Up', 'ok') : badge('Down', 'err'));
    setText('ov-bridge-ifaces', (b.interfaces || []).join(', ') || '--');
    setText('ov-bridge-vlan', b.vlan_filtering ? 'Enabled' : 'Disabled');

    // gPTP card
    const g = status.gptp || {};
    setText('ov-gptp-status', g.running ? badge('Running', 'ok') :
        (g.enabled ? badge('Stopped', 'err') : badge('Disabled', 'info')));
    const ptp4l = g.ptp4l;
    setText('ov-gptp-ptp4l', ptp4l ? (ptp4l.alive ? badge('Alive', 'ok') : badge('Dead', 'err')) : '--');
    const ci = g.clock_info;
    setText('ov-gptp-offset', ci?.offset_from_master_ns ? `${ci.offset_from_master_ns} ns` : '--');
    setText('ov-gptp-delay', ci?.mean_path_delay_ns ? `${ci.mean_path_delay_ns} ns` : '--');

    // Health card
    setText('ov-health-state', status.state || '--');

    // Fetch stats for uptime
    const stats = await fetchApi('stats');
    setText('ov-health-uptime', stats?.uptime_seconds ? formatUptime(stats.uptime_seconds) : '--');

    // Fetch health
    const health = await fetchApi('health');
    if (health) {
        const checks = health.checks || {};
        setText('ov-health-modem', checks.modem ? badge('OK', 'ok') : badge('Fail', 'err'));
        setText('ov-health-bridge', checks.bridge ? badge('OK', 'ok') : badge('Fail', 'err'));
    }
}

// --- Modem Panel ---

async function refreshModem() {
    const data = await fetchApi('modem');
    if (!data) return;

    const tbody = document.querySelector('#modem-detail-table tbody');
    tbody.innerHTML = '';

    const rows = [
        ['Device', data.device],
        ['WWAN Interface', data.wwan_interface],
        ['DNN', data.dnn],
        ['CID', data.cid],
        ['Registered', data.registered ? 'Yes' : 'No'],
        ['PDU Active', data.pdu_active ? 'Yes' : 'No'],
        ['MAC Address', data.mac_address || '--'],
    ];

    if (data.signal?.raw) {
        rows.push(['Raw Signal', data.signal.raw]);
    }

    rows.forEach(([key, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${key}</td><td>${val}</td>`;
        tbody.appendChild(tr);
    });

    // Signal bars
    const sig = data.signal || {};
    updateSignalBar('rsrp', sig.rsrp, -140, -44, 'dBm');
    updateSignalBar('rsrq', sig.rsrq, -20, -3, 'dB');
    updateSignalBar('sinr', sig.sinr, -5, 30, 'dB');
}

function updateSignalBar(name, value, min, max, unit) {
    const bar = document.getElementById(`bar-${name}`);
    const valEl = document.getElementById(`val-${name}`);

    if (value == null) {
        bar.style.width = '0%';
        valEl.textContent = `-- ${unit}`;
        return;
    }

    const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
    bar.style.width = `${pct}%`;
    valEl.textContent = `${value} ${unit}`;

    bar.className = 'bar-fill';
    if (pct > 60) bar.classList.add('good');
    else if (pct > 30) bar.classList.add('fair');
    else bar.classList.add('poor');
}

// --- Bridge Panel ---

async function refreshBridge() {
    const data = await fetchApi('bridge');
    if (!data) return;

    // Config table
    const tbody = document.querySelector('#bridge-detail-table tbody');
    tbody.innerHTML = '';
    const rows = [
        ['Name', data.name],
        ['Created', data.created ? 'Yes' : 'No'],
        ['STP', data.stp ? 'Enabled' : 'Disabled'],
        ['VLAN Filtering', data.vlan_filtering ? 'Enabled' : 'Disabled'],
        ['Group Fwd Mask', data.group_fwd_mask],
        ['Bridge ID', data.bridge_id || '--'],
        ['Root ID', data.root_id || '--'],
        ['Interfaces', (data.interfaces || []).join(', ')],
    ];
    rows.forEach(([key, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${key}</td><td>${val}</td>`;
        tbody.appendChild(tr);
    });

    // MAC table
    const macTbody = document.querySelector('#bridge-mac-table tbody');
    macTbody.innerHTML = '';
    const macs = data.interface_macs || {};
    Object.entries(macs).forEach(([iface, mac]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${iface}</td><td>${mac}</td>`;
        macTbody.appendChild(tr);
    });

    // FDB entries
    const fdb = data.mac_table || [];
    document.getElementById('bridge-fdb').textContent = fdb.length > 0 ? fdb.join('\n') : 'No FDB entries';
}

// --- gPTP Panel ---

async function refreshGptp() {
    const data = await fetchApi('gptp');
    if (!data) return;

    // Config table
    const tbody = document.querySelector('#gptp-detail-table tbody');
    tbody.innerHTML = '';
    const rows = [
        ['Enabled', data.enabled ? 'Yes' : 'No'],
        ['Time Domain', data.time_domain_number],
        ['Transport Specific', data.transport_specific],
        ['HW Interfaces', (data.hw_interfaces || []).join(', ') || 'None'],
        ['Running', data.running ? 'Yes' : 'No'],
    ];

    if (data.ptp4l) {
        rows.push(['ptp4l PID', data.ptp4l.pid]);
        rows.push(['ptp4l Alive', data.ptp4l.alive ? 'Yes' : 'No']);
    }
    if (data.phc2sys) {
        rows.push(['phc2sys PID', data.phc2sys.pid]);
        rows.push(['phc2sys Alive', data.phc2sys.alive ? 'Yes' : 'No']);
    }

    rows.forEach(([key, val]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${key}</td><td>${val}</td>`;
        tbody.appendChild(tr);
    });

    // Clock table
    const clockTbody = document.querySelector('#gptp-clock-table tbody');
    clockTbody.innerHTML = '';
    const ci = data.clock_info;
    if (ci) {
        const clockRows = [
            ['Offset from Master', ci.offset_from_master_ns ? `${ci.offset_from_master_ns} ns` : '--'],
            ['Mean Path Delay', ci.mean_path_delay_ns ? `${ci.mean_path_delay_ns} ns` : '--'],
        ];
        clockRows.forEach(([key, val]) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${key}</td><td>${val}</td>`;
            clockTbody.appendChild(tr);
        });
    } else {
        const tr = document.createElement('tr');
        tr.innerHTML = '<td colspan="2">No clock data available</td>';
        clockTbody.appendChild(tr);
    }
}

// --- Stats Panel ---

async function refreshStats() {
    const data = await fetchApi('stats');
    if (!data) return;

    document.getElementById('stats-uptime').textContent =
        data.uptime_seconds ? data.uptime_seconds.toFixed(1) : '--';

    const container = document.getElementById('stats-container');
    container.innerHTML = '';

    const interfaces = data.interfaces || {};
    Object.values(interfaces).forEach(ifaceData => {
        const div = document.createElement('div');
        div.className = 'iface-stats';

        const h4 = document.createElement('h4');
        h4.textContent = ifaceData.interface;
        div.appendChild(h4);

        const grid = document.createElement('div');
        grid.className = 'stats-grid';

        const counters = ifaceData.counters || {};
        const rates = ifaceData.rates || {};

        const items = [
            ['RX Packets', counters.rx_packets, rates.rx_packets_per_sec, 'pps'],
            ['TX Packets', counters.tx_packets, rates.tx_packets_per_sec, 'pps'],
            ['RX Bytes', formatBytes(counters.rx_bytes), rates.rx_bytes_per_sec ? formatBytes(rates.rx_bytes_per_sec) + '/s' : null],
            ['TX Bytes', formatBytes(counters.tx_bytes), rates.tx_bytes_per_sec ? formatBytes(rates.tx_bytes_per_sec) + '/s' : null],
            ['RX Errors', counters.rx_errors, null],
            ['TX Errors', counters.tx_errors, null],
            ['RX Dropped', counters.rx_dropped, null],
            ['Multicast', counters.multicast, null],
        ];

        items.forEach(([label, value, rate, rateUnit]) => {
            const item = document.createElement('div');
            item.className = 'stat-item';

            let html = `<span class="stat-label">${label}</span>`;
            html += `<span class="stat-value">${value ?? '--'}</span>`;
            if (rate != null) {
                const display = rateUnit ? `${rate} ${rateUnit}` : rate;
                html += `<span class="stat-rate">${display}</span>`;
            }

            item.innerHTML = html;
            grid.appendChild(item);
        });

        div.appendChild(grid);
        container.appendChild(div);
    });
}

// --- Health Badge ---

async function refreshHealthBadge() {
    const health = await fetchApi('health');
    const badge = document.getElementById('health-badge');
    const label = badge.querySelector('.label');

    badge.className = 'health-indicator';

    if (!health) {
        label.textContent = 'Disconnected';
        return;
    }

    if (health.healthy) {
        badge.classList.add('healthy');
        label.textContent = 'Healthy';
    } else {
        badge.classList.add('unhealthy');
        const failed = Object.entries(health.checks || {})
            .filter(([, v]) => !v)
            .map(([k]) => k);
        label.textContent = `Unhealthy: ${failed.join(', ')}`;
    }
}

// --- Utility Functions ---

function setText(id, html) {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
}

function badge(text, type) {
    return `<span class="badge badge-${type}">${text}</span>`;
}

function formatUptime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
}

function formatBytes(bytes) {
    if (bytes == null) return '--';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
    return `${(bytes / 1073741824).toFixed(2)} GB`;
}

// --- Auto-refresh Loop ---

function startRefresh() {
    refreshData();
    refreshTimer = setInterval(refreshData, REFRESH_INTERVAL);
}

startRefresh();
