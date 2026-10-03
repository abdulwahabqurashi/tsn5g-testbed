import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

/* ============================================================
 * CNC / Control Plane — the 5GS logical bridge as the TSN-AF
 * (TSCTSF) manages it. Shows real state we have: the configured
 * bridge, its NW-TT ports (PSFP filters, learned devices,
 * de-jitter), host interfaces, and the CNC linkage status (which
 * only populates when an external TSN CNC connects).
 * ============================================================ */

const Wrap = styled.div`width: 100%; padding: .5rem 0;`;
const Section = styled.div`margin-bottom: 1.25rem;`;
const SecTitle = styled.div`
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: var(--text-muted); margin: 0 0 .6rem;
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 16px 18px;
`;
const Grid = styled.div`
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 14px;
  .kv .k { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: .04em; }
  .kv .v { font-size: 14px; font-weight: 600; color: var(--text-primary); font-family: monospace; margin-top: 2px; }
`;
const Badge = styled.span`
  display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 11px; font-weight: 700;
  color: #fff; background: ${p => p.ok ? 'var(--ok)' : 'var(--text-muted)'};
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 13px;
  th { text-align: left; padding: 8px 10px; color: var(--text-muted); font-weight: 600;
    border-bottom: 1px solid var(--divider); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--divider); color: var(--text-secondary);
    font-family: monospace; }
  tr:last-child td { border-bottom: none; }
`;
const Note = styled.div`
  font-size: 12.5px; color: var(--text-secondary); line-height: 1.5;
  b { color: var(--text-primary); }
`;

function KV(props) {
  return <div className="kv"><div className="k">{props.k}</div><div className="v">{props.v == null || props.v === '' ? '—' : props.v}</div></div>;
}

class Dashboard extends Component {
  state = { bridges: [], nwtt: null, ifaces: [], analytics: null, devices: [] };
  componentDidMount() { this.load(); this._t = setInterval(() => this.load(), 5000); }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  get(base, url) {
    return axios({ baseURL: base, url, method: 'get', headers: this.headers() })
      .then(r => r.data).catch(() => null);
  }
  load() {
    this.get('/api/tsn', '/Bridge').then(d => this.setState({ bridges: d || [] }));
    this.get('/api/tsn', '/Interface').then(d => this.setState({ ifaces: d || [] }));
    this.get('/api/tsn', '/Analytics').then(d => this.setState({ analytics: d }));
    this.get('/api/upf', '/TsnInfo').then(d => this.setState({ nwtt: d }));
    this.get('/api/oui', '/Devices').then(d => this.setState({ devices: (d && d.devices) || [] }));
  }

