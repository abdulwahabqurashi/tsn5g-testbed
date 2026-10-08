import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

/*
 * SessionBanner — is the QoS shown on this page actually live?
 *
 * PCC rules and subscriber QoS reach the network ONLY when the PDU session is
 * established. An edit made afterwards sits in MongoDB doing nothing, and the
 * console gave no sign of it. Two rounds of testing were invalidated by
 * exactly that, so this states it plainly.
 *
 * Deliberately offers no "rebuild" action: a rebuild is AT+CFUN=0 / AT+CFUN=1
 * on the UE, and --wds-stop-network does NOT do it. A button that looked like
 * it worked but did not would be worse than no button at all.
 */

const Wrap = styled.div`
  margin: 0 0 1rem 0;
  padding: 0.75rem 1rem;
  border-radius: 4px;
  border-left: 4px solid ${p => p.accent};
  background: ${p => p.bg};
  font-size: 13px;
  line-height: 1.5;

  .head {
    font-weight: 700;
    color: ${p => p.accent};
    margin-bottom: 2px;
  }
  .body { color: var(--text-primary); }
  .meta {
    margin-top: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }
  code {
    font-family: 'IBM Plex Mono', Menlo, Consolas, monospace;
    font-size: 12px;
    background: rgba(0,0,0,0.06);
    padding: 1px 4px;
    border-radius: 3px;
  }
  ul { margin: 4px 0 0 0; padding-left: 18px; }
  li { font-size: 12px; }
`;

const fmt = (t) => {
  if (!t) return '—';
  try { return new Date(t).toLocaleString(); } catch (e) { return String(t); }
};

class SessionBanner extends Component {
  state = { data: null, loaded: false };

  componentDidMount() {
    this.load();
    this._t = setInterval(() => this.load(), 10000);
  }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }
  componentDidUpdate(prev) {
    if (prev.imsi !== this.props.imsi) this.load();
  }

  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken;
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  load() {
    const imsi = this.props.imsi;
    if (!imsi) return;
    axios({
      baseURL: '/api/session', url: '/State', method: 'get',
      params: { imsi }, headers: this.headers()
    })
      .then(r => this.setState({ data: r.data, loaded: true }))
      .catch(() => this.setState({ loaded: true }));
  }

  render() {
    const d = this.state.data;
    /* Say nothing until we know something — an empty banner is worse than
     * none, and this sits above the QoS the operator is reading. */
    if (!this.state.loaded || !d) return null;

    if (!d.active) {
      return (
        <Wrap accent="#6c757d" bg="rgba(108,117,125,0.08)">
          <div className="head">○ No active PDU session</div>
          <div className="body">
            Changes made here will apply when the UE next attaches.
          </div>
        </Wrap>
      );
    }

    if (d.drift) {
      const fields = (d.drift_fields || []).slice(0, 6);
      return (
        <Wrap accent="#b3433b" bg="rgba(179,67,59,0.08)">
          <div className="head">⚠ Not live — the running session is carrying the previous configuration</div>
          <div className="body">
            QoS last changed <b>{fmt(d.config_changed_at)}</b>
            {d.changed_by ? ' by ' + d.changed_by : ''}; the current PDU session
            was established <b>{fmt(d.established_at)}</b>.
            PCC rules are read only at session establishment.
          </div>
          {fields.length > 0 && (
            <ul>
              {fields.map((f, i) => <li key={i}><code>{f}</code></li>)}
            </ul>
          )}
          <div className="meta">
            To apply: <code>AT+CFUN=0</code> then <code>AT+CFUN=1</code> on the UE,
            then confirm the SMF ledger shows <code>Removed → 0</code> followed by
            <code> Added → 1</code>. <code>--wds-stop-network</code> does not rebuild
            the session.
          </div>
        </Wrap>
      );
    }

    return (
      <Wrap accent="#2f7d5b" bg="rgba(47,125,91,0.08)">
        <div className="head">✓ Live</div>
        <div className="body">
          Session established <b>{fmt(d.established_at)}</b>
          {d.ipv4 ? ' · ' + d.ipv4 : ''}{d.dnn ? ' · ' + d.dnn : ''} — after the
          last configuration change. What is shown below is what the session is
          carrying.
        </div>
      </Wrap>
    );
  }
}

export default SessionBanner;
