import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

/* gNB QoS Profiles (5QI)
 * ---------------------------------------------------------------------------
 * Two distinct things are shown, and the distinction matters:
 *
 *  1. The 5QI CATALOGUE - priority, Packet Delay Budget and Packet Error Rate.
 *     These are STANDARDISED in 3GPP TS 23.501 Table 5.7.4-1 and compiled into
 *     srsRAN. They are reference data, not settings. Nothing here can change
 *     what 5QI 82 means.
 *  2. The BEARER PROFILES - how RLC and PDCP are configured to MEET those
 *     targets on this radio. That is what is editable.
 *
 * Saving rewrites the managed block in gnb_x410.yaml. The server validates the
 * candidate file with `gnb --dryrun` BEFORE replacing the real one, so an
 * invalid profile cannot leave the gNB unable to start. A restart is required
 * for changes to take effect; the page says so rather than restarting the
 * radio behind your back.
 */

const Wrap = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
`;
const SummaryRow = styled.div`
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 1.25rem;
`;
const Stat = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; padding: 14px 16px;
  .v { font-size: 26px; font-weight: 800; color: ${p => p.c || 'var(--text-primary)'}; }
  .l { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-muted); margin-top: 2px; }
`;
const Banner = styled.div`
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 14px 20px; margin-bottom: 1.25rem;
  .dot { width: 12px; height: 12px; border-radius: 50%; background: ${p => p.c};
    box-shadow: 0 0 0 5px ${p => p.soft}; flex: 0 0 auto; }
  .txt { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .sub { font-size: 12px; color: var(--text-muted); margin-left: auto; }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden; margin-bottom: 1.25rem;
`;
const CardHead = styled.div`
  padding: 12px 18px; border-bottom: 1px solid var(--divider);
  display: flex; align-items: baseline; gap: 10px;
  .t { font-size: 14px; font-weight: 700; color: var(--text-primary); }
  .s { font-size: 11.5px; color: var(--text-muted); }
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 12.5px;
  th { text-align: left; padding: 9px 14px; font-size: 10.5px; font-weight: 700;
    text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted);
    border-bottom: 1px solid var(--divider); white-space: nowrap; }
  td { padding: 9px 14px; border-bottom: 1px solid var(--divider);
    color: var(--text-secondary); white-space: nowrap; }
  tr:last-child td { border-bottom: none; }
  td.qi { font-weight: 800; color: var(--text-primary); font-size: 13px; }
  td.mono { font-family: 'SF Mono', Menlo, monospace; font-size: 11.5px; }
  tr.on { background: rgba(71,143,247,0.06); }
`;
const Tag = styled.span`
  display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: .04em;
  padding: 2px 7px; border-radius: 6px; color: ${p => p.c}; background: ${p => p.soft};
`;
const Btn = styled.button`
  padding: 8px 16px; border: none; border-radius: 10px; cursor: pointer;
  background: ${p => p.ghost ? 'transparent' : 'var(--accent)'};
  color: ${p => p.ghost ? 'var(--text-secondary)' : '#fff'};
  border: ${p => p.ghost ? '1px solid var(--divider)' : 'none'};
  font-size: 13px; font-weight: 700; margin-left: 8px;
  &:disabled { opacity: .5; cursor: not-allowed; }
`;
const Err = styled.div`
  background: rgba(240,56,59,0.10); color: #f0383b; border-radius: 10px;
  padding: 10px 14px; font-size: 12.5px; margin-bottom: 1rem;
  font-family: 'SF Mono', Menlo, monospace; white-space: pre-wrap;
`;
const Ok = styled.div`
  background: rgba(45,180,120,0.12); color: #1f9d63; border-radius: 10px;
  padding: 10px 14px; font-size: 12.5px; margin-bottom: 1rem;
`;
const AddRow = styled.div`
  display: flex; align-items: center; gap: 10px; padding: 12px 18px;
  border-top: 1px solid var(--divider);
  select { padding: 7px 10px; border-radius: 8px; border: 1px solid var(--divider);
    background: var(--bg-card); color: var(--text-primary); font-size: 12.5px; }
  .hint { font-size: 11.5px; color: var(--text-muted); }
`;

const TYPE_STYLE = {
  'Non-GBR':            { c: '#478ff7', soft: 'rgba(71,143,247,0.14)' },
  'GBR':                { c: '#f5a524', soft: 'rgba(245,165,36,0.16)' },
  'Delay-critical GBR': { c: '#9750dd', soft: 'rgba(151,80,221,0.16)' }
};

function headers() {
  const s = new Session();
  const csrf = ((s || {}).session || {}).csrfToken;
  const authToken = ((s || {}).session || {}).authToken;
  const h = { 'X-CSRF-TOKEN': csrf };
  if (authToken) h['Authorization'] = 'Bearer ' + authToken;
  return h;
}

