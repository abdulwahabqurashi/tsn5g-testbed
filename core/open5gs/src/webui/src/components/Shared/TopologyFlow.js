import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { TopoIcon } from './TopoIcons';

/* ============================================================
 * TopologyFlow — modern 5G-TSN network topology (pure SVG)
 * UniFi-style horizontal flow:
 *   [TSN Network] ~ [UPF · NW-TT] ~ [gNB] ~ [UE/DS-TT] ~ [devices]
 * Rounded node cards, curved connectors, animated traffic flow.
 * ============================================================ */

const Wrap = styled.div`
  width: 100%;

  svg { display: block; width: 100%; height: auto; }

  .node-card {
    fill: #ffffff;
    stroke: #e8eaed;
    stroke-width: 1;
    filter: drop-shadow(0 2px 6px rgba(16,24,40,0.08));
    cursor: ${p => p.clickable ? 'pointer' : 'default'};
    transition: stroke .12s ease;
  }
  .node-card.selected { stroke: #006fff; stroke-width: 2; }
  .node-card:hover { stroke: #b8d4ff; }

  .node-title { font: 700 13px 'Inter', sans-serif; fill: #1d2126; }
  .node-sub   { font: 500 10.5px 'Inter', sans-serif; fill: #85898f; }
  .tile-text  { font: 800 11px 'Inter', sans-serif; fill: #ffffff; }
  .link-label { font: 600 10px 'Inter', sans-serif; fill: #85898f; }
  .link-rate  { font: 600 10px 'Inter', sans-serif; fill: #478ff7; }

  .link-base { fill: none; stroke: #dfe3e8; stroke-width: 2; }
  .link-base.up { stroke: #c7e8d4; }
  .link-flow {
    fill: none;
    stroke: #43c478;
    stroke-width: 2;
    stroke-dasharray: 4 8;
    animation: topo-dash 1.2s linear infinite;
  }
  @keyframes topo-dash {
    to { stroke-dashoffset: -24; }
  }
`;

const TILE_COLORS = {
  dn:     '#0a2540',
  upf:    '#006fff',
  gnb:    '#9e7be0',
  ue:     '#27b8dc',
  device: '#43c478',
};

const NODE_W = 168;
const NODE_H = 58;

function short(mac) {
  if (!mac) return '';
  return mac.length > 17 ? mac.slice(0, 17) : mac;
}

class TopologyFlow extends Component {
  state = { vendors: {} };

  componentDidMount() { this.resolveVendors(); }
  componentDidUpdate(prev) {
    const a = ((prev.ports || [])[0] || {}).ue_macs || [];
    const b = ((this.props.ports || [])[0] || {}).ue_macs || [];
    if (a.join(',') !== b.join(',')) this.resolveVendors();
  }

  /* resolve OUI vendor for the current device MACs (self-contained) */
  resolveVendors() {
    const macs = ((this.props.ports || [])[0] || {}).ue_macs || [];
    if (!macs.length) return;
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    axios({ baseURL: '/api/oui', url: '/Lookup', method: 'get', headers: h,
      params: { macs: macs.join(',') } })
      .then(r => {
        const v = {};
        (r.data || []).forEach(d => { v[d.mac] = d; });
        this.setState({ vendors: v });
      }).catch(() => {});
  }

  handle(node) {
    if (this.props.onSelect) this.props.onSelect(node);
  }

  /* rounded node card with a colored glyph tile, title, subtitle,
   * and a status dot */
  node(x, y, node, key) {
    const selected = this.props.selectedId === node.id;
    const tile = TILE_COLORS[node.kind] || '#85898f';
    const ICON = { dn: 'dn', upf: 'bridge', gnb: 'ran', ue: 'ue', device: 'device' };
    return (
      <g key={key} transform={`translate(${x},${y})`}
          onClick={() => this.handle(node)}>
        <rect className={'node-card' + (selected ? ' selected' : '')}
          width={NODE_W} height={NODE_H} rx="13"/>
        <rect x="10" y="13" width="32" height="32" rx="9" fill={tile} opacity="0.12"/>
        {TopoIcon(ICON[node.kind] || 'device', 13, 16, 26, tile)}
        <text className="node-title" x="52" y="26">{node.title}</text>
        <text className="node-sub" x="52" y="42">{node.sub}</text>
        <circle cx={NODE_W - 12} cy="12" r="4"
          fill={node.up ? '#43c478' : '#d1d5db'}/>
      </g>
    );
  }

