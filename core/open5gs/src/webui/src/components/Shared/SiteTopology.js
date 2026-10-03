import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { getActiveSite, onSiteChange } from 'helpers/site';
import { TopoIcon } from './TopoIcons';

/* ============================================================
 * SiteTopology — boxed multi-site map.
 * Side-by-side site containers; each holds its RAN (gNB) and UE
 * tiles. The shared Core sits centred with arrows from each site's
 * RAN. Vector icons throughout. Honors the header site filter.
 * ============================================================ */

const Wrap = styled.div`
  width: 100%; overflow-x: auto;
  svg { display: block; height: auto; max-width: 100%; margin: 0; }
  .site-box { fill: #fafbfc; stroke: #e4e6ea; stroke-width: 1.5; }
  .site-name { font: 700 11px 'Inter',sans-serif; }
  .node { fill: #ffffff; stroke: #d7dbe0; stroke-width: 1.4;
    filter: drop-shadow(0 1px 3px rgba(16,24,40,0.06)); }
  .node-lbl { font: 700 10.5px 'Inter',sans-serif; fill: #1d2126; }
  .node-sub { font: 500 9px 'Inter',sans-serif; fill: #85898f; }
  .core-box { fill: #ffffff; stroke: #0a2540; stroke-width: 1.6;
    filter: drop-shadow(0 2px 8px rgba(16,24,40,0.12)); }
  .title { font: 800 12px 'Inter',sans-serif; fill: #1d2126; }
  .arrow { fill: none; stroke: #50565e; stroke-width: 1.6; }
  .flow { fill: none; stroke: #43c478; stroke-width: 2; stroke-dasharray: 4 7;
    animation: sflow 1.1s linear infinite; }
  @keyframes sflow { to { stroke-dashoffset: -22; } }
  .status { }
`;
const Empty = styled.div`
  padding: 2rem; text-align: center; color: var(--text-muted); font-size: 13px;
`;

