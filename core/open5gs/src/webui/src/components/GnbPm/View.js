import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';

const Wrap = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
`;
const Banner = styled.div`
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 14px 18px; margin-bottom: 1.25rem;
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${p => p.c};
    box-shadow: 0 0 0 4px ${p => p.soft}; }
  .txt { font-size: 15px; font-weight: 700; color: var(--text-primary); }
  .meta { margin-left: auto; font-size: 12px; color: var(--text-muted); font-family: monospace; }
`;
const Grid = styled.div`
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 1.25rem;
`;
const Kpi = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 12px; padding: 14px 16px;
  cursor: pointer; border: 2px solid ${p => p.active ? 'var(--accent)' : 'transparent'};
  .v { font-size: 22px; font-weight: 800; color: var(--text-primary); font-variant-numeric: tabular-nums; }
  .n { font-size: 11px; color: var(--text-muted); font-family: monospace; margin-top: 3px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; padding: 18px;
  h3 { margin: 0 0 4px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
  .note { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
  code { background: var(--bg-input); padding: 1px 5px; border-radius: 4px; }
`;

class GnbPmView extends Component {
  state = { latest: null, kpis: [], selected: null, series: [] };
  componentDidMount() { this.load(); this._t = setInterval(() => this.load(), 15000); }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  load() {
    axios({ baseURL: '/api/gnb-pm', url: '/Latest', method: 'get', headers: this.headers() })
      .then(r => {
        const latest = r.data;
        const kpis = latest ? (latest.kpis || []) : [];
        const selected = this.state.selected || (kpis[0] && kpis[0].name);
        this.setState({ latest, kpis });
        if (selected) this.loadSeries(selected);
      }).catch(() => {});
  }
  loadSeries(kpi) {
    this.setState({ selected: kpi });
    axios({ baseURL: '/api/gnb-pm', url: '/History', method: 'get', headers: this.headers(), params: { kpi, limit: 200 } })
      .then(r => this.setState({ series: (r.data || []).map(x => ({ t: new Date(x.ts).toLocaleTimeString(), v: x.value })) }))
      .catch(() => {});
  }
  render() {
    const { latest, kpis, selected, series } = this.state;
    const has = latest != null;
    const ageMin = has ? Math.round((Date.now() - new Date(latest.received)) / 60000) : null;
    return (
      <Wrap>
        <TitleRow>
          <div>
            <h2>gNB Performance</h2>
            <span className="sub">3GPP PM counters uploaded by the gNB · MR (per-UE RSRP/SINR) not supported by this gNB firmware</span>
          </div>
        </TitleRow>

        {has ?
          <Banner c="#43c478" soft="rgba(67,196,120,0.18)">
            <div className="dot"/>
            <div className="txt">Receiving PM data{latest.gnb_id ? ' from gNB ' + latest.gnb_id : ''}</div>
            <div className="meta">
              {kpis.length} KPIs · {latest.granularity_s ? latest.granularity_s + 's period · ' : ''}
              last {ageMin}m ago · {latest.source_ip || ''}
            </div>
          </Banner> :
          <Banner c="#f5a524" soft="rgba(245,165,36,0.18)">
            <div className="dot"/>
            <div className="txt">No PM data received yet</div>
            <div className="meta">configure the gNB to upload (below)</div>
          </Banner>}

        {has &&
          <Grid>
            {kpis.map(k =>
              <Kpi key={k.name} active={k.name === selected} onClick={() => this.loadSeries(k.name)}>
                <div className="v">{k.value != null ? k.value.toLocaleString() : '--'}</div>
                <div className="n" title={k.name}>{k.name}</div>
              </Kpi>)}
          </Grid>}

        {has && selected &&
          <Card style={{marginBottom:'1.25rem'}}>
            <h3>{selected} — history</h3>
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={series} margin={{top:4,right:6,left:-8,bottom:0}}>
                <defs><linearGradient id="gPm" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#478ff7" stopOpacity={0.18}/>
                  <stop offset="100%" stopColor="#478ff7" stopOpacity={0}/></linearGradient></defs>
                <CartesianGrid stroke="var(--divider)" vertical={false}/>
                <XAxis dataKey="t" axisLine={false} tickLine={false} tick={{fontSize:11, fill:'var(--text-muted)'}}/>
                <YAxis axisLine={false} tickLine={false} tick={{fontSize:11, fill:'var(--text-muted)'}}/>
                <Tooltip contentStyle={{background:'#fff', border:'none', borderRadius:10, boxShadow:'0 4px 16px rgba(16,24,40,0.14)', fontSize:12}}/>
                <Area type="monotone" dataKey="v" name={selected} stroke="#478ff7" strokeWidth={2} fill="url(#gPm)" dot={false} isAnimationActive={false}/>
              </AreaChart>
            </ResponsiveContainer>
          </Card>}

        <Card>
          <h3>Setup — point the gNB here</h3>
          <p className="note">In the gNB GUI: <b>BTS Setting → Performance Management</b>, set:</p>
          <div style={{fontSize:13, color:'var(--text-secondary)', lineHeight:1.9}}>
            Performance Management <b>ON</b><br/>
            URL <code>http://10.5.0.84:9999/api/gnb-pm/upload</code><br/>
            Username <code>gnb</code> · Password <code>gnb</code> <span style={{color:'var(--text-muted)'}}>(override via GNB_PM_USER / GNB_PM_PASS)</span><br/>
            Periodic Upload Interval <code>900</code> (or shorter for testing) · then <b>Save</b> and reboot the gNB.
          </div>
          <p className="note" style={{marginTop:12}}>The gNB will push 3GPP PM files here on each interval; parsed KPIs appear above (30-day retention).</p>
        </Card>
      </Wrap>
    );
  }
}
export default GnbPmView;
