import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

const Wrap = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
  input { padding: 6px 10px; font-size: 12px; border-radius: 8px; background: var(--bg-input);
    border: 1px solid transparent; color: var(--text-primary); margin-left: 8px; }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px; overflow: hidden;
`;
const Table = styled.table`
  width: 100%; border-collapse: collapse; font-size: 13px;
  th { text-align: left; padding: 10px 14px; color: var(--text-muted); font-weight: 600;
    border-bottom: 1px solid var(--divider); background: var(--bg-panel-header); }
  td { padding: 9px 14px; border-bottom: 1px solid var(--divider); color: var(--text-secondary); }
  tr:last-child td { border-bottom: none; }
  .u { font-weight: 700; color: var(--text-primary); }
  .role { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 6px;
    border-radius: 5px; background: #f0f2f5; color: var(--text-secondary); margin-left: 6px; }
  .m { font-family: monospace; font-size: 11px; }
  .ok { color: var(--ok); } .bad { color: var(--bad); }
  .t { color: var(--text-muted); white-space: nowrap; }
`;

class AuditView extends Component {
  state = { events: [], filter: '' };
  componentDidMount() { this.load(); this._t = setInterval(() => this.load(), 8000); }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }
  load() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    axios({ baseURL: '/api/audit', url: '/List', method: 'get', headers: h, params: { limit: 300 } })
      .then(r => this.setState({ events: r.data || [] })).catch(() => {});
  }
  render() {
    const f = this.state.filter.toLowerCase();
    const rows = this.state.events.filter(e => !f ||
      (e.user + ' ' + e.action + ' ' + e.target + ' ' + e.resource).toLowerCase().indexOf(f) >= 0);
    return (
      <Wrap>
        <TitleRow>
          <div>
            <h2>Audit Log</h2>
            <span className="sub">Every write action · who, what, when · 1-year retention</span>
          </div>
          <input placeholder="filter…" value={this.state.filter}
            onChange={e => this.setState({ filter: e.target.value })}/>
        </TitleRow>
        <Card>
          <Table>
            <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Target</th><th>Path</th><th>Result</th><th>IP</th></tr></thead>
            <tbody>
              {rows.map((e, i) =>
                <tr key={i}>
                  <td className="t">{new Date(e.ts).toLocaleString()}</td>
                  <td><span className="u">{e.user}</span><span className="role">{e.role}</span></td>
                  <td>{e.action}</td>
                  <td className="m">{e.target || '—'}</td>
                  <td className="m">{e.method} {e.path}</td>
                  <td className={e.status < 400 ? 'ok' : 'bad'}>{e.status}</td>
                  <td className="m">{e.ip}</td>
                </tr>)}
              {rows.length === 0 &&
                <tr><td colSpan="7" style={{textAlign:'center', color:'var(--text-muted)', padding:'2rem'}}>No audit events yet.</td></tr>}
            </tbody>
          </Table>
        </Card>
      </Wrap>
    );
  }
}
export default AuditView;