class View extends Component {
  state = {
    data: null, status: null, loading: false, error: null, saved: null,
    addQi: '', saving: false, profiles: null
  };

  componentDidMount() { this.fetch(); }

  fetch() {
    this.setState({ loading: true, error: null });
    axios({ baseURL: '/api/gnb-qos', url: '/Profiles', method: 'get', headers: headers(), timeout: 15000 })
      .then(r => this.setState({ data: r.data, profiles: r.data.profiles, loading: false }))
      .catch(e => this.setState({ loading: false,
        error: ((e.response || {}).data || {}).error || e.message }));
    axios({ baseURL: '/api/gnb-qos', url: '/Status', method: 'get', headers: headers(), timeout: 15000 })
      .then(r => this.setState({ status: r.data }))
      .catch(() => {});
  }

  addProfile = () => {
    const qi = parseInt(this.state.addQi, 10);
    if (!qi) return;
    axios({ baseURL: '/api/gnb-qos', url: '/Defaults/' + qi, method: 'get', headers: headers(), timeout: 15000 })
      .then(r => {
        const next = (this.state.profiles || []).concat([r.data.profile]);
        next.sort((a, b) => a.five_qi - b.five_qi);
        this.setState({ profiles: next, addQi: '', saved: null });
      })
      .catch(e => this.setState({ error: ((e.response || {}).data || {}).error || e.message }));
  };

  removeProfile = (qi) => {
    this.setState({ profiles: (this.state.profiles || []).filter(p => p.five_qi !== qi), saved: null });
  };

  save = () => {
    this.setState({ saving: true, error: null, saved: null });
    axios({ baseURL: '/api/gnb-qos', url: '/Profiles', method: 'post',
            headers: headers(), data: { profiles: this.state.profiles }, timeout: 90000 })
      .then(r => { this.setState({ saving: false, saved: r.data }); this.fetch(); })
      .catch(e => this.setState({ saving: false,
        error: ((e.response || {}).data || {}).error || e.message }));
  };

