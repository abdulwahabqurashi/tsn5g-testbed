import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { getActiveSite, onSiteChange } from 'helpers/site';

const Wrap = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
`;
const KpiRow = styled.div`
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 1.25rem;
`;
const Kpi = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; padding: 14px 16px;
  .v { font-size: 26px; font-weight: 800; color: ${p => p.c || 'var(--text-primary)'}; }
  .l { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-muted); margin-top: 2px; }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; overflow: hidden;
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 13px;
  th { text-align: left; padding: 10px 14px; color: var(--text-muted); font-weight: 600;
    border-bottom: 1px solid var(--divider); background: var(--bg-panel-header); }
  td { padding: 10px 14px; border-bottom: 1px solid var(--divider); color: var(--text-secondary); }
  tr:last-child td { border-bottom: none; }
  .id { font-weight: 700; color: var(--text-primary); }
  .m { font-family: monospace; font-size: 12px; }
  .site { display: inline-flex; align-items: center; gap: 6px; }
  .sdot { width: 9px; height: 9px; border-radius: 3px; }
  .up { color: var(--ok); font-weight: 700; } .down { color: var(--bad); font-weight: 700; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 6px; background: #f0f2f5; color: var(--text-secondary); }
`;

class RanInventoryView extends Component {
  state = { gnbs: [], groups: [], active: '_all' };
  componentDidMount() {
    this.setState({ active: getActiveSite() });
    this.load(); this._t = setInterval(() => this.load(), 5000);
    this._off = onSiteChange(e => this.setState({ active: e.detail }));
  }
  componentWillUnmount() { if (this._t) clearInterval(this._t); if (this._off) this._off(); }
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  load() {
    const h = this.headers();
    axios({ baseURL: '/api/amf', url: '/GnbInfo', method: 'get', headers: h })
      .then(r => this.setState({ gnbs: ((r.data || {}).items) || [] })).catch(() => {});
    axios({ baseURL: '/api/sites', url: '/Grouped', method: 'get', headers: h })
      .then(r => this.setState({ groups: ((r.data || {}).groups) || [] })).catch(() => {});
  }
  siteOfGnb(gid) {
    const g = this.state.groups.filter(gr => (gr.gnbs || []).some(x => x.gnb_id === gid))[0];
    return g || null;
  }
  render() {
    let gnbs = this.state.gnbs;
    const active = this.state.active;
    if (active !== '_all') {
      const grp = this.state.groups.filter(g => g.site_id === active)[0];
      const ids = grp ? (grp.gnbs || []).map(x => x.gnb_id) : [];
      gnbs = gnbs.filter(g => ids.indexOf(g.gnb_id) >= 0);
    }
    const totalUes = gnbs.reduce((a, g) => a + (g.num_connected_ues || 0), 0);
    const up = gnbs.filter(g => (g.ng || {}).setup_success !== false).length;
    const tacs = {}; gnbs.forEach(g => (g.supported_ta_list || []).forEach(t => tacs[t.tac] = 1));

    return (
      <Wrap>
        <TitleRow>
          <div>
            <h2>RAN Inventory</h2>
            <span className="sub">Connected gNodeBs &amp; cells · from the AMF · {active === '_all' ? 'all sites' : 'filtered by site'}</span>
          </div>
        </TitleRow>
        <KpiRow>
          <Kpi c="#478ff7"><div className="v">{gnbs.length}</div><div className="l">gNodeBs</div></Kpi>
          <Kpi c="#43c478"><div className="v">{up}</div><div className="l">NG established</div></Kpi>
          <Kpi c="#9e7be0"><div className="v">{Object.keys(tacs).length}</div><div className="l">Tracking areas</div></Kpi>
          <Kpi c="#27b8dc"><div className="v">{totalUes}</div><div className="l">Connected UEs</div></Kpi>
        </KpiRow>
        <Card>
          <Table>
            <thead><tr><th>gNB ID</th><th>Site</th><th>PLMN</th><th>TAC</th><th>Slice (S-NSSAI)</th><th>NG</th><th>SCTP peer</th><th>UEs</th></tr></thead>
            <tbody>
              {gnbs.map((g, i) => {
                const site = this.siteOfGnb(g.gnb_id);
                const ta = (g.supported_ta_list || [])[0] || {};
                const snssai = (((ta.bplmns || [])[0] || {}).snssai || [])[0] || {};
                const ngUp = (g.ng || {}).setup_success !== false;
                return (
                  <tr key={i}>
                    <td className="id">{g.gnb_id}</td>
                    <td>{site ?
                      <span className="site"><span className="sdot" style={{background: site.color}}/>{site.name}</span> :
                      <span className="pill">Unassigned</span>}</td>
                    <td className="m">{g.plmn}</td>
                    <td className="m">{(g.supported_ta_list || []).map(t => t.tac).join(', ')}</td>
                    <td className="m">{snssai.sst != null ? 'sst ' + snssai.sst + (snssai.sd ? ' / ' + snssai.sd : '') : '—'}</td>
                    <td className={ngUp ? 'up' : 'down'}>{ngUp ? 'up' : 'down'}</td>
                    <td className="m">{((g.ng || {}).sctp || {}).peer || '—'}</td>
                    <td>{g.num_connected_ues || 0}</td>
                  </tr>
                );
              })}
              {gnbs.length === 0 &&
                <tr><td colSpan="8" style={{textAlign:'center', color:'var(--text-muted)', padding:'2rem'}}>No gNodeBs connected.</td></tr>}
            </tbody>
          </Table>
        </Card>
      </Wrap>
    );
  }
}
export default RanInventoryView;
