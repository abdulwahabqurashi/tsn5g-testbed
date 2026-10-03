import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';
import { isAdmin } from 'helpers/role';

const Panel = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden; margin-top: 1.25rem;
`;
const Head = styled.div`
  padding: 1rem 1.25rem .4rem; font-size: 12px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted);
`;
const Body = styled.div`
  padding: .4rem 1.25rem 1.1rem; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  .lbl { font-size: 12px; color: var(--text-muted); }
  a, label { display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 8px;
    font-size: 12.5px; font-weight: 700; text-decoration: none; cursor: pointer;
    border: 1px solid var(--border-color); color: var(--text-primary); background: var(--bg-card); }
  a.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
  input[type=file] { display: none; }
`;

class BackupCard extends Component {
  state = { msg: '' };

  token() { return (((new Session()) || {}).session || {}).authToken || ''; }
  headers() {
    const s = new Session();
    const h = { 'X-CSRF-TOKEN': ((s || {}).session || {}).csrfToken };
    const t = this.token(); if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  onFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!window.confirm('Restore will overwrite subscribers, profiles, accounts and alert config from this file. Continue?')) return;
    const reader = new FileReader();
    reader.onload = () => {
      let bundle;
      try { bundle = JSON.parse(reader.result); }
      catch (err) { this.setState({ msg: 'invalid JSON file' }); return; }
      this.setState({ msg: 'restoring…' });
      axios({ baseURL: '/api/backup', url: '/Import', method: 'post',
        headers: this.headers(), data: { bundle } })
        .then(r => this.setState({ msg: 'restored: ' +
          Object.keys(r.data.restored).map(k => k + '(' + r.data.restored[k] + ')').join(', ') }))
        .catch(err => this.setState({ msg: 'restore failed: ' +
          (((err.response || {}).data || {}).error || err.message) }));
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  render() {
    if (!isAdmin()) return null;
    return (
      <Panel>
        <Head>Backup &amp; Restore</Head>
        <Body>
          <span className="lbl">Full state:</span>
          <a className="primary" target="_blank"
            href={'/api/backup/Export?access_token=' + encodeURIComponent(this.token())}>
            Export bundle
          </a>
          <label>Restore from file…
            <input type="file" accept="application/json" onChange={this.onFile}/>
          </label>
          <span className="lbl">Subscribers, profiles, accounts, alert config &amp; TSN bridges · a daily backup is kept on the server (last 14).</span>
          {this.state.msg && <span style={{fontSize:12, color:'var(--text-secondary)', width:'100%'}}>{this.state.msg}</span>}
        </Body>
      </Panel>
    );
  }
}
export default BackupCard;
