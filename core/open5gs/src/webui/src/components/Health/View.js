import { Component } from 'react';
import axios from 'axios';
import styled from 'styled-components';
import Session from 'modules/auth/session';

const Wrap = styled.div`width: 100%; padding: 1rem;`;
const TitleRow = styled.div`
  display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;
  h2 { margin: 0; font-size: 20px; font-weight: 700; color: var(--text-primary); }
  .sub { font-size: 11px; color: var(--text-muted); }
`;
const SummaryRow = styled.div`
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 1.25rem;
`;
const Stat = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 14px 16px;
  .v { font-size: 26px; font-weight: 800; color: ${p => p.c || 'var(--text-primary)'}; }
  .l { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-muted); margin-top: 2px; }
`;
const Banner = styled.div`
  display: flex; align-items: center; gap: 12px;
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  padding: 16px 20px; margin-bottom: 1.25rem;
  .dot { width: 14px; height: 14px; border-radius: 50%;
    background: ${p => p.c}; box-shadow: 0 0 0 5px ${p => p.soft}; }
  .txt { font-size: 16px; font-weight: 700; color: var(--text-primary); }
  .sub { margin-left: auto; font-size: 12px; color: var(--text-muted); }
`;
const Card = styled.div`
  background: var(--bg-card); box-shadow: var(--card-shadow); border-radius: 14px;
  overflow: hidden;
`;
const Item = styled.div`
  display: flex; align-items: flex-start; gap: 12px;
  padding: 12px 18px; border-bottom: 1px solid var(--divider);
  &:last-child { border-bottom: none; }
  .ic { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%; margin-top: 1px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 800; color: #fff; background: ${p => p.c}; }
  .body { flex: 1; min-width: 0; }
  .title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
  .detail { font-size: 12.5px; color: var(--text-secondary); margin-top: 2px;
    font-family: 'SF Mono', Menlo, monospace; }
  .fix { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
  .sev { flex: 0 0 auto; font-size: 10px; font-weight: 700; text-transform: uppercase;
    letter-spacing: .05em; padding: 3px 8px; border-radius: 6px; margin-top: 1px;
    color: ${p => p.c}; background: ${p => p.soft}; }
`;
const RefreshBtn = styled.button`
  padding: 8px 18px; border: none; border-radius: 10px;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
  &:hover { background: #0059d6; }
`;

const SEV = {
  critical: { c: '#f0383b', soft: 'rgba(240,56,59,0.14)', mark: '!' },
  warning:  { c: '#f5a524', soft: 'rgba(245,165,36,0.16)', mark: '!' },
  info:     { c: '#478ff7', soft: 'rgba(71,143,247,0.14)', mark: 'i' },
  ok:       { c: '#43c478', soft: 'rgba(67,196,120,0.16)', mark: '✓' },
};

class HealthView extends Component {
  state = { data: null, loading: false, error: null };

  componentDidMount() { this.fetch(); }

  fetch() {
    const s = new Session();
    const csrf = ((s || {}).session || {}).csrfToken;
    const authToken = ((s || {}).session || {}).authToken;
    const headers = { 'X-CSRF-TOKEN': csrf };
    if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
    this.setState({ loading: true });
    axios({ baseURL: '/api/health', url: '/Config', method: 'get', headers, timeout: 15000 })
      .then(r => this.setState({ data: r.data, loading: false, error: null }))
      .catch(e => this.setState({ loading: false,
        error: ((e.response || {}).data || {}).error || e.message }));
  }

  render() {
    const { data, loading, error } = this.state;
    const sum = (data || {}).summary || {};
    const findings = ((data || {}).findings || [])
      .slice().sort((a, b) => {
        const rank = { critical: 0, warning: 1, info: 2, ok: 3 };
        return rank[a.severity] - rank[b.severity];
      });
    const worst = sum.critical > 0 ? 'critical' : sum.warning > 0 ? 'warning' : 'ok';
    const bannerText = sum.critical > 0 ?
        sum.critical + ' critical issue' + (sum.critical > 1 ? 's' : '') + ' found' :
      sum.warning > 0 ? sum.warning + ' warning' + (sum.warning > 1 ? 's' : '') :
        'Configuration is healthy';

    return (
      <Wrap>
        <TitleRow>
          <div>
            <h2>Config Health Check</h2>
            <span className="sub">
              {loading ? 'checking…' :
                data ? 'checked ' + new Date(data.ts).toLocaleTimeString() : ''}
              {' · validates the deployment-guide pitfalls'}
            </span>
          </div>
          <RefreshBtn onClick={() => this.fetch()}>Re-check</RefreshBtn>
        </TitleRow>

        {error && <Banner c="#f0383b" soft="rgba(240,56,59,0.14)">
          <div className="dot"/><div className="txt">Health check failed: {error}</div></Banner>}

        {data &&
          <Banner c={SEV[worst].c} soft={SEV[worst].soft}>
            <div className="dot"/>
            <div className="txt">{bannerText}</div>
            <div className="sub">{sum.ok}/{sum.total} checks passing</div>
          </Banner>}

        {data &&
          <SummaryRow>
            <Stat c="#43c478"><div className="v">{sum.ok}</div><div className="l">Passing</div></Stat>
            <Stat c="#f0383b"><div className="v">{sum.critical}</div><div className="l">Critical</div></Stat>
            <Stat c="#f5a524"><div className="v">{sum.warning}</div><div className="l">Warnings</div></Stat>
            <Stat c="#478ff7"><div className="v">{sum.info}</div><div className="l">Info</div></Stat>
          </SummaryRow>}

        {data &&
          <Card>
            {findings.map(f => {
              const sv = SEV[f.severity] || SEV.info;
              return (
                <Item key={f.id} c={sv.c} soft={sv.soft}>
                  <div className="ic" style={{background: sv.c}}>{sv.mark}</div>
                  <div className="body">
                    <div className="title">{f.title}</div>
                    <div className="detail">{f.detail}</div>
                    {!f.ok && f.fix && <div className="fix">Fix: {f.fix}</div>}
                  </div>
                  <div className="sev">{f.severity}</div>
                </Item>
              );
            })}
          </Card>}
      </Wrap>
    );
  }
}

export default HealthView;
