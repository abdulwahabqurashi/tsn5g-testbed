import { Component } from 'react';
import styled from 'styled-components';
import Session from 'modules/auth/session';

const Panel = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden; margin-top: 1.25rem;
`;
const Head = styled.div`
  padding: 1rem 1.25rem .4rem; font-size: 12px; font-weight: 700;
  text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted);
`;
const Body = styled.div`padding: .4rem 1.25rem 1.1rem; display: flex; flex-wrap: wrap; gap: 10px; align-items: center;
  .lbl { font-size: 13px; color: var(--text-secondary); margin-right: 4px; }
  a { display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 8px;
    font-size: 12.5px; font-weight: 700; text-decoration: none;
    border: 1px solid var(--border-color); color: var(--text-primary); background: var(--bg-card); }
  a:hover { background: var(--bg-hover); }
  a.primary { background: var(--accent); color: #fff; border-color: var(--accent); }
`;

class ReportsCard extends Component {
  token() {
    const s = new Session();
    return ((s || {}).session || {}).authToken || '';
  }
  href(range, format) {
    return '/api/reports/Generate?range=' + range + '&format=' + format +
      '&access_token=' + encodeURIComponent(this.token());
  }
  render() {
    return (
      <Panel>
        <Head>Reports</Head>
        <Body>
          <span className="lbl">Generate a report:</span>
          <a className="primary" target="_blank" href={this.href('24h','html')}>Daily (HTML)</a>
          <a target="_blank" href={this.href('7d','html')}>Weekly (HTML)</a>
          <a target="_blank" href={this.href('30d','html')}>Monthly (HTML)</a>
          <a target="_blank" href={this.href('24h','csv')}>Daily (CSV)</a>
          <a target="_blank" href={this.href('7d','csv')}>Weekly (CSV)</a>
          <span className="lbl" style={{marginLeft:8, fontSize:11, color:'var(--text-muted)'}}>
            HTML reports are print-to-PDF ready · a daily report is also saved on the server automatically.
          </span>
        </Body>
      </Panel>
    );
  }
}
export default ReportsCard;