  render() {
    const { data, status, loading, error, saved, profiles, saving } = this.state;
    const catalog = (data || {}).catalog || [];
    const inUse = (data || {}).subscribers_by_5qi || {};
    const gaps = (data || {}).gaps || [];
    const cur = profiles || [];
    const byQi = {};
    catalog.forEach(c => { byQi[c.five_qi] = c; });
    const configured = {};
    cur.forEach(p => { configured[p.five_qi] = true; });
    const dirty = data && JSON.stringify(cur) !== JSON.stringify(data.profiles);
    const pending = status && status.restart_pending;

    return (
      <Wrap>
        <TitleRow>
          <div>
            <h2>gNB QoS Profiles (5QI)</h2>
            <div className="sub">
              Radio-bearer tuning per 5QI in {(data || {}).config_path || 'gnb_x410.yaml'} &nbsp;·&nbsp;
              characteristics fixed by 3GPP TS 23.501 Table 5.7.4-1
            </div>
          </div>
          <div>
            <Btn ghost onClick={() => this.fetch()} disabled={loading}>Refresh</Btn>
            <Btn onClick={this.save} disabled={!dirty || saving}>
              {saving ? 'Validating…' : 'Save to gNB'}
            </Btn>
          </div>
        </TitleRow>

        {error && <Err>{error}</Err>}
        {saved && <Ok>
          Saved and validated with <code>gnb --dryrun</code>. Backup: {saved.backup}.
          &nbsp;<strong>Restart the gNB for this to take effect.</strong>
        </Ok>}

        {(pending || dirty) &&
          <Banner c="#f5a524" soft="rgba(245,165,36,0.18)">
            <div className="dot"/>
            <div className="txt">
              {dirty ? 'Unsaved changes — not yet written to the gNB config.'
                     : 'Config is newer than the running gNB — a restart is pending.'}
            </div>
            <div className="sub">systemctl restart srsran-gnb</div>
          </Banner>}

        {gaps.length > 0 &&
          <Banner c="#f0383b" soft="rgba(240,56,59,0.16)">
            <div className="dot"/>
            <div className="txt">
              5QI {gaps.join(', ')} {gaps.length > 1 ? 'are' : 'is'} provisioned on a subscriber
              but {gaps.length > 1 ? 'have' : 'has'} no bearer profile here — the gNB will fall back to its built-in defaults.
            </div>
          </Banner>}

        <SummaryRow>
          <Stat><div className="v">{cur.length}</div><div className="l">Bearer profiles</div></Stat>
          <Stat><div className="v">{Object.keys(inUse).length}</div><div className="l">5QI in use by subscribers</div></Stat>
          <Stat c={gaps.length ? '#f0383b' : undefined}><div className="v">{gaps.length}</div><div className="l">Unprofiled 5QI</div></Stat>
          <Stat><div className="v">{catalog.length}</div><div className="l">Standardised 5QI available</div></Stat>
        </SummaryRow>

        <Card>
          <CardHead>
            <span className="t">Configured bearer profiles</span>
            <span className="s">RLC / PDCP tuning written to the gNB. Editable.</span>
          </CardHead>
          <Table>
            <thead><tr>
              <th>5QI</th><th>Resource type</th><th>Prio</th><th>PDB</th><th>PER</th>
              <th>RLC</th><th>Discard</th><th>t-reorder</th><th>t-reasm</th>
              <th>Poll retx</th><th>Max retx</th><th>Subscribers</th><th/>
            </tr></thead>
            <tbody>
              {cur.length === 0 && <tr><td colSpan={13} style={{ color: 'var(--text-muted)' }}>
                No profiles configured — the gNB uses its built-in defaults for every 5QI.</td></tr>}
              {cur.map(p => {
                const c = byQi[p.five_qi] || {};
                const st = TYPE_STYLE[c.type] || TYPE_STYLE['Non-GBR'];
                const users = inUse[p.five_qi] || [];
                return (
                  <tr key={p.five_qi}>
                    <td className="qi">{p.five_qi}</td>
                    <td><Tag c={st.c} soft={st.soft}>{c.type || '?'}</Tag></td>
                    <td>{c.prio}</td>
                    <td>{c.pdb} ms</td>
                    <td className="mono">{c.per}</td>
                    <td className="mono">{p.mode}</td>
                    <td className="mono">{p.pdcp.discard_timer === -1 ? '∞' : p.pdcp.discard_timer + ' ms'}</td>
                    <td className="mono">{p.pdcp.t_reordering} ms</td>
                    <td className="mono">{p.rlc.t_reassembly} ms</td>
                    <td className="mono">{p.mode === 'am' ? p.rlc.t_poll_retransmit + ' ms' : '—'}</td>
                    <td className="mono">{p.mode === 'am' ? p.rlc.max_retx_threshold : '—'}</td>
                    <td>{users.length ? users.map(u => u.imsi).join(', ') : '—'}</td>
                    <td><Btn ghost style={{ padding: '4px 10px', fontSize: 11 }}
                        onClick={() => this.removeProfile(p.five_qi)}>Remove</Btn></td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <AddRow>
            <select value={this.state.addQi} onChange={e => this.setState({ addQi: e.target.value })}>
              <option value="">Add a 5QI profile…</option>
              {catalog.filter(c => !configured[c.five_qi]).map(c =>
                <option key={c.five_qi} value={c.five_qi}>
                  {c.five_qi} — {c.type}, PDB {c.pdb} ms, PER {c.per} ({c.example})
                </option>)}
            </select>
            <Btn ghost onClick={this.addProfile} disabled={!this.state.addQi}>Add</Btn>
            <span className="hint">
              Timers are derived from the 5QI&apos;s PDB and PER and snapped to the discrete
              values legal under TS 38.322 / TS 38.323.
            </span>
          </AddRow>
        </Card>

        <Card>
          <CardHead>
            <span className="t">3GPP TS 23.501 Table 5.7.4-1 — standardised 5QI characteristics</span>
            <span className="s">Reference only. These values are fixed by the standard and compiled into srsRAN.</span>
          </CardHead>
          <Table>
            <thead><tr>
              <th>5QI</th><th>Resource type</th><th>Priority</th><th>Packet delay budget</th>
              <th>Packet error rate</th><th>Max data burst</th><th>Typical service</th><th>Profile</th>
            </tr></thead>
            <tbody>
              {catalog.map(c => {
                const st = TYPE_STYLE[c.type] || TYPE_STYLE['Non-GBR'];
                return (
                  <tr key={c.five_qi} className={configured[c.five_qi] ? 'on' : ''}>
                    <td className="qi">{c.five_qi}</td>
                    <td><Tag c={st.c} soft={st.soft}>{c.type}</Tag></td>
                    <td>{c.prio}</td>
                    <td>{c.pdb} ms</td>
                    <td className="mono">{c.per}</td>
                    <td className="mono">{c.mdbv ? c.mdbv + ' B' : '—'}</td>
                    <td style={{ whiteSpace: 'normal' }}>{c.example}</td>
                    <td>{configured[c.five_qi]
                      ? <Tag c="#1f9d63" soft="rgba(45,180,120,0.16)">configured</Tag>
                      : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </Card>
      </Wrap>
    );
  }
}

export default View;