class SiteTopology extends Component {
  state = { groups: [], active: '_all' };
  componentDidMount() {
    this.setState({ active: getActiveSite() });
    this.load();
    this._t = setInterval(() => this.load(), 5000);
    this._off = onSiteChange((e) => this.setState({ active: e.detail }));
  }
  componentWillUnmount() { if (this._t) clearInterval(this._t); if (this._off) this._off(); }
  load() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    axios({ baseURL: '/api/sites', url: '/Grouped', method: 'get', headers: h })
      .then(r => this.setState({ groups: (r.data || {}).groups || [] })).catch(() => {});
  }

  render() {
    let groups = this.state.groups.filter(g => (g.gnbs || []).length > 0 || g.ues > 0);
    if (this.state.active !== '_all')
      groups = groups.filter(g => g.site_id === this.state.active);
    if (!groups.length)
      return <Empty>No sites with connected gNBs. Assign a TAC to a site, or connect a gNB.</Empty>;

    /* geometry: side-by-side site containers; the Core lives inside the
     * site that hosts the control plane (hosts_core), with every RAN
     * arrowing to it. */
    var COL_W = 176, GAP = 18, PAD = 24, TOP = 30;
    var W = PAD * 2 + groups.length * COL_W + (groups.length - 1) * GAP;
    var boxTop = TOP + 14;
    var coreY = boxTop + 36;    /* Core row inside host site */
    var coreH = 42, coreW = 120;
    var ranY = coreY + 70;      /* RAN row (all sites) */
    var ueY = ranY + 66;        /* UE row */
    var boxH = ueY + 44 - boxTop + 12;
    var H = boxTop + boxH + 12;

    var cols = groups.map(function(g, i) {
      return { g: g, x: PAD + i * (COL_W + GAP), cx: PAD + i * (COL_W + GAP) + COL_W / 2 };
    });
    /* find the host-site column (Core target); fallback = first column */
    var host = cols.filter(function(c) { return c.g.hosts_core; })[0] || cols[0];
    var coreCx = host.cx, coreBottom = coreY + coreH;

    return (
      <Wrap>
        <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{maxWidth:'100%'}}>
          <text className="title" x={W / 2} y="22" textAnchor="middle">
            {this.state.active === '_all' ? 'AMRC 5G-TSN' : (cols[0] ? cols[0].g.name : '')}
          </text>

          {/* site containers */}
          {cols.map(function(col) {
            var g = col.g, color = g.color || '#478ff7';
            return (
              <g key={'box-' + g.site_id}>
                <rect className="site-box" x={col.x} y={boxTop} width={COL_W} height={boxH} rx="14"/>
                <rect x={col.x} y={boxTop} width={COL_W} height="22" rx="12" fill={color} opacity="0.10"/>
                <text className="site-name" x={col.cx} y={boxTop + 15} textAnchor="middle" fill={color}>
                  {g.name}{g.hosts_core ? '  ·  Core' : ''}
                </text>
              </g>
            );
          })}

          {/* RAN → Core arrows (drawn under nodes) */}
          {cols.map(function(col) {
            var g = col.g;
            var active = (g.connected_ues || 0) > 0;
            var ranCx = col.cx, ranTopY = ranY;
            var d;
            if (col === host) {
              /* straight up to its own Core */
              d = 'M ' + ranCx + ' ' + ranTopY + ' L ' + ranCx + ' ' + coreBottom;
            } else {
              /* out the side, across to the host Core */
              var side = col.cx < coreCx ? 1 : -1;
              var midY = coreY + coreH / 2;
              d = 'M ' + ranCx + ' ' + ranTopY +
                  ' L ' + ranCx + ' ' + midY +
                  ' L ' + (coreCx - side * (coreW / 2)) + ' ' + midY;
            }
            return (
              <g key={'arr-' + g.site_id}>
                <path className="arrow" markerEnd="url(#ah)" d={d}/>
                {active && <path className="flow" d={d}/>}
              </g>
            );
          })}
          <defs>
            <marker id="ah" markerWidth="8" markerHeight="8" refX="6" refY="3"
              orient="auto"><path d="M0 0 L6 3 L0 6" fill="none" stroke="#50565e" strokeWidth="1.4"/></marker>
          </defs>

          {/* Core box (inside host site) */}
          <g transform={'translate(' + (coreCx - coreW / 2) + ',' + coreY + ')'}>
            <rect className="core-box" width={coreW} height={coreH} rx="10"/>
            {TopoIcon('core', 9, 10, 22, '#0a2540')}
            <text className="node-lbl" x="38" y="19">5G Core</text>
            <text className="node-sub" x="38" y="31">AMF·SMF·NRF</text>
          </g>

          {/* RAN + UE tiles per site */}
          {cols.map(function(col) {
            var g = col.g, color = g.color || '#478ff7';
            var gnb = (g.gnbs && g.gnbs[0]) || { gnb_id: '—', up: false };
            return (
              <g key={'nodes-' + g.site_id}>
                <g transform={'translate(' + (col.cx - 50) + ',' + ranY + ')'}>
                  <rect className="node" width="100" height="46" rx="10"/>
                  {TopoIcon('ran', 8, 11, 24, color)}
                  <text className="node-lbl" x="38" y="21">RAN</text>
                  <text className="node-sub" x="38" y="33">gNB {gnb.gnb_id}</text>
                  <circle cx="90" cy="10" r="3.5" fill={gnb.up ? '#43c478' : '#d1d5db'}/>
                </g>
                <g transform={'translate(' + (col.cx - 50) + ',' + ueY + ')'}>
                  <rect className="node" width="100" height="44" rx="10"/>
                  {TopoIcon('ue', 8, 10, 22, '#27b8dc')}
                  <text className="node-lbl" x="36" y="20">UE</text>
                  <text className="node-sub" x="36" y="32">{g.connected_ues || 0}/{g.ues || 0} conn.</text>
                </g>
              </g>
            );
          })}
        </svg>
      </Wrap>
    );
  }
}

export default SiteTopology;
