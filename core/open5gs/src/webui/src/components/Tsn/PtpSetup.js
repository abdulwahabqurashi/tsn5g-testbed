import { Component } from 'react';
import styled from 'styled-components';

import { tsnApi } from 'helpers/tsn-api';

/*
 * PTP readiness and control.
 *
 * The Time Sync page below this one assumes PTP can simply be started. On
 * this host it could not: linuxptp was never installed, and the WebUI runs
 * unprivileged while ptp4l needs CAP_NET_RAW, CAP_NET_ADMIN and write access
 * to /dev/ptpN. Starting it would fail with a bare permission error and no
 * indication of why.
 *
 * So this card answers the question first - what is missing, and what single
 * command fixes it - and only then offers Start/Stop, which drive a systemd
 * unit through a narrow sudo rule rather than spawning anything here.
 */

const Card = styled.div`
  background: var(--surface, #fff);
  border: 1px solid var(--line, #e3e7ea);
  border-radius: 8px;
  margin-bottom: 16px;
  overflow: hidden;
`;

const Head = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 16px;
  border-bottom: 1px solid var(--line, #e3e7ea);
  h3 { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary, #1a1a1a); }
`;

const Pill = styled.span`
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 11px;
  background: ${p => p.ok ? '#E8F5EA' : p.warn ? '#FEF3E2' : '#FBEAE9'};
  color: ${p => p.ok ? '#2D8A3E' : p.warn ? '#B07A1B' : '#B3433B'};
`;

const Body = styled.div` padding: 6px 16px 14px; `;

const Check = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 0;
  border-bottom: 1px solid var(--line-soft, #f0f3f5);
  &:last-child { border-bottom: 0; }
  .mark {
    flex: 0 0 16px; height: 16px; margin-top: 1px;
    border-radius: 50%; text-align: center; line-height: 16px;
    font-size: 10px; font-weight: 700; color: #fff;
    background: ${p => p.ok ? '#2D8A3E' : '#B3433B'};
  }
  .label { font-size: 13px; color: var(--text-primary, #1a1a1a); }
  .detail {
    font-size: 11.5px; color: var(--text-muted, #76808a);
    margin-top: 2px; word-break: break-word;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
`;

const Fix = styled.div`
  margin-top: 12px;
  background: #FDF8EC;
  border: 1px solid #F0E0BC;
  border-left: 3px solid #C8900B;
  border-radius: 4px;
  padding: 10px 12px;
  font-size: 12.5px;
  color: #6b5312;
  code {
    display: block; margin-top: 6px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; background: #fff; border: 1px solid #EADFC0;
    border-radius: 3px; padding: 6px 8px; color: #1a1a1a;
  }
`;

const Settings = styled.div`
  margin-top: 13px;
  border: 1px solid var(--line, #e3e7ea);
  border-radius: 6px;
  overflow: hidden;
  .h {
    background: var(--surface-alt, #f7fafb);
    border-bottom: 1px solid var(--line, #e3e7ea);
    padding: 7px 12px; font-size: 11.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: .04em;
    color: var(--text-muted, #76808a);
  }
  dl { display: flex; flex-wrap: wrap; margin: 0; padding: 10px 12px 4px; }
  dl > div { flex: 1 1 128px; margin: 0 0 9px; }
  dt { font-size: 11px; color: var(--text-muted, #76808a); margin-bottom: 1px; }
  dd {
    margin: 0; font-size: 13px; font-weight: 600;
    color: var(--text-primary, #1a1a1a);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .warn {
    border-top: 1px solid var(--line-soft, #f0f3f5);
    padding: 8px 12px 10px; font-size: 11.5px; line-height: 1.5;
    color: var(--text-muted, #76808a);
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      background: var(--surface-alt, #f2f5f7); padding: 1px 4px;
      border-radius: 3px; color: var(--text-primary, #1a1a1a);
    }
  }
`;

const Row = styled.div`
  display: flex; align-items: center; gap: 10px;
  padding: 11px 0 2px; flex-wrap: wrap;
`;

const Btn = styled.button`
  font-size: 12.5px; font-weight: 600;
  padding: 6px 14px; border-radius: 5px; cursor: pointer;
  border: 1px solid ${p => p.primary ? '#2563A8' : 'var(--line, #d8dee3)'};
  background: ${p => p.primary ? '#2563A8' : '#fff'};
  color: ${p => p.primary ? '#fff' : 'var(--text-primary, #1a1a1a)'};
  &:disabled { opacity: .45; cursor: not-allowed; }
`;

const Metric = styled.div`
  font-size: 12.5px; color: var(--text-muted, #76808a);
  strong { color: var(--text-primary, #1a1a1a); font-weight: 600; }
`;

const Logs = styled.pre`
  margin: 10px 0 0;
  background: #1d2127; color: #d6dbe1;
  border-radius: 5px; padding: 9px 11px;
  font-size: 11px; line-height: 1.45;
  max-height: 190px; overflow: auto;
  white-space: pre-wrap; word-break: break-all;
`;

const Note = styled.div`
  margin-top: 11px; font-size: 11.5px; line-height: 1.5;
  color: var(--text-muted, #76808a);
  strong { color: #B07A1B; }
`;

class PtpSetup extends Component {
  constructor(props) {
    super(props);
    this.state = {
      readiness: null, service: null,
      busy: false, error: null, showLogs: false
    };
    this.refresh = this.refresh.bind(this);
  }

  componentDidMount() {
    this.refresh();
    /* 5 s: ptp4l takes a few seconds to move s0 -> s2, and the operator is
     * usually watching this card while it does. */
    this.timer = setInterval(this.refresh, 5000);
  }

  componentWillUnmount() {
    if (this.timer) clearInterval(this.timer);
  }

  refresh() {
    tsnApi('get', '/api/ptp/readiness')
      .then(r => this.setState({ readiness: r.data }))
      .catch(() => {});
    tsnApi('get', '/api/ptp/service')
      .then(r => this.setState({ service: r.data }))
      .catch(() => {});
  }

  act(action, unit) {
    this.setState({ busy: true, error: null });
    tsnApi('post', '/api/ptp/service', { action: action, unit: unit })
      .then(() => { this.setState({ busy: false }); this.refresh(); })
      .catch(e => this.setState({
        busy: false,
        error: ((e.response || {}).data || {}).message || 'request failed'
      }));
  }

  render() {
    const { readiness, service, busy, error, showLogs } = this.state;
    if (!readiness) {
      return <Card><Body><Metric>Checking PTP readiness…</Metric></Body></Card>;
    }

    const ready = readiness.ready;
    const running = !!(service && service.service && service.service.active);
    const locked = !!(service && service.locked);
    const phc2sysOn = !!(service && service.phc2sys && service.phc2sys.active);

    return (
      <Card>
        <Head>
          <h3>PTP setup</h3>
          {!ready ? <Pill>not ready</Pill>
            : locked ? <Pill ok>locked to grandmaster</Pill>
            : running ? <Pill warn>running, not yet locked</Pill>
            : <Pill warn>ready, stopped</Pill>}
        </Head>

        <Body>
          {readiness.checks.map(c => (
            <Check key={c.id} ok={c.ok}>
              <div className="mark">{c.ok ? '✓' : '!'}</div>
              <div>
                <div className="label">{c.label}</div>
                <div className="detail">{c.detail}</div>
              </div>
            </Check>
          ))}

          {!ready && (
            <Fix>
              Run this once on the server, then this panel turns green by itself:
              <code>{readiness.fixCommand}</code>
              It picks the port with a hardware clock, listens for the
              grandmaster to work out the profile and transport, then installs
              and starts everything.
            </Fix>
          )}

          {readiness.config && (
            <Settings>
              <div className="h">Must match the grandmaster</div>
              <dl>
                <div><dt>Profile</dt><dd>{readiness.config.profile}</dd></div>
                <div><dt>Transport</dt><dd>{readiness.config.transport || '—'}</dd></div>
                <div><dt>Domain</dt><dd>{readiness.config.domain || '—'}</dd></div>
                <div><dt>Delay</dt><dd>{readiness.config.delay_mechanism || '—'}</dd></div>
                <div><dt>Bound to</dt><dd>{readiness.config.interface || '—'}</dd></div>
                <div><dt>VLAN</dt><dd>{readiness.config.vlan || 'untagged'}</dd></div>
              </dl>
              <div className="warn">
                A mismatch here does not raise an error — ptp4l simply never
                leaves <code>s0</code>. To read what the grandmaster is actually
                sending: <code>{readiness.detectCommand}</code>
              </div>
            </Settings>
          )}

          {ready && (
            <Row>
              <Btn primary disabled={busy || running}
                   onClick={() => this.act('start', 'ptp4l')}>Start PTP</Btn>
              <Btn disabled={busy || !running}
                   onClick={() => this.act('stop', 'ptp4l')}>Stop</Btn>
              <Btn disabled={busy || !running}
                   onClick={() => this.act('restart', 'ptp4l')}>Restart</Btn>
              <Metric>
                {running
                  ? <span>offset <strong>
                      {service.offset_ns === null ? '—' : service.offset_ns + ' ns'}
                    </strong> · state <strong>{service.sync_state || '—'}</strong></span>
                  : <span>ptp4l is stopped</span>}
              </Metric>
              <Btn onClick={() => this.setState({ showLogs: !showLogs })}>
                {showLogs ? 'Hide log' : 'Show log'}
              </Btn>
            </Row>
          )}

          {error && (
            <Note style={{ color: '#B3433B' }}>{error}</Note>
          )}

          {ready && showLogs && (
            <Logs>{(service && service.logs || []).join('\n') || 'no output yet'}</Logs>
          )}

          {ready && (
            <Note>
              <strong>System clock is deliberately not disciplined.</strong>{' '}
              ptp4l syncs the NIC's hardware clock, which is what the NW-TT
              timestamps against — that is all TSN needs. Enabling phc2sys would
              also steer this server's system clock from the grandmaster, and a
              grandmaster with an arbitrary epoch will step it by years, breaking
              TLS, MongoDB TTL indexes and every timestamp in the core.
              {' '}phc2sys is currently <strong>{phc2sysOn ? 'running' : 'stopped'}</strong>.
              {' '}Only enable it once you have confirmed the grandmaster carries real
              wall-clock time: <code style={{ fontFamily: 'monospace' }}>pmc -u -b 0 'GET TIME_STATUS_NP'</code>
            </Note>
          )}
        </Body>
      </Card>
    );
  }
}

export default PtpSetup;
