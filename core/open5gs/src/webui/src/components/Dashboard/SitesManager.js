import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { isOperator } from 'helpers/role';

const Panel = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden; margin-top: 1.25rem;
`;
const Head = styled.div`
  padding: 1rem 1.25rem .4rem; font-size: 12px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted);
`;
const Body = styled.div`padding: .4rem 1.25rem 1.1rem;`;
const Row = styled.div`
  display: flex; align-items: center; gap: 8px; padding: 7px 0;
  border-bottom: 1px solid var(--divider); font-size: 13px;
  &:last-child { border-bottom: none; }
  .dot { width: 10px; height: 10px; border-radius: 3px; }
  .nm { font-weight: 600; color: var(--text-primary); min-width: 140px; }
  .tac { font-family: monospace; font-size: 11px; color: var(--text-muted); }
  .rm { color: var(--bad); cursor: pointer; font-weight: 700; margin-left: auto; }
`;
const Form = styled.div`
  display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center;
  input { padding: 6px 10px; font-size: 12px; border-radius: 8px; background: var(--bg-input);
    border: 1px solid transparent; color: var(--text-primary); }
  input[type=color] { padding: 2px; width: 34px; height: 30px; }
`;
const Btn = styled.div`
  display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 8px;
  background: var(--accent); color: #fff; font-size: 12px; font-weight: 700; cursor: pointer;
  &:hover { opacity: .9; }
`;

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

class SitesManager extends Component {
  state = { sites: [], draft: { name: '', location: '', color: '#478ff7', tacs: '', gnb_ids: '' }, msg: '' };
  componentDidMount() { this.load(); }
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  load() {
    axios({ baseURL: '/api/sites', url: '/List', method: 'get', headers: this.headers() })
      .then(r => this.setState({ sites: r.data || [] })).catch(() => {});
  }
  add = () => {
    const d = this.state.draft;
    if (!d.name) { this.setState({ msg: 'name required' }); return; }
    const body = {
      site_id: slug(d.name), name: d.name, location: d.location, color: d.color,
      tacs: d.tacs.split(',').map(x => x.trim()).filter(Boolean),
      gnb_ids: d.gnb_ids.split(',').map(x => x.trim()).filter(Boolean).map(Number)
    };
    axios({ baseURL: '/api/sites', url: '/Save', method: 'put', headers: this.headers(), data: body })
      .then(() => { this.setState({ draft: { name: '', location: '', color: '#478ff7', tacs: '', gnb_ids: '' }, msg: '' }); this.load(); })
      .catch(() => this.setState({ msg: 'save failed (operator role required)' }));
  };
  remove = (id) => {
    axios({ baseURL: '/api/sites', url: '/' + id, method: 'delete', headers: this.headers() })
      .then(() => this.load()).catch(() => {});
  };
  render() {
    if (!isOperator()) return null;
    const { sites, draft, msg } = this.state;
    const set = (k, v) => this.setState({ draft: Object.assign({}, draft, { [k]: v }) });
    return (
      <Panel>
        <Head>Sites</Head>
        <Body>
          {sites.map(s =>
            <Row key={s.site_id}>
              <span className="dot" style={{background: s.color}}/>
              <span className="nm">{s.name}</span>
              <span className="tac">TAC {(s.tacs || []).join(', ') || '—'}{(s.gnb_ids || []).length ? ' · gNB ' + s.gnb_ids.join(',') : ''}</span>
              {s.location && <span className="tac">· {s.location}</span>}
              <span className="rm" onClick={() => this.remove(s.site_id)}>✕</span>
            </Row>)}
          {sites.length === 0 && <div style={{fontSize:13, color:'var(--text-muted)', padding:'6px 0'}}>No sites yet — add one below. gNBs auto-group by TAC.</div>}
          <Form>
            <input placeholder="Site name" value={draft.name} onChange={e => set('name', e.target.value)} style={{width:150}}/>
            <input placeholder="Location" value={draft.location} onChange={e => set('location', e.target.value)} style={{width:120}}/>
            <input placeholder="TACs (e.g. 000001,000002)" value={draft.tacs} onChange={e => set('tacs', e.target.value)} style={{width:180}}/>
            <input placeholder="gNB overrides (ids)" value={draft.gnb_ids} onChange={e => set('gnb_ids', e.target.value)} style={{width:140}}/>
            <input type="color" value={draft.color} onChange={e => set('color', e.target.value)}/>
            <Btn onClick={this.add}>Add / update site</Btn>
          </Form>
          {msg && <div style={{fontSize:12, color:'var(--text-secondary)', marginTop:8}}>{msg}</div>}
        </Body>
      </Panel>
    );
  }
}
export default SitesManager;
