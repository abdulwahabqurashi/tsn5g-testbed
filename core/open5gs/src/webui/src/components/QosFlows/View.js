import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

/*
 * QoS flows — every flow on the network, and the ability to change one.
 *
 * Joins what is configured (MongoDB), whether the running session is carrying
 * it (smf.log ledger), what the radio actually received (gnb.log) and whether
 * the bearer is carrying any data at all (per-LCG BSRs).
 *
 * The queue column is the one that matters: a bearer can be configured
 * correctly, accepted by the radio, and still never carry a byte because the
 * traffic filter never matches. That is what happened on this rig for three
 * weeks and nothing in the console could show it.
 */

const Page = styled.div`
  font-size: 13px;
  color: var(--text-primary);
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
`;

const Facets = styled.aside`
  flex: 0 0 214px;
  min-width: 190px;
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: 8px;
  padding: 12px 0;
  margin-right: 12px;

  .grp {
    padding: 8px 12px 4px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    border-top: 1px solid var(--divider);
    margin-top: 6px;
  }
  .grp:first-of-type { border-top: none; margin-top: 0; }
  label {
    display: flex; align-items: center; gap: 8px;
    padding: 4px 12px; font-size: 12.5px; cursor: pointer;
  }
  label .n { margin-left: auto; color: var(--text-muted); }
  .sum { margin: 0 10px 8px; padding: 10px; border: 1px solid var(--divider); border-radius: 7px; }
  .sum .r { display: flex; justify-content: space-between; font-size: 11.5px; color: var(--text-muted); padding: 2px 0; }
  .sum .r b { color: var(--text-primary); font-weight: 500; font-family: ui-monospace, Menlo, monospace; }
`;

const Main = styled.div`
  flex: 999 1 640px;
  min-width: 0;
`;

const Card = styled.section`
  background: var(--bg-card);
  border: 1px solid var(--divider);
  border-radius: 8px;
  margin-bottom: 12px;
  overflow: hidden;

  > h2 {
    margin: 0; padding: 11px 14px;
    font-size: 13.5px; font-weight: 650;
    border-bottom: 1px solid var(--divider);
    display: flex; align-items: center; gap: 8px;
  }
  > h2 .muted { color: var(--text-muted); font-weight: 400; }
  > h2 .right { margin-left: auto; font-size: 11.5px; color: var(--text-muted); font-weight: 400; }
`;

const MapBody = styled.div`
  padding: 14px;
  display: flex; flex-wrap: wrap; gap: 22px;

  .ue .hdr { font-size: 11.5px; color: var(--text-muted); margin-bottom: 7px; font-family: ui-monospace, Menlo, monospace; }
  .tiles { display: flex; gap: 6px; flex-wrap: wrap; }
  .tile {
    width: 74px; min-height: 56px; border-radius: 6px; padding: 6px 7px;
    box-sizing: border-box; border: 1px solid;
  }
  .tile .q { font-size: 10.5px; font-weight: 700; }
  .tile .d { font-size: 10.5px; margin-top: 1px; }
  .tile .bar { height: 4px; border-radius: 2px; margin-top: 7px; overflow: hidden; }
  .legend {
    width: 100%; display: flex; flex-wrap: wrap; gap: 14px;
    padding-top: 11px; border-top: 1px solid var(--divider);
    font-size: 11px; color: var(--text-muted);
  }
  .legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
`;

