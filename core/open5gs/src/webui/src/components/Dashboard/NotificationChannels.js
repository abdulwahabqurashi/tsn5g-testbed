import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

const Panel = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden; margin-top: 1.25rem;
`;
const Head = styled.div`
  padding: 1rem 1.25rem .6rem;
  font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
  color: var(--text-muted);
  display: flex; justify-content: space-between; align-items: center;
`;
const Body = styled.div`padding: .5rem 1.25rem 1.1rem;`;
const Row = styled.div`
  display: flex; align-items: center; gap: 8px; padding: 7px 0;
  border-bottom: 1px solid var(--divider); font-size: 13px;
  &:last-child { border-bottom: none; }
  .name { font-weight: 600; color: var(--text-primary); min-width: 90px; }
  .type { font-size: 11px; padding: 2px 8px; border-radius: 6px; background: #f0f2f5;
    color: var(--text-secondary); text-transform: uppercase; }
  .url { flex: 1; color: var(--text-muted); font-family: monospace; font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rm { color: var(--bad); cursor: pointer; font-weight: 700; }
`;
const Form = styled.div`
  display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
  input, select { padding: 6px 10px; font-size: 12px; border-radius: 8px;
    background: var(--bg-input); border: 1px solid transparent; color: var(--text-primary); }
  input.url { flex: 1; min-width: 180px; font-family: monospace; }
`;
const Btn = styled.div`
  display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 8px;
  background: ${p => p.ghost ? 'transparent' : 'var(--accent)'};
  border: ${p => p.ghost ? '1px solid var(--border-color)' : 'none'};
  color: ${p => p.ghost ? 'var(--text-secondary)' : '#fff'};
  font-size: 12px; font-weight: 700; cursor: pointer;
  &:hover { opacity: .9; }
`;

class NotificationChannels extends Component {
  state = { channels: [], draft: { name: '', type: 'webhook', url: '', min_severity: 'warning', enabled: true }, msg: '' };

  componentDidMount() { this.load(); }

  headers() {
    const s = new Session();
    const csrf = ((s || {}).session || {}).csrfToken;
    const authToken = ((s || {}).session || {}).authToken;
    const h = { 'X-CSRF-TOKEN': csrf };
    if (authToken) h['Authorization'] = 'Bearer ' + authToken;
    return h;
  }

  load() {
    axios({ baseURL: '/api/alerts', url: '/Config', method: 'get', headers: this.headers() })
      .then(r => this.setState({ channels: (r.data || {}).channels || [] }))
      .catch(() => {});
  }

  save(channels) {
    return axios({ baseURL: '/api/alerts', url: '/Config', method: 'put',
      headers: this.headers(), data: { channels } })
      .then(r => this.setState({ channels: (r.data || {}).channels || [] }));
  }

  add = () => {
    const d = this.state.draft;
    if (!d.name || !d.url) { this.setState({ msg: 'name and URL required' }); return; }
    this.save(this.state.channels.concat([d]))
      .then(() => this.setState({ draft: { name: '', type: 'webhook', url: '', min_severity: 'warning', enabled: true }, msg: '' }))
      .catch(() => this.setState({ msg: 'save failed (operator role required)' }));
  };

  remove = (i) => {
    this.save(this.state.channels.filter((c, idx) => idx !== i)).catch(() => {});
  };

  test = () => {
    this.setState({ msg: 'sending…' });
    axios({ baseURL: '/api/alerts', url: '/Test', method: 'post', headers: this.headers() })
      .then(r => this.setState({ msg: 'delivered to: ' + ((r.data.delivered || []).join(', ') || 'no channels') }))
      .catch(() => this.setState({ msg: 'test failed (operator role required)' }));
  };

  render() {
    const { channels, draft, msg } = this.state;
    const set = (k, v) => this.setState({ draft: Object.assign({}, draft, { [k]: v }) });
    return (
      <Panel>
        <Head>
          <span>Notification Channels</span>
          <Btn ghost onClick={this.test}>Send test</Btn>
        </Head>
        <Body>
          {channels.length === 0 &&
            <div style={{fontSize:13, color:'var(--text-muted)', padding:'6px 0'}}>
              No channels — add a Slack/Teams incoming-webhook or generic URL to receive alerts even with no browser open.
            </div>}
          {channels.map((c, i) =>
            <Row key={i}>
              <span className="name">{c.name}</span>
              <span className="type">{c.type}</span>
              <span className="url">{c.url}</span>
              <span style={{fontSize:11, color:'var(--text-muted)'}}>≥{c.min_severity}</span>
              <span className="rm" onClick={() => this.remove(i)}>✕</span>
            </Row>)}
          <Form>
            <input placeholder="name" value={draft.name} onChange={e => set('name', e.target.value)} style={{width:100}}/>
            <select value={draft.type} onChange={e => set('type', e.target.value)}>
              <option value="webhook">Webhook</option>
              <option value="slack">Slack</option>
              <option value="teams">Teams</option>
            </select>
            <input className="url" placeholder="https://hooks.slack.com/… or Teams webhook URL"
              value={draft.url} onChange={e => set('url', e.target.value)}/>
            <select value={draft.min_severity} onChange={e => set('min_severity', e.target.value)}>
              <option value="info">≥ info</option>
              <option value="warning">≥ warning</option>
              <option value="error">≥ error</option>
            </select>
            <Btn onClick={this.add}>Add</Btn>
          </Form>
          {msg && <div style={{fontSize:12, color:'var(--text-secondary)', marginTop:8}}>{msg}</div>}
        </Body>
      </Panel>
    );
  }
}

export default NotificationChannels;
