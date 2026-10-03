import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

const Wrap = styled.div`width: 100%; max-width: 760px; margin: 0 auto; padding: 1rem;`;
const H = styled.div`
  margin-bottom: 1.25rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 12px; color: var(--text-muted); }
`;
const Steps = styled.div`
  display: flex; gap: 8px; margin-bottom: 1.25rem;
  .step { flex: 1; text-align: center; font-size: 12px; font-weight: 700; padding: 8px;
    border-radius: 10px; background: var(--bg-input); color: var(--text-muted); }
  .step.on { background: var(--accent); color: #fff; }
  .step.done { background: rgba(67,196,120,0.15); color: var(--ok); }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; padding: 22px;
`;
const Field = styled.div`
  margin-bottom: 14px;
  label { display: block; font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }
  input, select { width: 100%; padding: 9px 12px; font-size: 14px; border-radius: 10px;
    background: var(--bg-input); border: 1px solid transparent; color: var(--text-primary); }
  .hint { font-size: 11px; color: var(--text-muted); margin-top: 3px; }
`;
const Two = styled.div`display: grid; grid-template-columns: 1fr 1fr; gap: 14px;`;
const Row = styled.div`display: flex; gap: 10px; margin-top: 18px; justify-content: flex-end;`;
const Btn = styled.div`
  padding: 10px 22px; border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer;
  background: ${p => p.ghost ? 'transparent' : (p.disabled ? '#b9d4fb' : 'var(--accent)')};
  color: ${p => p.ghost ? 'var(--text-secondary)' : '#fff'};
  border: ${p => p.ghost ? '1px solid var(--border-color)' : 'none'};
  &:hover { opacity: .92; }
`;
const Big = styled.div`
  text-align: center; padding: 20px 0;
  .num { font-size: 40px; font-weight: 800; color: ${p => p.c}; }
  .lbl { font-size: 13px; color: var(--text-muted); }
`;

const PRESETS = {
  tsn: { label: 'TSN (Ethernet, deterministic)', dnn: 'TSN', session_type: 'ethernet', qos_index: 9, dl_mbps: 40, ul_mbps: 100 },
  embb: { label: 'eMBB (IPv4, best effort)', dnn: 'internet', session_type: 'ipv4', qos_index: 9, dl_mbps: 1000, ul_mbps: 1000 },
  gbr: { label: 'GBR (IPv4, guaranteed)', dnn: 'internet', session_type: 'ipv4', qos_index: 1, dl_mbps: 50, ul_mbps: 50 }
};

class OnboardView extends Component {
  state = {
    step: 0, preset: 'tsn',
    form: { imsi: '', k: '00112233445566778899AABBCCDDEEFF', opc: '279EB54971771559879284FDDDE3EE0C', amf: '8000',
      dnn: 'TSN', session_type: 'ethernet', qos_index: 9, dl_mbps: 40, ul_mbps: 100 },
    provisioning: false, provisionMsg: '', verify: null, speed: null, testing: false
  };
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  set = (k, v) => this.setState({ form: Object.assign({}, this.state.form, { [k]: v }) });
  applyPreset = (p) => {
    const pr = PRESETS[p];
    this.setState({ preset: p, form: Object.assign({}, this.state.form,
      { dnn: pr.dnn, session_type: pr.session_type, qos_index: pr.qos_index, dl_mbps: pr.dl_mbps, ul_mbps: pr.ul_mbps }) });
  };
  provision = () => {
    this.setState({ provisioning: true, provisionMsg: '' });
    axios({ baseURL: '/api/onboard', url: '/Provision', method: 'post', headers: this.headers(), data: this.state.form })
      .then(r => this.setState({ provisioning: false, provisionMsg: (r.data.created ? 'Created' : 'Updated') + ' ' + r.data.imsi, step: 2 }))
      .catch(e => this.setState({ provisioning: false, provisionMsg: 'Failed: ' + (((e.response||{}).data||{}).error || e.message) }));
  };
  verify = () => {
    axios({ baseURL: '/api/onboard', url: '/Verify', method: 'get', headers: this.headers(), params: { imsi: this.state.form.imsi } })
      .then(r => this.setState({ verify: r.data })).catch(() => this.setState({ verify: { error: true } }));
  };
  runSpeed = () => {
    this.setState({ testing: true });
    axios({ baseURL: '/api/ue', url: '/SpeedTest', method: 'get', headers: this.headers(),
      params: { target: '192.168.8.195', duration: 5 }, timeout: 90000 })
      .then(r => this.setState({ testing: false, speed: r.data }))
      .catch(e => this.setState({ testing: false, speed: { error: (((e.response||{}).data||{}).error || e.message) } }));
  };