  render() {
    const { bridges, nwtt, ifaces, analytics } = this.state;
    const bridge = bridges[0] || {};
    const ports = (nwtt && nwtt.ports) || [];
    const summary = (analytics && analytics.summary) || {};
    const cncBridge = ((analytics && analytics.bridges) || [])[0] || {};
    const devices = this.state.devices || [];

    return (
      <Wrap>
        <Section>
          <SecTitle>Downstream Devices · MAC vendor lookup</SecTitle>
          <Card>
            {devices.length === 0 ?
              <Note>No downstream devices learned yet. Devices appear as they send traffic through the Ethernet PDU session; each MAC's OUI is resolved to its manufacturer (IEEE registry).</Note> :
              <Table>
                <thead><tr><th>Port</th><th>MAC</th><th>Manufacturer</th><th>Role</th></tr></thead>
                <tbody>
                  {devices.map(function(d, i) {
                    return (
                      <tr key={i}>
                        <td>{d.port}</td>
                        <td>{d.mac}</td>
                        <td style={{fontFamily:'inherit', color: d.known ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: d.known ? 600 : 400}}>
                          {d.vendor}{d.local ? ' ⚠' : ''}
                        </td>
                        <td>{d.role}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>}
          </Card>
        </Section>
        <Section>
          <SecTitle>Logical Bridge</SecTitle>
          <Card>
            <div style={{marginBottom: 14}}>
              <Badge ok={bridge.bridgeStatus === 'active'}>{bridge.bridgeStatus || 'not configured'}</Badge>
            </div>
            <Grid>
              <KV k="Bridge ID" v={bridge.bridgeId}/>
              <KV k="Bridge MAC" v={bridge.bridgeMac}/>
              <KV k="DNN" v={bridge.dnn}/>
              <KV k="Linux bridge" v={bridge.linuxBridge}/>
              <KV k="TAP (device)" v={bridge.tapInterface}/>
              <KV k="UPF TAP" v={bridge.upfTapDevice}/>
              <KV k="Physical NIC" v={bridge.physicalInterface}/>
              <KV k="gPTP" v={(nwtt && nwtt.bridge && nwtt.bridge.gptp_enabled) ? 'enabled' : 'disabled'}/>
            </Grid>
          </Card>
        </Section>

        <Section>
          <SecTitle>NW-TT Ports · translator state</SecTitle>
          <Card>
            {ports.length === 0 ?
              <Note>No active NW-TT ports. A port is created per Ethernet PDU session; connect a UE.</Note> :
              <Table>
                <thead><tr>
                  <th>Port</th><th>Port MAC</th><th>Gateway MAC</th><th>Devices</th>
                  <th>PSFP filters</th><th>PSFP drops</th><th>De-jitter</th>
                </tr></thead>
                <tbody>
                  {ports.map(function(p) {
                    var sf = p.stream_filters || {};
                    var psfp = p.psfp || {};
                    var dj = p.dejitter || {};
                    return (
                      <tr key={p.port_number}>
                        <td>{p.port_number}</td>
                        <td>{p.mac}</td>
                        <td>{p.gw_mac || '—'}</td>
                        <td>{(p.ue_macs || []).length}</td>
                        <td>{sf.count || 0}{sf.miss_count ? ' (' + sf.miss_count + ' miss)' : ''}</td>
                        <td>{psfp.dropped_frames || 0}</td>
                        <td>{dj.enabled ? 'on · ' + (dj.target_delay_us || 0) + 'µs' : 'off'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>}
          </Card>
        </Section>

        <Section>
          <SecTitle>Host Interfaces</SecTitle>
          <Card>
            <Table>
              <thead><tr><th>Interface</th><th>MAC</th><th>Status</th><th>Speed</th></tr></thead>
              <tbody>
                {ifaces.map(function(i) {
                  return (
                    <tr key={i.name}>
                      <td>{i.name}</td><td>{i.mac}</td>
                      <td style={{color: i.status === 'up' ? 'var(--ok)' : 'var(--text-muted)'}}>{i.status}</td>
                      <td>{i.speed ? (i.speed >= 1000 ? (i.speed / 1000) + ' Gbps' : i.speed + ' Mbps') : '—'}</td>
                    </tr>
                  );
                })}
                {ifaces.length === 0 && <tr><td colSpan="4" style={{color:'var(--text-muted)'}}>TSN-AF unreachable.</td></tr>}
              </tbody>
            </Table>
          </Card>
        </Section>

        <Section>
          <SecTitle>CNC Linkage · TS 24.519</SecTitle>
          <Card>
            <Grid style={{marginBottom: 14}}>
              <KV k="PCF session" v={cncBridge.pcfSessionCreated ? 'created' : 'none'}/>
              <KV k="QoS mappings" v={(summary.configuredQosMappings != null ? summary.configuredQosMappings : 0)}/>
              <KV k="TSC assistance" v={(cncBridge.tscAssistance && cncBridge.tscAssistance.configured) ? 'configured' : 'none'}/>
              <KV k="Time-sync subs" v={(summary.activeTimeSyncSubs != null ? summary.activeTimeSyncSubs : 0)}/>
            </Grid>
            <Note>
              These fields carry data pushed by an external <b>TSN CNC</b> over the TSN-AF's REST API
              (bridge/port management, PSFP stream configs, TSC Assistance, time domains — TS 24.519).
              They stay <b>empty until a CNC connects</b> and configures streams; the bridge and ports
              above operate independently of the CNC.
            </Note>
          </Card>
        </Section>
      </Wrap>
    );
  }
}

export default Dashboard;