const TableWrap = styled.div`
  overflow-x: auto;
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; min-width: 1040px; }
  th {
    text-align: left; padding: 8px 12px; font-size: 11px; font-weight: 650;
    color: var(--text-muted); border-bottom: 1px solid var(--divider);
    background: var(--bg-muted, rgba(0,0,0,0.015)); white-space: nowrap;
  }
  td { padding: 9px 12px; border-bottom: 1px solid var(--divider); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  td .sub { display: block; font-size: 11px; color: var(--text-muted); }
  .mono { font-family: ui-monospace, Menlo, monospace; }
  .pill { padding: 2px 7px; border-radius: 4px; font-weight: 650; font-size: 11.5px; }
  .num { text-align: right; font-weight: 600; white-space: nowrap; }
  .qbar { display: flex; align-items: center; gap: 7px; }
  .qbar .track { width: 60px; height: 5px; border-radius: 3px; background: rgba(0,0,0,0.08); overflow: hidden; flex: none; }
  .qbar .fill { height: 5px; }
  button.link {
    background: none; border: none; padding: 0; font-size: 12px;
    color: #0559C9; cursor: pointer; font-family: inherit;
  }
  button.link:hover { text-decoration: underline; }
`;

const Drawer = styled.div`
  position: fixed; top: 0; right: 0; bottom: 0; width: 452px; max-width: 100vw;
  background: var(--bg-card); border-left: 1px solid var(--divider);
  box-shadow: -8px 0 28px rgba(0,0,0,0.14);
  overflow-y: auto; z-index: 900; padding: 18px 22px 40px; box-sizing: border-box;

  h3 { margin: 10px 0 3px; font-size: 18px; font-weight: 650; }
  .sect { font-size: 13.5px; font-weight: 650; margin: 20px 0 9px; }
  label.f { display: block; font-size: 12.5px; margin-bottom: 5px; }
  input[type=number], input[type=text], select {
    width: 100%; box-sizing: border-box; min-height: 40px; padding: 9px 11px;
    border: 1px solid var(--divider); border-radius: 6px; font-size: 13px;
    background: var(--bg-card); color: var(--text-primary);
  }
  .row { display: flex; gap: 10px; align-items: flex-end; }
  .pillradio {
    display: inline-flex; align-items: center; gap: 7px; min-height: 40px;
    padding: 7px 13px; border: 1px solid var(--divider); border-radius: 22px;
    font-size: 13px; cursor: pointer; margin: 0 6px 6px 0;
  }
  .pillradio.on { border: 2px solid #0559C9; font-weight: 600; }
  .note { font-size: 12px; line-height: 17px; border-radius: 6px; padding: 9px 11px; margin-top: 10px; }
  .note.warn { color: #8A5A08; background: rgba(245,166,35,0.10); border: 1px solid rgba(245,166,35,0.35); }
  .note.bad  { color: #8A2822; background: rgba(179,67,59,0.08); border: 1px solid rgba(179,67,59,0.30); }
  .prev { border: 1px solid var(--divider); border-radius: 7px; overflow: hidden; margin-top: 12px; }
  .prev .h { padding: 7px 11px; font-size: 11px; font-weight: 700; color: var(--text-muted); border-bottom: 1px solid var(--divider); }
  .prev .b { padding: 10px 11px; }
  .prev .l { display: flex; gap: 10px; font-size: 12.5px; margin-bottom: 5px; }
  .prev .l b.k { flex: none; width: 62px; }
  .derived .r { display: flex; justify-content: space-between; font-size: 12.5px; padding: 3px 0; }
  .derived .r span { color: var(--text-muted); }
  .acts { display: flex; gap: 8px; margin-top: 18px; }
  button.primary {
    min-height: 44px; padding: 10px 18px; border: none; border-radius: 6px;
    background: #0559C9; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  button.primary[disabled] { opacity: 0.55; cursor: default; }
  button.ghost {
    min-height: 44px; padding: 10px 18px; border: 1px solid var(--divider);
    border-radius: 6px; background: var(--bg-card); color: var(--text-primary);
    font-size: 13px; font-weight: 600; cursor: pointer;
  }
`;

const Scrim = styled.div`
  position: fixed; inset: 0; background: rgba(15,23,42,0.28); z-index: 890;
`;

