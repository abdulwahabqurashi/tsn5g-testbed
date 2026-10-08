import { Component } from 'react';
import styled from 'styled-components';

/*
 * FlowMatchPreview — states, in words, what a PCC flow rule actually matches.
 *
 * The rule is stored in DOWNLINK form:
 *     permit out udp from any 1-65535 to assigned 5202
 * meaning destination = the UE, port 5202. Open5GS derives the UPLINK filter
 * by swapping source and destination, so uplink matches only when the UE's
 * SOURCE port is 5202. Sending *to* port 5202 does nothing.
 *
 * That single misunderstanding voided roughly three weeks of testing: the GBR
 * bearer never carried a byte, and across 10.2 million buffer-status reports
 * its logical-channel group never reported data. Nothing in the console said
 * which direction the rule would match. Now it does.
 *
 * Parses only; never rewrites the operator's rule.
 */

const Wrap = styled.div`
  margin-top: 0.35rem;
  padding: 0.5rem 0.7rem;
  border-radius: 4px;
  background: var(--bg-muted, rgba(0,0,0,0.04));
  border: 1px solid var(--divider, rgba(0,0,0,0.1));
  font-size: 12px;
  line-height: 1.6;

  .lbl {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-transform: uppercase;
  }
  .row { margin-top: 2px; color: var(--text-primary); }
  .dir {
    display: inline-block;
    min-width: 72px;
    font-weight: 700;
  }
  .ul { color: #1f5e42; }
  .dl { color: var(--text-muted); }
  .note {
    margin-top: 4px;
    font-size: 11.5px;
    color: #8a6410;
  }
  .bad { color: #b3433b; }
  code {
    font-family: 'IBM Plex Mono', Menlo, Consolas, monospace;
    background: rgba(0,0,0,0.06);
    padding: 0 3px;
    border-radius: 2px;
  }
`;

/* permit <in|out> <proto> from <src> <sports> to <dst> <dports> */
function parseRule(rule) {
  if (!rule || typeof rule !== 'string') return null;
  const m = rule.trim().match(
    /^permit\s+(in|out)\s+(\S+)\s+from\s+(\S+)(?:\s+([0-9,\-\s]+?))?\s+to\s+(\S+)(?:\s+([0-9,\-\s]+?))?$/i
  );
  if (!m) return null;
  return {
    direction: m[1].toLowerCase(),
    proto: m[2],
    src: m[3], sports: (m[4] || '').trim(),
    dst: m[5], dports: (m[6] || '').trim()
  };
}

const side = (addr) =>
  /^assigned$/i.test(addr) ? 'the UE' : (/^any$/i.test(addr) ? 'anywhere' : addr);

class FlowMatchPreview extends Component {
  render() {
    const raw = this.props.rule;
    if (!raw || !String(raw).trim()) return null;

    const p = parseRule(raw);
    if (!p) {
      return (
        <Wrap>
          <div className="lbl">This rule matches</div>
          <div className="row bad">
            Cannot interpret this rule — check the syntax before saving.
          </div>
        </Wrap>
      );
    }

    /* "permit out" is written from the network's point of view: the
     * destination is the UE. Uplink is the mirror image. */
    /* "permit out" is written from the network's point of view, so its
     * destination is the UE side and its source is the far end. */
    const ueAddr   = p.direction === 'out' ? p.dst : p.src;
    const uePorts  = p.direction === 'out' ? p.dports : p.sports;
    const farSide  = side(p.direction === 'out' ? p.src : p.dst);
    const ueLabel  = side(ueAddr) === 'anywhere' ? 'the UE' : side(ueAddr);
    const uePortsDl = uePorts;
    const uePortsUl = uePorts;
    const proto = p.proto.toUpperCase();

    return (
      <Wrap>
        <div className="lbl">This rule matches</div>
        <div className="row dl">
          <span className="dir">DOWNLINK</span>
          {proto} traffic <b>to</b> {ueLabel}
          {uePortsDl ? <span> at port <code>{uePortsDl}</code></span> : null}
          {farSide !== 'anywhere' ? <span> from {farSide}</span> : null}
        </div>
        <div className="row ul">
          <span className="dir">UPLINK</span>
          {proto} traffic <b>from</b> {ueLabel}
          {uePortsUl ? <span> at <b>source port <code>{uePortsUl}</code></b></span> : null}
        </div>
        {uePortsUl ? (
          <div className="note">
            For uplink to match, the UE must <b>send from</b> port <code>{uePortsUl}</code> —
            sending <i>to</i> it has no effect. With iperf3 that is{' '}
            <code>--cport {String(uePortsUl).split(/[,\-]/)[0]}</code>, or a server on
            the UE with the core pulling via <code>-R</code>.
          </div>
        ) : null}
      </Wrap>
    );
  }
}

export default FlowMatchPreview;