  /* smooth horizontal bezier between node edges, with optional
   * animated flow overlay and labels */
  link(x1, y1, x2, y2, opts, key) {
    const mx = (x1 + x2) / 2;
    const d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
    const lx = mx;
    const ly = Math.min(y1, y2) - 8 + Math.abs(y2 - y1) / 2;
    return (
      <g key={key}>
        <path className={'link-base' + (opts.up ? ' up' : '')} d={d}/>
        {opts.active && <path className="link-flow" d={d}/>}
        {opts.label &&
          <text className="link-label" x={lx} y={ly - 4}
            textAnchor="middle">{opts.label}</text>}
        {opts.rate &&
          <text className="link-rate" x={lx} y={ly + 10}
            textAnchor="middle">{opts.rate}</text>}
      </g>
    );
  }

  render() {
    const {
      bridge = {}, ports = [], gnbCount = 0,
      dlRate, ulRate, coreLabel
    } = this.props;

    const devices = (ports[0] && ports[0].ue_macs) || [];
    const nDev = Math.max(devices.length, 1);
    const rowH = 74;
    const H = Math.max(170, nDev * rowH + 40);
    const midY = H / 2 - NODE_H / 2;
    const cx = [20, 270, 520, 770, 1020];   /* column x positions */

    const bridgeUp = !!bridge.id || ports.length > 0;
    const gnbUp = gnbCount > 0;
    const sessUp = ports.length > 0;
    const active = sessUp && gnbUp;

    const dn = { id: 'dn', kind: 'dn', glyph: 'DN', up: true,
      title: coreLabel || 'TSN Network', sub: 'tsn-br-1 · 192.168.8.5' };
    const upf = { id: 'upf', kind: 'upf', glyph: 'UPF', up: bridgeUp,
      title: '5GS Bridge', sub: 'NW-TT · ' + (bridge.mac || 'bridge') };
    const gnb = { id: 'gnb', kind: 'gnb', glyph: 'gNB', up: gnbUp,
      title: 'gNodeB', sub: gnbUp ? 'NG + N3 established' : 'disconnected' };
    const ue = { id: 'ue', kind: 'ue', glyph: 'UE', up: sessUp,
      title: 'UE · DS-TT',
      sub: sessUp ? 'Ethernet PDU · port ' +
        ports.map(p => p.port_number).join(',') : 'no session' };

    return (
      <Wrap clickable={!!this.props.onSelect}>
        <svg viewBox={`0 0 1210 ${H}`}>
          {/* links first (under the nodes) */}
          {this.link(cx[0] + NODE_W, midY + NODE_H / 2,
            cx[1], midY + NODE_H / 2,
            { up: bridgeUp, active, label: 'N6 · L2' }, 'l0')}
          {this.link(cx[1] + NODE_W, midY + NODE_H / 2,
            cx[2], midY + NODE_H / 2,
            { up: gnbUp, active, label: 'N3 · GTP-U',
              rate: dlRate != null ? '↓ ' + dlRate : null }, 'l1')}
          {this.link(cx[2] + NODE_W, midY + NODE_H / 2,
            cx[3], midY + NODE_H / 2,
            { up: sessUp, active, label: '5G NR',
              rate: ulRate != null ? '↑ ' + ulRate : null }, 'l2')}
          {devices.length ? devices.map((m, i) => {
            const dy = 20 + i * rowH + NODE_H / 2;
            return this.link(cx[3] + NODE_W, midY + NODE_H / 2,
              cx[4], dy, { up: true, active, label: i === 0 ? 'LAN' : null },
              'ld' + i);
          }) : this.link(cx[3] + NODE_W, midY + NODE_H / 2,
            cx[4], midY + NODE_H / 2, { up: false }, 'ld0')}

          {this.node(cx[0], midY, dn, 'n0')}
          {this.node(cx[1], midY, upf, 'n1')}
          {this.node(cx[2], midY, gnb, 'n2')}
          {this.node(cx[3], midY, ue, 'n3')}
          {devices.length ? devices.map((m, i) => {
            const v = this.state.vendors[m];
            const vendor = v && v.known ? v.vendor : null;
            return this.node(cx[4], 20 + i * rowH, {
              id: 'dev-' + m, kind: 'device', up: true,
              title: vendor ? (vendor.length > 20 ? vendor.slice(0, 20) : vendor)
                : 'Device ' + (i + 1),
              sub: short(m), mac: m, vendor: vendor
            }, 'nd' + i);
          }) :
            this.node(cx[4], midY, {
              id: 'dev-none', kind: 'device', glyph: '—', up: false,
              title: 'No devices', sub: 'no MACs learned'
            }, 'nd0')}
        </svg>
      </Wrap>
    );
  }
}

export default TopologyFlow;