/* 3GPP TS 23.501 Table 5.7.4-1, the subset that makes sense on this rig. */
const CATALOG = [
  { q: 4,  t: 'GBR',                p: 50, pdb: 300, per: '1e-6', ex: 'Non-conversational video' },
  { q: 67, t: 'GBR',                p: 15, pdb: 100, per: '1e-3', ex: 'Mission-critical video' },
  { q: 1,  t: 'GBR',                p: 20, pdb: 100, per: '1e-2', ex: 'Conversational voice' },
  { q: 82, t: 'Delay-critical GBR', p: 19, pdb: 10,  per: '1e-4', ex: 'Discrete automation' }
];

const fmtB = (n) => n === null || n === undefined ? '—'
  : (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B');
const fmtT = (t) => { try { return new Date(t).toLocaleString(); } catch (e) { return '—'; } };

class View extends Component {
  state = {
    flows: [], readback: {}, loaded: false, err: null,
    edit: null, saving: false, toast: null
  };

  componentDidMount() { this.load(); this._t = setInterval(() => this.load(), 5000); }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }

  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken;
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  load() {
    /* Never clobber a form the operator is filling in. */
    if (this.state.edit) return;
    axios({ baseURL: '/api/qos', url: '/Flows', method: 'get', headers: this.headers() })
      .then(r => this.setState({
        flows: (r.data || {}).flows || [],
        readback: (r.data || {}).readback || {},
        loaded: true, err: null
      }))
      .catch(e => this.setState({
        loaded: true,
        err: ((e.response || {}).data || {}).message || 'could not load QoS flows'
      }));
  }

  openEdit(f) {
    if (f.kind !== 'pcc') {
      this.setState({ toast: 'The default flow has no PCC rule — its 5QI is on the subscriber.' });
      return;
    }
    this.setState({
      toast: null,
      edit: {
        imsi: f.imsi, rule_index: f.rule_index, qfi: f.qfi,
        five_qi: f.five_qi, gbr_ul: f.gbr_ul, mbr_ul: f.mbr_ul,
        proto: (f.filter && f.filter.proto) || 'udp',
        port: (f.filter && f.filter.ue_port) || '',
        session_active: f.session_active
      }
    });
  }

  set(k, v) { this.setState({ edit: Object.assign({}, this.state.edit, { [k]: v }) }); }

  save() {
    const e = this.state.edit;
    this.setState({ saving: true });
    axios({ baseURL: '/api/qos', url: '/Flow', method: 'put', headers: this.headers(), data: e })
      .then(r => {
        this.setState({ saving: false, edit: null, toast: (r.data || {}).message || 'Saved.' },
          () => this.load());
      })
      .catch(err => this.setState({
        saving: false,
        toast: ((err.response || {}).data || {}).message || 'Save failed.'
      }));
  }

  /* ---------- pieces ---------- */

  tile(f) {
    const never = f.session_active && f.queue_bytes === 0 && f.kind === 'pcc';
    let bg = 'rgba(0,0,0,0.04)', bd = 'var(--divider)', fg = 'var(--text-muted)', bar = '#C8CCD2', pct = 0;
    if (!f.session_active) { /* idle defaults above */ }
    else if (never) { bg = 'rgba(245,166,35,0.12)'; bd = 'rgba(245,166,35,0.45)'; fg = '#8A5A08'; bar = '#F5A623'; }
    else if (f.gbr_ul) { bg = 'rgba(57,168,69,0.10)'; bd = 'rgba(57,168,69,0.40)'; fg = '#2D8A3E'; bar = '#39A845'; }
    else { bg = 'rgba(5,89,201,0.08)'; bd = 'rgba(5,89,201,0.30)'; fg = '#0559C9'; bar = '#2C9BE0'; }
    if (f.queue_bytes) pct = Math.max(4, Math.min(100, Math.round((f.queue_bytes / 65536) * 100)));
    return (
      <div className="tile" key={f.imsi + '-' + f.qfi} style={{ background: bg, borderColor: bd }}>
        <div className="q" style={{ color: fg }}>QFI {f.qfi}</div>
        <div className="d" style={{ color: 'var(--text-muted)' }}>{f.drb ? 'DRB ' + f.drb : '—'}</div>
        <div className="bar" style={{ background: 'rgba(0,0,0,0.07)' }}>
          <div style={{ width: pct + '%', height: '4px', background: bar }}/>
        </div>
      </div>
    );
  }

  render() {
    const { flows, readback, loaded, err, edit, saving, toast } = this.state;
    const macDebug = !!readback.mac_debug;

    const byUe = {};
    flows.forEach(f => { (byUe[f.imsi] = byUe[f.imsi] || []).push(f); });
    const imsis = Object.keys(byUe).sort();

    const nLive = flows.filter(f => f.session_active && !f.drift).length;
    const nDrift = flows.filter(f => f.drift).length;
    const nNone = flows.filter(f => !f.session_active).length;
    const nGbr = flows.filter(f => f.gbr_ul).length;
    const nNon = flows.filter(f => !f.gbr_ul).length;
    const nCarry = flows.filter(f => f.queue_bytes > 0).length;
    const nNever = flows.filter(f => f.kind === 'pcc' && f.session_active && f.queue_bytes === 0).length;

    const first = flows[0] || {};
    const cat = edit ? CATALOG.filter(c => c.q === Number(edit.five_qi))[0] : null;

    return (
      <div>
        {toast && (
          <div style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: '7px',
                        background: 'rgba(5,89,201,0.07)', border: '1px solid rgba(5,89,201,0.25)',
                        fontSize: '13px' }}>
            {toast}
            <button onClick={() => this.setState({ toast: null })}
              style={{ float: 'right', background: 'none', border: 'none', cursor: 'pointer',
                       color: 'var(--text-muted)', fontSize: '14px' }} aria-label="Dismiss">×</button>
          </div>
        )}
        {err && (
          <div style={{ margin: '0 0 12px', padding: '10px 14px', borderRadius: '7px',
                        background: 'rgba(179,67,59,0.08)', border: '1px solid rgba(179,67,59,0.3)',
                        fontSize: '13px', color: '#8A2822' }}>{err}</div>
        )}

        <Page>
          <Facets>
            <div className="sum">
              <div style={{ fontSize: '12.5px', fontWeight: 650, marginBottom: '7px',
                            fontFamily: 'ui-monospace, Menlo, monospace' }}>
                {first.imsi || '—'}
              </div>
              <div className="r"><span>Address</span><b>{first.ipv4 || '—'}</b></div>
              <div className="r"><span>DNN</span><b>{first.dnn || '—'}</b></div>
              <div className="r"><span>Session</span>
                <b style={{ color: first.session_active ? '#2D8A3E' : 'var(--text-muted)' }}>
                  {first.session_active ? 'live' : 'none'}</b></div>
            </div>

            <div className="grp">CONFIG STATE</div>
            <label><input type="checkbox" readOnly checked/> Live <span className="n">({nLive})</span></label>
            <label><input type="checkbox" readOnly/> Not live <span className="n">({nDrift})</span></label>
            <label><input type="checkbox" readOnly/> No session <span className="n">({nNone})</span></label>

            <div className="grp">CLASS</div>
            <label><input type="checkbox" readOnly/> GBR <span className="n">({nGbr})</span></label>
            <label><input type="checkbox" readOnly/> Non-GBR <span className="n">({nNon})</span></label>

            <div className="grp">BEARER</div>
            <label><input type="checkbox" readOnly/> Carrying data <span className="n">({nCarry})</span></label>
            <label style={{ color: nNever ? '#C2410C' : undefined }}>
              <input type="checkbox" readOnly/> Never used <span className="n">({nNever})</span></label>
          </Facets>

          <Main>
            <Card>
              <h2>Bearer map
                <span className="right">
                  {macDebug ? 'latest queue depth per channel — not a same-report reading'
                            : 'queue depth unavailable — mac_level is not debug'}
                </span>
              </h2>
              <MapBody>
                {imsis.map(imsi => (
                  <div className="ue" key={imsi}>
                    <div className="hdr">
                      …{imsi.slice(-4)}{' '}
                      <span style={{ color: byUe[imsi][0].session_active ? '#2D8A3E' : 'var(--text-muted)' }}>
                        {byUe[imsi][0].session_active ? '● live' : '○ no session'}
                      </span>
                    </div>
                    <div className="tiles">{byUe[imsi].map(f => this.tile(f))}</div>
                  </div>
                ))}
                <div className="legend">
                  <span><i style={{ background: '#39A845' }}/>GBR, carrying</span>
                  <span><i style={{ background: '#2C9BE0' }}/>Non-GBR, carrying</span>
                  <span><i style={{ background: '#C8CCD2' }}/>Idle / no session</span>
                  <span><i style={{ background: '#F5A623' }}/>Configured, never used</span>
                </div>
              </MapBody>
            </Card>

            <Card>
              <h2>QoS flows <span className="muted">({flows.length})</span>
                <span className="right">{loaded ? 'updated just now' : 'loading…'}</span></h2>
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th>Subscriber</th><th>QFI</th><th>5QI</th><th>Class</th>
                      <th>Bearer</th><th>LCG / prio</th><th>Rate</th>
                      <th>Matches uplink</th><th>Queue</th><th style={{ textAlign: 'right' }}>Session</th><th/>
                    </tr>
                  </thead>
                  <tbody>
                    {flows.map((f, i) => {
                      const never = f.kind === 'pcc' && f.session_active && f.queue_bytes === 0;
                      const pct = f.queue_bytes ? Math.max(4, Math.min(100, Math.round((f.queue_bytes / 65536) * 100))) : 0;
                      return (
                        <tr key={i} style={{ opacity: f.session_active ? 1 : 0.62 }}>
                          <td className="mono" style={{ fontSize: '12px' }}>…{f.imsi.slice(-4)}</td>
                          <td><span className="pill" style={{
                              background: f.gbr_ul ? 'rgba(57,168,69,0.12)' : 'rgba(5,89,201,0.09)',
                              color: f.gbr_ul ? '#2D8A3E' : '#0559C9' }}>{f.qfi}</span></td>
                          <td style={{ fontWeight: 600 }}>{f.five_qi === undefined ? '—' : f.five_qi}</td>
                          <td>{f.gbr_ul ? 'GBR' : 'Non-GBR'}
                            <span className="sub">{f.kind === 'pcc' ? 'PCC rule' : 'default'}</span></td>
                          <td>{f.drb ? 'DRB ' + f.drb : '—'}
                            <span className="sub">{f.rlc_mode || '—'}</span></td>
                          <td>{f.lcg === null || f.lcg === undefined ? '—' : f.lcg}
                            {f.priority ? ' / ' + f.priority : ''}
                            <span className="sub">{f.pbr || '—'}</span></td>
                          <td>{f.gbr_ul ? f.gbr_ul + ' / ' + (f.mbr_ul || '—')
                                        : (f.ambr_ul ? 'AMBR ' + f.ambr_ul : '—')}
                            <span className="sub">Mbit/s</span></td>
                          <td>
                            {f.filter && f.filter.parsed
                              ? (<span><span className="mono" style={{ fontSize: '11.5px' }}>
                                   {f.filter.proto} src :{f.filter.ue_port}</span>
                                 <span className="sub" style={{ color: '#2D8A3E' }}>from the UE</span></span>)
                              : (<span style={{ color: 'var(--text-muted)' }}>everything else</span>)}
                          </td>
                          <td>
                            {!macDebug ? <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>unavailable</span>
                             : !f.session_active ? <span style={{ color: 'var(--text-muted)', fontSize: '11.5px' }}>—</span>
                             : (<div className="qbar">
                                  <div className="track"><div className="fill" style={{ width: pct + '%',
                                    background: never ? '#F5A623' : (f.gbr_ul ? '#39A845' : '#2C9BE0') }}/></div>
                                  <span style={{ fontSize: '11.5px' }}>{fmtB(f.queue_bytes)}</span>
                                </div>)}
                            {never && macDebug && <span className="sub" style={{ color: '#C2410C' }}>never carried data</span>}
                          </td>
                          <td className="num">
                            {f.drift ? <span style={{ color: '#B3433B' }}>config changed</span>
                             : f.session_active ? <span style={{ color: '#2D8A3E' }}>live</span>
                             : <span style={{ color: 'var(--text-muted)' }}>no session</span>}
                          </td>
                          <td>{f.kind === 'pcc'
                            ? <button className="link" onClick={() => this.openEdit(f)}>Edit</button>
                            /* The default flow carries no PCC rule, so there is
                             * nothing here to edit — its 5QI lives on the
                             * subscriber's session, not on a rule. Showing a
                             * dead Edit button would promise an action the API
                             * cannot perform. */
                            : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableWrap>
              {/* One PDU session carries ALL of its flows simultaneously, so
                * every row of the same subscriber reads the same session state.
                * Two rows both saying "live" is expected, not a contradiction —
                * it confused a reader on 2026-10-04, hence this line. */}
              <div style={{ padding: '9px 14px 12px', fontSize: '12px',
                            color: 'var(--text-muted)', borderTop: '1px solid var(--line)' }}>
                A session carries all of its flows at once, so every flow belonging
                to one subscriber shows the same session state. <strong>config changed</strong> means
                the stored values no longer match what the running session was built
                with — the UE must rebuild with <code>AT+CFUN=0</code> / <code>AT+CFUN=1</code>.
              </div>
            </Card>

            <Card>
              <h2>Configured vs in force at the radio
                <span className="right">{readback.captured_at ? 'read ' + fmtT(readback.captured_at) : 'no read-back yet'}</span></h2>
              <div style={{ padding: '12px 14px', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                {Object.keys(readback.flows || {}).length === 0 && (
                  <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
                    Nothing read back yet. These values appear in the gNB log only at session
                    establishment, and the log is truncated whenever the gNB restarts.
                  </div>
                )}
                {Object.keys(readback.flows || {}).map(q => {
                  const rf = readback.flows[q];
                  return (
                    <div key={q} style={{ border: '1px solid var(--divider)', borderRadius: '6px',
                                          padding: '9px 11px', minWidth: '190px' }}>
                      <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>QFI {q}</div>
                      <div style={{ fontSize: '12.5px', marginTop: '3px' }}>
                        5QI <span className="mono">{rf.five_qi === undefined ? '—' : rf.five_qi}</span>
                      </div>
                      {rf.guaranteedFlowBitRateUplink !== undefined && (
                        <div style={{ fontSize: '12.5px' }}>GBR UL{' '}
                          <span className="mono">{rf.guaranteedFlowBitRateUplink}</span></div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          </Main>
        </Page>

        {edit && <Scrim onClick={() => this.setState({ edit: null })}/>}
        {edit && (
          <Drawer>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: '13px', fontWeight: 600 }}>Edit flow</span>
              <button onClick={() => this.setState({ edit: null })} aria-label="Close"
                style={{ background: 'none', border: 'none', fontSize: '16px', cursor: 'pointer',
                         color: 'var(--text-muted)' }}>✕</button>
            </div>
            <h3>QoS Flow Configuration</h3>
            <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>
              QFI {edit.qfi} · <span className="mono">{edit.imsi}</span>
            </div>

            <div className="sect">Traffic Class</div>
            <div>
              {CATALOG.map(c => (
                <label key={c.q} className={'pillradio' + (Number(edit.five_qi) === c.q ? ' on' : '')}>
                  <input type="radio" name="fiveqi" checked={Number(edit.five_qi) === c.q}
                    onChange={() => this.set('five_qi', c.q)}/> 5QI {c.q}
                </label>
              ))}
            </div>
            {cat && (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', background: 'rgba(0,0,0,0.025)',
                            border: '1px solid var(--divider)', borderRadius: '6px', padding: '9px 11px' }}>
                <b>5QI {cat.q}</b> — {cat.t} · priority {cat.p} · delay budget {cat.pdb} ms · error rate {cat.per}.
                Fixed by 3GPP; the radio reads these, you cannot change them. <i>{cat.ex}</i>
                {cat.pdb < 30 && (
                  <div style={{ color: '#8A5A08', marginTop: '5px' }}>
                    This budget is below the ~30 ms floor measured on this uplink — a 10 ms timer once
                    cut uplink to 17.5 kbit/s.
                  </div>
                )}
              </div>
            )}

            <div className="sect">Bit Rates</div>
            <label className="f" htmlFor="gbr">Guaranteed uplink (Mbit/s)</label>
            <input id="gbr" type="number" value={edit.gbr_ul === null ? '' : edit.gbr_ul}
              onChange={e => this.set('gbr_ul', e.target.value)}/>
            <div style={{ height: '10px' }}/>
            <label className="f" htmlFor="mbr">Maximum uplink (Mbit/s)</label>
            <input id="mbr" type="number" value={edit.mbr_ul === null ? '' : edit.mbr_ul}
              onChange={e => this.set('mbr_ul', e.target.value)}/>
            {Number(edit.gbr_ul) > 25 && (
              <div className="note warn">
                The measured loaded uplink ceiling is about <b>50 Mbit/s</b>. Above roughly 25 the
                guarantee cannot be honoured under contention, which makes “did the flow get its
                GBR?” untestable.
              </div>
            )}
            {Number(edit.mbr_ul) < Number(edit.gbr_ul) && (
              <div className="note bad">Maximum cannot be below the guaranteed rate.</div>
            )}

            <div className="sect">Traffic Filter</div>
            <div className="row">
              <div style={{ flex: '0 0 116px' }}>
                <label className="f" htmlFor="proto">Protocol</label>
                <select id="proto" value={edit.proto} onChange={e => this.set('proto', e.target.value)}>
                  <option value="udp">UDP</option>
                  <option value="tcp">TCP</option>
                </select>
              </div>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <label className="f" htmlFor="port">UE-side port</label>
                <input id="port" type="text" value={edit.port}
                  onChange={e => this.set('port', e.target.value)}/>
              </div>
            </div>

            <div className="prev">
              <div className="h">THIS WILL MATCH</div>
              <div className="b">
                <div className="l" style={{ color: 'var(--text-muted)' }}>
                  <b className="k">Downlink</b>
                  <span>{String(edit.proto).toUpperCase()} <b>to</b> the UE, port{' '}
                    <span className="mono">{edit.port || '—'}</span></span>
                </div>
                <div className="l" style={{ color: '#2D8A3E' }}>
                  <b className="k">Uplink</b>
                  <span>{String(edit.proto).toUpperCase()} <b>from</b> the UE,{' '}
                    <b>source port <span className="mono">{edit.port || '—'}</span></b></span>
                </div>
                <div className="note warn" style={{ marginTop: '8px' }}>
                  The UE must <b>send from</b> port {edit.port || '—'}. Sending <i>to</i> it does
                  nothing — with iperf3 use <span className="mono">--cport {String(edit.port || '').split(/[,-]/)[0]}</span>.
                </div>
                <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)',
                              fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' }}>
                  permit out {edit.proto} from any 1-65535 to assigned {edit.port || '—'}
                </div>
              </div>
            </div>

            <div className="note bad">
              <b>Saving does not apply this.</b> PCC rules are read only when the PDU session is
              established. {edit.session_active
                ? 'The running session keeps the old values until the UE rebuilds with AT+CFUN=0 then AT+CFUN=1.'
                : 'There is no active session, so it will apply when the UE next attaches.'}
            </div>

            <div className="acts">
              <button className="primary" disabled={saving ||
                  (Number(edit.mbr_ul) < Number(edit.gbr_ul))}
                onClick={() => this.save()}>{saving ? 'Saving…' : 'Apply Changes'}</button>
              <button className="ghost" onClick={() => this.setState({ edit: null })}>Cancel</button>
            </div>
          </Drawer>
        )}
      </div>
    );
  }
}

export default View;
