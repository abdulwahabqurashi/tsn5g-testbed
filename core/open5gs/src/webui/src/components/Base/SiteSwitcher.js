import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { getActiveSite, setActiveSite } from 'helpers/site';

const Chip = styled.div`
  display: flex; align-items: center; position: relative;
  padding: 0 12px 0 10px; height: 48px;
  border-right: 1px solid var(--divider); cursor: pointer;
  user-select: none;
  &:hover { background: rgba(16,24,40,0.03); }
  .sq { width: 26px; height: 26px; border-radius: 7px; background: #0a2540; color: #fff;
    display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 800; }
  .dot { width: 6px; height: 6px; border-radius: 50%; margin-left: 8px; background: var(--ok); }
  .lbl { margin-left: 6px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .chev { margin-left: 8px; font-size: 10px; color: var(--text-muted); }
`;
const Menu = styled.div`
  position: absolute; top: 46px; left: 0; z-index: 100; min-width: 220px;
  background: #fff; border-radius: 10px; box-shadow: 0 8px 28px rgba(16,24,40,0.18);
  padding: 6px; border: 1px solid var(--divider);
`;
const MItem = styled.div`
  display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px;
  font-size: 13px; cursor: pointer; color: var(--text-primary);
  background: ${p => p.active ? 'var(--accent-soft)' : 'transparent'};
  &:hover { background: ${p => p.active ? 'var(--accent-soft)' : 'var(--bg-hover)'}; }
  .sdot { width: 8px; height: 8px; border-radius: 50%; background: ${p => p.c || '#478ff7'}; }
  .meta { margin-left: auto; font-size: 11px; color: var(--text-muted); }
`;

class SiteSwitcher extends Component {
  state = { open: false, sites: [], active: '_all', groups: [] };

  componentDidMount() {
    this.setState({ active: getActiveSite() });
    this.load();
    this._t = setInterval(() => this.load(), 10000);
  }
  componentWillUnmount() { if (this._t) clearInterval(this._t); }

  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = ((s || {}).session || {}).authToken; if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  load() {
    axios({ baseURL: '/api/sites', url: '/Grouped', method: 'get', headers: this.headers() })
      .then(r => this.setState({ sites: (r.data || {}).sites || [], groups: (r.data || {}).groups || [] }))
      .catch(() => {});
  }
  pick(id) {
    setActiveSite(id);
    this.setState({ active: id, open: false });
  }
  groupFor(id) { return this.state.groups.filter(g => g.site_id === id)[0] || {}; }

  render() {
    const { open, sites, active } = this.state;
    const activeSite = sites.filter(s => s.site_id === active)[0];
    const label = active === '_all' ? 'All Sites' : (activeSite ? activeSite.name : 'All Sites');
    return (
      <Chip onClick={() => this.setState({ open: !open })}>
        <div className="sq">A</div>
        <div className="dot"/>
        <div className="lbl">{label}</div>
        <div className="chev">▾</div>
        {open &&
          <Menu onClick={e => e.stopPropagation()}>
            <MItem active={active === '_all'} onClick={() => this.pick('_all')}>
              <span className="sdot" style={{background:'#1d2126'}}/> All Sites
              <span className="meta">{sites.length} site{sites.length !== 1 ? 's' : ''}</span>
            </MItem>
            {sites.map(s => {
              const g = this.groupFor(s.site_id);
              return (
                <MItem key={s.site_id} active={active === s.site_id} c={s.color}
                  onClick={() => this.pick(s.site_id)}>
                  <span className="sdot" style={{background: s.color}}/>
                  {s.name}
                  <span className="meta">{(g.gnbs || []).length} gNB · {g.connected_ues || 0} UE</span>
                </MItem>
              );
            })}
            {sites.length === 0 &&
              <div style={{padding:'8px 10px', fontSize:12, color:'var(--text-muted)'}}>
                No sites — add one in Sites (Account area).
              </div>}
          </Menu>}
      </Chip>
    );
  }
}

export default SiteSwitcher;