  render() {
    const { step, form, verify, speed } = this.state;
    const labels = ['SIM', 'Service', 'Provision', 'Verify', 'Test'];
    return (
      <Wrap>
        <H><h2>UE Onboarding</h2><span className="sub">Guided flow: provision a SIM → choose service → verify attach → test</span></H>
        <Steps>
          {labels.map((l, i) =>
            <div key={i} className={'step ' + (i === step ? 'on' : (i < step ? 'done' : ''))}>{i + 1}. {l}</div>)}
        </Steps>
        <Card>
          {step === 0 &&
            <div>
              <Field><label>IMSI *</label>
                <input value={form.imsi} placeholder="999700000000001" onChange={e => this.set('imsi', e.target.value.replace(/[^0-9]/g,''))}/>
                <div className="hint">15-digit IMSI (MCC+MNC+MSIN). Must match the core PLMN.</div></Field>
              <Two>
                <Field><label>Ki (K)</label><input value={form.k} onChange={e => this.set('k', e.target.value)}/></Field>
                <Field><label>OPc</label><input value={form.opc} onChange={e => this.set('opc', e.target.value)}/></Field>
              </Two>
              <div className="hint" style={{fontSize:11, color:'var(--text-muted)'}}>Defaults are the standard test keys — replace with the SIM's real values for production.</div>
              <Row><Btn disabled={!/^\d{6,15}$/.test(form.imsi)} onClick={() => /^\d{6,15}$/.test(form.imsi) && this.setState({ step: 1 })}>Next</Btn></Row>
            </div>}

          {step === 1 &&
            <div>
              <Field><label>Service preset</label>
                <select value={this.state.preset} onChange={e => this.applyPreset(e.target.value)}>
                  {Object.keys(PRESETS).map(k => <option key={k} value={k}>{PRESETS[k].label}</option>)}
                </select></Field>
              <Two>
                <Field><label>DNN</label><input value={form.dnn} onChange={e => this.set('dnn', e.target.value)}/></Field>
                <Field><label>Session type</label>
                  <select value={form.session_type} onChange={e => this.set('session_type', e.target.value)}>
                    <option value="ethernet">Ethernet (L2)</option><option value="ipv4">IPv4</option>
                    <option value="ipv6">IPv6</option><option value="ipv4v6">IPv4v6</option>
                  </select></Field>
              </Two>
              <Two>
                <Field><label>5QI</label><input value={form.qos_index} onChange={e => this.set('qos_index', e.target.value)}/></Field>
                <Field><label>DL / UL (Mbps)</label>
                  <div style={{display:'flex',gap:8}}>
                    <input value={form.dl_mbps} onChange={e => this.set('dl_mbps', e.target.value)}/>
                    <input value={form.ul_mbps} onChange={e => this.set('ul_mbps', e.target.value)}/>
                  </div></Field>
              </Two>
              <Row><Btn ghost onClick={() => this.setState({ step: 0 })}>Back</Btn>
                <Btn onClick={this.provision} disabled={this.state.provisioning}>
                  {this.state.provisioning ? 'Provisioning…' : 'Provision SIM'}</Btn></Row>
              {this.state.provisionMsg && <div style={{marginTop:10, fontSize:13, color:'var(--text-secondary)'}}>{this.state.provisionMsg}</div>}
            </div>}

          {step === 2 &&
            <div>
              <Big c="#43c478"><div className="num">✓</div><div className="lbl">{this.state.provisionMsg || 'Subscriber saved'}</div></Big>
              <p style={{textAlign:'center', color:'var(--text-secondary)', fontSize:13}}>
                Now power on / dial the device with this SIM. When it attaches, continue to verify.
              </p>
              <Row><Btn ghost onClick={() => this.setState({ step: 1 })}>Back</Btn>
                <Btn onClick={() => { this.setState({ step: 3 }); this.verify(); }}>Verify attach</Btn></Row>
            </div>}

          {step === 3 &&
            <div>
              {!verify && <Big c="var(--text-muted)"><div className="num">…</div><div className="lbl">Checking</div></Big>}
              {verify && !verify.registered &&
                <Big c="#f5a524"><div className="num">○</div><div className="lbl">Not registered yet — power on / redial the device, then re-check</div></Big>}
              {verify && verify.registered &&
                <div>
                  <Big c={verify.attached ? '#43c478' : '#f5a524'}>
                    <div className="num">{verify.attached ? '✓' : '◐'}</div>
                    <div className="lbl">{verify.cm_state} {verify.attached ? '— attached' : ''}</div>
                  </Big>
                  <div style={{fontSize:13, color:'var(--text-secondary)', textAlign:'center'}}>
                    GUTI {verify.guti || '—'} · cell {verify.cell || '—'} · PDU: {(verify.pdu_sessions || []).map(p => p.dnn).join(', ') || 'none'}
                  </div>
                </div>}
              <Row><Btn ghost onClick={this.verify}>Re-check</Btn>
                <Btn disabled={!(verify && verify.attached)} onClick={() => (verify && verify.attached) && this.setState({ step: 4 })}>Run test</Btn></Row>
            </div>}

          {step === 4 &&
            <div>
              {!speed && <p style={{textAlign:'center', color:'var(--text-secondary)'}}>Run a quick throughput test to validate the connection. The device must run <code>iperf3 -s</code>.</p>}
              {speed && !speed.error &&
                <Two>
                  <Big c="#478ff7"><div className="num">{speed.dl ? speed.dl.mbps : '--'}</div><div className="lbl">Download Mbps</div></Big>
                  <Big c="#27b8dc"><div className="num">{speed.udp ? speed.udp.mbps : '--'}</div><div className="lbl">UDP capacity Mbps</div></Big>
                </Two>}
              {speed && speed.error && <p style={{textAlign:'center', color:'var(--bad)'}}>Test failed: {speed.error}</p>}
              <Row><Btn ghost onClick={() => this.setState({ step: 3 })}>Back</Btn>
                <Btn onClick={this.runSpeed} disabled={this.state.testing}>{this.state.testing ? 'Testing…' : (speed ? 'Re-test' : 'Run speed test')}</Btn>
                <Btn ghost onClick={() => this.setState({ step: 0, form: Object.assign({}, this.state.form, { imsi: '' }), verify: null, speed: null, provisionMsg: '' })}>Onboard another</Btn></Row>
            </div>}
        </Card>
      </Wrap>
    );
  }
}
export default OnboardView;
