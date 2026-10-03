import { Component } from 'react';
import styled from 'styled-components';
import oc from 'open-color';

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 1rem;
  max-width: 960px;
  margin: 0 auto;
`;

const PageTitle = styled.h1`
  font-size: 24px;
  font-weight: 700;
  color: ${'var(--text-primary)'};
  margin-bottom: 0.5rem;
`;

const PageSubtitle = styled.div`
  font-size: 14px;
  color: ${'var(--text-muted)'};
  margin-bottom: 1.5rem;
`;

const TOCCard = styled.div`
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  border-radius: 4px;
  border-top: 3px solid ${'var(--accent)'};
  padding: 1.25rem 1.5rem;
  margin-bottom: 1.5rem;
`;

const TOCTitle = styled.div`
  font-size: 14px;
  font-weight: 700;
  color: ${'var(--text-secondary)'};
  margin-bottom: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.5px;
`;

const TOCList = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 2rem;
`;

const TOCItem = styled.a`
  font-size: 13px;
  color: ${'var(--accent)'};
  text-decoration: none;
  padding: 3px 0;
  cursor: pointer;
  &:hover { color: ${'var(--accent)'}; text-decoration: underline; }
`;

const Section = styled.div`
  background: var(--bg-card);
  box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.24);
  border-radius: 4px;
  border-top: 3px solid ${p => p.color || 'var(--text-muted)'};
  margin-bottom: 1.5rem;
  overflow: hidden;
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid ${'var(--divider)'};
`;

const StepBadge = styled.div`
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: ${p => p.color || 'var(--accent)'};
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  flex-shrink: 0;
`;

const SectionTitle = styled.div`
  font-size: 16px;
  font-weight: 700;
  color: ${'var(--text-primary)'};
`;

const SectionBody = styled.div`
  padding: 1.25rem;
  font-size: 13px;
  line-height: 1.7;
  color: ${'var(--text-secondary)'};

  p { margin: 0 0 0.75rem 0; }
  ul, ol { margin: 0 0 0.75rem 0; padding-left: 1.5rem; }
  li { margin-bottom: 4px; }
  strong { color: ${'var(--text-primary)'}; }
`;

const Code = styled.code`
  background: ${'var(--divider)'};
  border: 1px solid ${'var(--border-color)'};
  border-radius: 3px;
  padding: 1px 5px;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  color: ${oc.pink[7]};
`;

const CodeBlock = styled.pre`
  background: ${'var(--text-primary)'};
  color: ${'var(--bg-hover)'};
  border-radius: 4px;
  padding: 1rem;
  margin: 0.75rem 0;
  overflow-x: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre;
`;

const InfoBox = styled.div`
  background: ${p => p.warn ? oc.yellow[0] : oc.blue[0]};
  border: 1px solid ${p => p.warn ? oc.yellow[3] : oc.blue[3]};
  border-radius: 4px;
  padding: 0.75rem 1rem;
  margin: 0.75rem 0;
  font-size: 13px;
  color: ${p => p.warn ? oc.yellow[9] : oc.blue[8]};

  strong { color: inherit; }
`;

const DiagramBox = styled.pre`
  background: ${'var(--bg-hover)'};
  border: 1px solid ${'var(--border-color)'};
  border-radius: 4px;
  padding: 1rem;
  margin: 0.75rem 0;
  overflow-x: auto;
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 11px;
  line-height: 1.4;
  color: ${'var(--text-secondary)'};
`;

const ApiTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 0.75rem 0;

  th {
    text-align: left;
    padding: 8px 10px;
    background: ${'var(--divider)'};
    border: 1px solid ${'var(--border-color)'};
    color: ${'var(--text-secondary)'};
    font-weight: 600;
    text-transform: uppercase;
    font-size: 11px;
  }

  td {
    padding: 6px 10px;
    border: 1px solid ${'var(--border-color)'};
    color: ${'var(--text-secondary)'};
    font-family: 'SFMono-Regular', Consolas, monospace;
  }

  td:first-child {
    white-space: nowrap;
  }
`;

const Divider = styled.hr`
  border: none;
  border-top: 1px solid ${'var(--border-color)'};
  margin: 1rem 0;
`;

function scrollTo(id) {
  var el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

class Guide extends Component {
  render() {
    return (
      <Wrapper>
        <PageTitle>5G-TSN Integration Guide</PageTitle>
        <PageSubtitle>
          Complete step-by-step guide for setting up, configuring, and testing
          Time-Sensitive Networking (TSN) over the 5G System using the AMRC 5G-TSN core
        </PageSubtitle>

        {/* Table of Contents */}
        <TOCCard>
          <TOCTitle>Table of Contents</TOCTitle>
          <TOCList>
            <TOCItem onClick={function(){scrollTo('sec-arch')}}>1. Architecture Overview</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-prereq')}}>2. Prerequisites</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-upf')}}>3. Configure UPF for NW-TT</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-smf')}}>4. Configure SMF for Ethernet PDU</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-start')}}>5. Start Core Network</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-bridge')}}>6. Create a TSN Bridge</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-ports')}}>7. Add Ports to Bridge</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-qos')}}>8. Configure QoS Mapping</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-tsc')}}>9. Configure TSC Assistance</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-ue')}}>10. Connect UE with Ethernet PDU</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-test')}}>11. Test Bridge with Traffic</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-monitor')}}>12. Monitor in WebUI</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-api')}}>13. API Reference</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-trouble')}}>14. Troubleshooting</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-nwtt-config')}}>15. NW-TT YAML Reference</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-gptp-config')}}>16. gPTP Configuration</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-lldp-config')}}>17. LLDP Settings</TOCItem>
            <TOCItem onClick={function(){scrollTo('sec-psfp-config')}}>18. PSFP / Stream Filters</TOCItem>
          </TOCList>
        </TOCCard>

        {/* Section 1: Architecture Overview */}
        <Section id="sec-arch" color={'var(--accent)'}>
          <SectionHeader>
            <StepBadge color={'var(--accent)'}>1</StepBadge>
            <SectionTitle>Architecture Overview</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              The 5G System (5GS) can act as a <strong>virtual IEEE 802.1Q TSN bridge</strong> between
              two Time-Sensitive Networking end stations. This is defined in <strong>3GPP TS 23.501 Section 5.28</strong>.
              The 5GS bridge has two types of translation terminations:
            </p>
            <ul>
              <li><strong>NW-TT (Network-side Translation Termination)</strong> — Resides in the UPF.
                Handles Ethernet frame forwarding, gPTP residence time insertion, PCP classification,
                PSFP metering, and de-jitter buffering.</li>
              <li><strong>DS-TT (Device-side Translation Termination)</strong> — Resides in the UE.
                Bridges Ethernet traffic between the TSN end station and the 5G modem.</li>
              <li><strong>TSN-AF (TSN Application Function)</strong> — A new 5GC NF that manages TSN bridge
                configuration, receives CNC (Centralized Network Configuration) commands, and pushes
                policies to the PCF/SMF/UPF.</li>
            </ul>

            <DiagramBox>{
'                                    5GS TSN Bridge\n' +
'                    ┌─────────────────────────────────────────┐\n' +
'                    │                                         │\n' +
'  ┌───────────┐     │  ┌───────┐    ┌─────┐    ┌───────┐     │     ┌───────────┐\n' +
'  │ TSN End   │     │  │ DS-TT │    │ 5G  │    │ NW-TT │     │     │ TSN End   │\n' +
'  │ Station 1 │◄───►│  │ (UE)  │◄──►│ NR  │◄──►│ (UPF) │◄───►│◄───►│ Station 2 │\n' +
'  │           │ ETH │  │       │ Air│gNodeB│GTP │       │ ETH │     │           │\n' +
'  └───────────┘     │  └───────┘    └─────┘    └───┬───┘     │     └───────────┘\n' +
'                    │                               │         │\n' +
'                    │                          Linux Bridge    │\n' +
'                    │                          (tsn-br-xxx)    │\n' +
'                    │                               │         │\n' +
'                    │                          Physical NIC    │\n' +
'                    │                          (e.g. eth0)     │\n' +
'                    └─────────────────────────────────────────┘\n' +
'\n' +
'  Management Plane:\n' +
'  ┌─────┐    ┌───────┐    ┌─────┐    ┌─────┐    ┌─────┐\n' +
'  │ CNC │───►│TSN-AF │───►│ PCF │───►│ SMF │───►│ UPF │\n' +
'  └─────┘    └───────┘    └─────┘    └─────┘    └─────┘\n' +
'  (external)  HTTP/2       SBI        SBI        PFCP'
            }</DiagramBox>

            <p><strong>Data Plane Flow:</strong></p>
            <ol>
              <li>TSN End Station 1 sends Ethernet frames to the DS-TT (UE)</li>
              <li>The DS-TT encapsulates frames and sends them over 5G NR to the gNodeB</li>
              <li>The gNodeB forwards frames via GTP-U tunnel to the UPF</li>
              <li>The UPF's NW-TT processes the frames (PCP classification, PSFP, gPTP, residence time tracking)</li>
              <li>Frames exit via a Linux bridge to the physical NIC, reaching TSN End Station 2</li>
            </ol>

            <p><strong>Management Plane Flow:</strong></p>
            <ol>
              <li>A CNC (Centralized Network Configuration) entity sends bridge/port configs to the TSN-AF</li>
              <li>The TSN-AF encodes configs using TS 24.519 and pushes them via PCF/SMF to the UPF</li>
              <li>The UPF applies stream filters, QoS mappings, and PSFP rules to the NW-TT</li>
            </ol>
          </SectionBody>
        </Section>

        {/* Section 2: Prerequisites */}
        <Section id="sec-prereq" color={oc.orange[5]}>
          <SectionHeader>
            <StepBadge color={oc.orange[5]}>2</StepBadge>
            <SectionTitle>Prerequisites</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p><strong>Required Software:</strong></p>
            <ul>
              <li>AMRC 5G-TSN core built with TSN support (meson build)</li>
              <li>MongoDB running (for subscriber database)</li>
              <li>Python 3 + Scapy (for traffic testing)</li>
              <li>Linux kernel with bridge and TAP/TUN support</li>
            </ul>

            <p><strong>Required Privileges:</strong></p>
            <InfoBox warn>
              <strong>Important:</strong> The TSN-AF process needs <Code>CAP_NET_ADMIN</Code> capability
              to create Linux bridges and TAP devices. Either run it as root with <Code>sudo</Code> or set the capability:
            </InfoBox>
            <CodeBlock>{
'# Option 1: Run TSN-AF with sudo\n' +
'sudo ./build/src/tsn-af/open5gs-tsn-afd -c build/configs/open5gs/tsn-af.yaml\n' +
'\n' +
'# Option 2: Set capability on the binary\n' +
'sudo setcap cap_net_admin+ep ./build/src/tsn-af/open5gs-tsn-afd'
            }</CodeBlock>

            <p><strong>Required Network Interfaces:</strong></p>
            <CodeBlock>{
'# Create TUN device for IP PDU sessions\n' +
'sudo ip tuntap add name ogstun mode tun\n' +
'sudo ip addr add 10.45.0.1/16 dev ogstun\n' +
'sudo ip link set ogstun up\n' +
'\n' +
'# Create TAP device for Ethernet PDU sessions (TSN)\n' +
'sudo ip tuntap add name ogstap mode tap\n' +
'sudo ip link set ogstap up'
            }</CodeBlock>

            <p><strong>Required 5G core Services (minimum for TSN):</strong></p>
            <ul>
              <li><strong>NRF</strong> — NF Repository Function (service discovery)</li>
              <li><strong>SCP</strong> — Service Communication Proxy</li>
              <li><strong>AMF</strong> — Access and Mobility Management Function</li>
              <li><strong>SMF</strong> — Session Management Function</li>
              <li><strong>UPF</strong> — User Plane Function (with NW-TT)</li>
              <li><strong>UDM</strong> — Unified Data Management</li>
              <li><strong>UDR</strong> — Unified Data Repository</li>
              <li><strong>AUSF</strong> — Authentication Server Function</li>
              <li><strong>PCF</strong> — Policy Control Function</li>
              <li><strong>NSSF</strong> — Network Slice Selection Function</li>
              <li><strong>BSF</strong> — Binding Support Function</li>
              <li><strong>TSN-AF</strong> — TSN Application Function</li>
            </ul>

            <p><strong>Required Hardware (for E2E testing):</strong></p>
            <ul>
              <li>A 5G gNodeB (e.g., srsRAN, UERANSIM for simulation)</li>
              <li>A 5G UE with Ethernet PDU session support</li>
              <li>At least one physical Ethernet NIC for TSN bridge attachment</li>
            </ul>
          </SectionBody>
        </Section>

        {/* Section 3: Configure UPF */}
        <Section id="sec-upf" color={'var(--accent)'}>
          <SectionHeader>
            <StepBadge color={'var(--accent)'}>3</StepBadge>
            <SectionTitle>Step 1: Configure UPF for NW-TT</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              Edit the UPF configuration file to enable NW-TT bridge support and add an Ethernet PDU
              session with a TAP device. The config file is typically at{' '}
              <Code>build/configs/open5gs/upf.yaml</Code> or <Code>/etc/open5gs/upf.yaml</Code>.
            </p>

            <p><strong>Add TSN Ethernet session to the session list:</strong></p>
            <CodeBlock>{
'upf:\n' +
'  pfcp:\n' +
'    server:\n' +
'      - address: 127.0.0.7\n' +
'  gtpu:\n' +
'    server:\n' +
'      - address: 127.0.0.7\n' +
'  session:\n' +
'    - subnet: 10.45.0.0/16      # Normal IP PDU sessions\n' +
'      gateway: 10.45.0.1\n' +
'    - subnet: 2001:db8:cafe::/48\n' +
'      gateway: 2001:db8:cafe::1\n' +
'    - dnn: tsn                   # <-- Ethernet PDU session for TSN\n' +
'      dev: ogstap               # <-- TAP device (no IP subnet)\n' +
'  metrics:\n' +
'    server:\n' +
'      - address: 127.0.0.7\n' +
'        port: 9090'
            }</CodeBlock>

            <p><strong>Add NW-TT bridge configuration (below the session block):</strong></p>
            <CodeBlock>{
'  # NW-TT Bridge Configuration\n' +
'  nwtt:\n' +
'    enabled: true\n' +
'    bridge_id: 1\n' +
'    bridge_mac: "02:00:00:00:00:01"\n' +
'    qos_mappings:\n' +
'      - pcp: 7                   # Highest priority (Network Control)\n' +
'        qfi: 86\n' +
'      - pcp: 6                   # Voice\n' +
'        qfi: 85\n' +
'      - pcp: 5                   # Video\n' +
'        qfi: 84\n' +
'    gptp:\n' +
'      enabled: true              # Enable IEEE 802.1AS support\n' +
'      time_domain_number: 0'
            }</CodeBlock>

            <InfoBox>
              <strong>Note:</strong> The <Code>dnn: tsn</Code> session entry has no <Code>subnet</Code> field —
              this tells the UPF to use Ethernet (Layer 2) mode instead of IP (Layer 3) mode.
              The <Code>dev: ogstap</Code> specifies the TAP device that the TSN-AF bridge will attach to.
            </InfoBox>

            <p><strong>Configuration Parameters:</strong></p>
            <ul>
              <li><Code>bridge_id</Code> — Numeric identifier for the NW-TT bridge instance</li>
              <li><Code>bridge_mac</Code> — MAC address assigned to the bridge (locally administered, starts with 02:)</li>
              <li><Code>qos_mappings</Code> — Maps IEEE 802.1p PCP values (0-7) to 5G QFI values, determining QoS treatment in the 5G core</li>
              <li><Code>gptp.enabled</Code> — Enables IEEE 802.1AS / gPTP time synchronization pass-through</li>
              <li><Code>gptp.time_domain_number</Code> — gPTP time domain (typically 0)</li>
            </ul>
          </SectionBody>
        </Section>

        {/* Section 4: Configure SMF */}
        <Section id="sec-smf" color={'var(--accent)'}>
          <SectionHeader>
            <StepBadge color={'var(--accent)'}>4</StepBadge>
            <SectionTitle>Step 2: Configure SMF for Ethernet PDU</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              The SMF also needs to know about the TSN Ethernet PDU session. Edit{' '}
              <Code>build/configs/open5gs/smf.yaml</Code>:
            </p>

            <CodeBlock>{
'smf:\n' +
'  session:\n' +
'    - subnet: 10.45.0.0/16\n' +
'      gateway: 10.45.0.1\n' +
'    - subnet: 2001:db8:cafe::/48\n' +
'      gateway: 2001:db8:cafe::1\n' +
'    - dnn: tsn                   # <-- Add this for Ethernet PDU\n' +
'      dev: ogstap'
            }</CodeBlock>

            <InfoBox>
              <strong>Note:</strong> When a UE requests an Ethernet PDU session with DNN="tsn", the SMF instructs the UPF
              to establish a GTP-U tunnel that carries raw Ethernet frames (not IP packets). The UPF delivers these
              frames to/from the TAP device.
            </InfoBox>

            <p><strong>Subscriber Configuration:</strong></p>
            <p>
              Make sure to add a subscriber in the WebUI (Subscriber page) with:
            </p>
            <ul>
              <li><strong>DNN:</strong> tsn</li>
              <li><strong>PDU Session Type:</strong> Ethernet (not IPv4)</li>
              <li><strong>S-NSSAI:</strong> SST=1 (or your configured slice)</li>
            </ul>
          </SectionBody>
        </Section>

        {/* Section 5: Start Core Network */}
        <Section id="sec-start" color={oc.blue[5]}>
          <SectionHeader>
            <StepBadge color={oc.blue[5]}>5</StepBadge>
            <SectionTitle>Step 3: Start the Core Network</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              Start all required NFs in order. The NRF must start first (service discovery),
              followed by the SCP, then all other NFs in any order.
            </p>

            <CodeBlock>{
'# Terminal 1: Start NRF (must be first)\n' +
'./build/src/nrf/open5gs-nrfd -c build/configs/open5gs/nrf.yaml\n' +
'\n' +
'# Terminal 2: Start SCP\n' +
'./build/src/scp/open5gs-scpd -c build/configs/open5gs/scp.yaml\n' +
'\n' +
'# Terminal 3-11: Start remaining NFs (any order)\n' +
'./build/src/amf/open5gs-amfd -c build/configs/open5gs/amf.yaml\n' +
'./build/src/smf/open5gs-smfd -c build/configs/open5gs/smf.yaml\n' +
'./build/src/upf/open5gs-upfd -c build/configs/open5gs/upf.yaml\n' +
'./build/src/udm/open5gs-udmd -c build/configs/open5gs/udm.yaml\n' +
'./build/src/udr/open5gs-udrd -c build/configs/open5gs/udr.yaml\n' +
'./build/src/ausf/open5gs-ausfd -c build/configs/open5gs/ausf.yaml\n' +
'./build/src/pcf/open5gs-pcfd -c build/configs/open5gs/pcf.yaml\n' +
'./build/src/nssf/open5gs-nssfd -c build/configs/open5gs/nssf.yaml\n' +
'./build/src/bsf/open5gs-bsfd -c build/configs/open5gs/bsf.yaml\n' +
'\n' +
'# Terminal 12: Start TSN-AF (needs CAP_NET_ADMIN)\n' +
'sudo ./build/src/tsn-af/open5gs-tsn-afd -c build/configs/open5gs/tsn-af.yaml'
            }</CodeBlock>

            <InfoBox>
              <strong>Tip:</strong> You can use the <Code>-l logfile.log</Code> flag to redirect logs to a file
              and run each NF in the background. For example:{' '}
              <Code>{'./build/src/nrf/open5gs-nrfd -c build/configs/open5gs/nrf.yaml -l build/logs/nrf.log &'}</Code>
            </InfoBox>

            <p><strong>Verify all services are running:</strong></p>
            <CodeBlock>{
'# Check that all NFs are running\n' +
'ps aux | grep open5gs\n' +
'\n' +
'# Verify UPF metrics endpoint\n' +
'curl http://127.0.0.7:9090/tsn-info\n' +
'\n' +
'# Verify TSN-AF is reachable\n' +
'curl --http2-prior-knowledge http://127.0.0.30:7777/tsn-af/v1/bridges\n' +
'\n' +
'# Verify AMF metrics\n' +
'curl http://127.0.0.5:9090/ue-info'
            }</CodeBlock>
          </SectionBody>
        </Section>

        {/* Section 6: Create Bridge */}
        <Section id="sec-bridge" color={oc.green[5]}>
          <SectionHeader>
            <StepBadge color={oc.green[5]}>6</StepBadge>
            <SectionTitle>Step 4: Create a TSN Bridge</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              A TSN bridge represents the 5GS virtual bridge. Creating a bridge in the TSN-AF will:
            </p>
            <ol>
              <li>Create a Linux kernel bridge (e.g., <Code>tsn-br-mybridge</Code>)</li>
              <li>Create a TAP device (e.g., <Code>tsn-tap-mybridge</Code>) and attach it to the bridge</li>
              <li>Attach the UPF's TAP device (<Code>ogstap</Code>) to the bridge</li>
              <li>Attach the physical NIC (e.g., <Code>eth0</Code>) to the bridge</li>
              <li>Bring all interfaces up</li>
            </ol>

            <p><strong>Using the WebUI:</strong></p>
            <p>
              Navigate to the <strong>TSN</strong> page in the sidebar, click the <strong>+</strong> button,
              and fill in:
            </p>
            <ul>
              <li><strong>Bridge ID:</strong> A unique identifier (e.g., "bridge-1")</li>
              <li><strong>Bridge MAC:</strong> MAC address for the bridge (e.g., "02:00:00:00:00:01")</li>
              <li><strong>DNN:</strong> "tsn" (must match UPF/SMF config)</li>
              <li><strong>Physical Interface:</strong> The Ethernet NIC connected to the TSN network (e.g., "eth0")</li>
              <li><strong>UPF TAP Device:</strong> "ogstap" (must match UPF config)</li>
            </ul>

            <p><strong>Using curl (API):</strong></p>
            <CodeBlock>{
'curl -X POST http://localhost:9999/api/tsn/Bridge \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "Authorization: Bearer <your-jwt-token>" \\\n' +
'  -d \'{\n' +
'    "bridgeId": "bridge-1",\n' +
'    "bridgeMac": "02:00:00:00:00:01",\n' +
'    "dnn": "tsn",\n' +
'    "physicalInterface": "eth0",\n' +
'    "upfTapDevice": "ogstap"\n' +
'  }\''
            }</CodeBlock>

            <p><strong>Verify the bridge was created:</strong></p>
            <CodeBlock>{
'# Check Linux bridge\n' +
'brctl show\n' +
'\n' +
'# Expected output:\n' +
'# bridge name       bridge id          STP enabled   interfaces\n' +
'# tsn-br-bridge-1   8000.020000000001  no            eth0\n' +
'#                                                     ogstap\n' +
'#                                                     tsn-tap-bridge-1\n' +
'\n' +
'# Check interface status\n' +
'ip link show tsn-br-bridge-1'
            }</CodeBlock>

            <InfoBox warn>
              <strong>Warning:</strong> If bridge creation fails with "ioctl(SIOCBRADDBR) failed",
              the TSN-AF does not have CAP_NET_ADMIN. Restart it with <Code>sudo</Code>.
            </InfoBox>
          </SectionBody>
        </Section>

        {/* Section 7: Add Ports */}
        <Section id="sec-ports" color={oc.green[5]}>
          <SectionHeader>
            <StepBadge color={oc.green[5]}>7</StepBadge>
            <SectionTitle>Step 5: Add Ports to the Bridge</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              Per <strong>3GPP TS 23.501</strong>, the 5GS TSN bridge has two ports per Ethernet PDU session:
            </p>
            <ul>
              <li><strong>Port 1 (NW-TT)</strong> — The network-side port at the UPF. This is where frames
                enter/exit the 5G core from the external TSN network.</li>
              <li><strong>Port 2 (DS-TT)</strong> — The device-side port at the UE. This represents the
                UE's bridge port facing the TSN end station.</li>
            </ul>

            <DiagramBox>{
'  TSN End Station 1 ◄──► [DS-TT Port 2] ◄──5G──► [NW-TT Port 1] ◄──► TSN End Station 2\n' +
'                          (UE side)                 (UPF side)'
            }</DiagramBox>

            <p><strong>Add NW-TT Port (Port 1) using the WebUI:</strong></p>
            <p>
              In the TSN page, click on your bridge, then click "Add Port":
            </p>
            <ul>
              <li><strong>Port Number:</strong> 1</li>
              <li><strong>Network-side TT (NW-TT):</strong> Checked (enabled)</li>
              <li><strong>MAC Address:</strong> (optional) e.g., "aa:bb:cc:dd:ee:01"</li>
            </ul>

            <p><strong>Add DS-TT Port (Port 2):</strong></p>
            <ul>
              <li><strong>Port Number:</strong> 2</li>
              <li><strong>Network-side TT (NW-TT):</strong> Unchecked (this is DS-TT)</li>
              <li><strong>MAC Address:</strong> (optional) e.g., "aa:bb:cc:dd:ee:02"</li>
            </ul>

            <p><strong>Using curl:</strong></p>
            <CodeBlock>{
'# Add NW-TT port\n' +
'curl -X POST http://localhost:9999/api/tsn/Bridge/bridge-1/Port \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "Authorization: Bearer <token>" \\\n' +
'  -d \'{"portNumber": 1, "isNwtt": true, "macAddr": "aa:bb:cc:dd:ee:01"}\'\n' +
'\n' +
'# Add DS-TT port\n' +
'curl -X POST http://localhost:9999/api/tsn/Bridge/bridge-1/Port \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "Authorization: Bearer <token>" \\\n' +
'  -d \'{"portNumber": 2, "isNwtt": false, "macAddr": "aa:bb:cc:dd:ee:02"}\''
            }</CodeBlock>

            <InfoBox>
              <strong>Note:</strong> Ports are currently logical management entities. In a fully automated deployment,
              ports would be auto-created when a UE establishes an Ethernet PDU session. For now, they are
              created manually to set up the TSN management context.
            </InfoBox>

            <InfoBox warn>
              <strong>409 Conflict:</strong> If you get a 409 error when adding a port, it means a port with
              that number already exists on this bridge. Each port number must be unique within a bridge.
            </InfoBox>
          </SectionBody>
        </Section>

        {/* Section 8: QoS Mapping */}
        <Section id="sec-qos" color={oc.violet[5]}>
          <SectionHeader>
            <StepBadge color={oc.violet[5]}>8</StepBadge>
            <SectionTitle>Step 6: Configure QoS Mapping</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              QoS mapping translates between IEEE 802.1p PCP (Priority Code Point) values used in TSN
              and 5G QFI (QoS Flow Identifier) / 5QI values used in the 5G core. This ensures that
              TSN traffic classes are preserved across the 5G system.
            </p>

            <p><strong>Standard PCP-to-5QI Mapping:</strong></p>
            <ApiTable>
              <thead>
                <tr><th>PCP</th><th>Traffic Class</th><th>Suggested 5QI</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>7</td><td>Network Control</td><td>86</td><td>Highest priority, network management</td></tr>
                <tr><td>6</td><td>Voice</td><td>85</td><td>Low-latency voice traffic</td></tr>
                <tr><td>5</td><td>Video</td><td>84</td><td>Video and time-sensitive streams</td></tr>
                <tr><td>4</td><td>Controlled Load</td><td>83</td><td>Industrial automation control</td></tr>
                <tr><td>3</td><td>Excellent Effort</td><td>82</td><td>Important business traffic</td></tr>
                <tr><td>2</td><td>Spare</td><td>81</td><td>General purpose</td></tr>
                <tr><td>1</td><td>Background</td><td>80</td><td>Low-priority background</td></tr>
                <tr><td>0</td><td>Best Effort</td><td>9</td><td>Default (standard 5QI 9)</td></tr>
              </tbody>
            </ApiTable>

            <p><strong>Configure via API:</strong></p>
            <CodeBlock>{
'curl -X POST http://localhost:9999/api/tsn/Bridge/bridge-1/qos-mapping \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "Authorization: Bearer <token>" \\\n' +
'  -d \'{\n' +
'    "mappings": [\n' +
'      {"pcp": 7, "5qi": 86},\n' +
'      {"pcp": 6, "5qi": 85},\n' +
'      {"pcp": 5, "5qi": 84},\n' +
'      {"pcp": 4, "5qi": 83},\n' +
'      {"pcp": 0, "5qi": 9}\n' +
'    ]\n' +
'  }\''
            }</CodeBlock>

            <InfoBox>
              <strong>How it works:</strong> When a VLAN-tagged Ethernet frame arrives at the NW-TT with PCP=5,
              the UPF maps it to QFI=84 for transport through the 5G core. On the other end, the DS-TT
              restores the original PCP value. This preserves TSN priority end-to-end.
            </InfoBox>
          </SectionBody>
        </Section>

        {/* Section 9: TSC Assistance */}
        <Section id="sec-tsc" color={oc.violet[5]}>
          <SectionHeader>
            <StepBadge color={oc.violet[5]}>9</StepBadge>
            <SectionTitle>Step 7: Configure TSC Assistance (Optional)</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              TSC (Time-Sensitive Communication) Assistance provides the 5G core with information about
              the expected traffic pattern, enabling it to allocate radio resources more efficiently
              for deterministic latency.
            </p>

            <p><strong>Parameters:</strong></p>
            <ul>
              <li><Code>burstArrivalTimeNs</Code> — Expected arrival time window for frame bursts (nanoseconds)</li>
              <li><Code>periodicityUs</Code> — Expected periodicity of traffic (microseconds).
                For example, a 1ms control loop would be 1000.</li>
              <li><Code>survivalTimeUs</Code> — Maximum acceptable end-to-end latency (microseconds).
                Frames exceeding this are considered lost.</li>
            </ul>

            <CodeBlock>{
'curl -X POST http://localhost:9999/api/tsn/Bridge/bridge-1/tsc-assistance \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -H "Authorization: Bearer <token>" \\\n' +
'  -d \'{\n' +
'    "burstArrivalTimeNs": 1000000,\n' +
'    "periodicityUs": 10000,\n' +
'    "survivalTimeUs": 5000\n' +
'  }\''
            }</CodeBlock>

            <InfoBox>
              <strong>When to use:</strong> TSC Assistance is most useful for cyclic industrial automation
              traffic (PLC control loops, sensor polling) where the traffic pattern is predictable.
              For best-effort TSN traffic, this step can be skipped.
            </InfoBox>
          </SectionBody>
        </Section>

        {/* Section 10: Connect UE */}
        <Section id="sec-ue" color={oc.cyan[5]}>
          <SectionHeader>
            <StepBadge color={oc.cyan[5]}>10</StepBadge>
            <SectionTitle>Step 8: Connect UE with Ethernet PDU Session</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              For end-to-end TSN operation, a 5G UE must register with the core network and establish
              an <strong>Ethernet-type PDU session</strong> with DNN="tsn".
            </p>

            <p><strong>UE Configuration Requirements:</strong></p>
            <ul>
              <li><strong>DNN:</strong> "tsn"</li>
              <li><strong>PDU Session Type:</strong> Ethernet (not IPv4 or IPv6)</li>
              <li><strong>S-NSSAI:</strong> SST=1 (or matching your network slice config)</li>
            </ul>

            <p><strong>With UERANSIM (Simulated UE/gNB):</strong></p>
            <CodeBlock>{
'# ueransim-gnb.yaml - gNB configuration\n' +
'linkIp: 127.0.0.1\n' +
'ngapIp: 127.0.0.1\n' +
'gtpIp: 127.0.0.1\n' +
'amfConfigs:\n' +
'  - address: 127.0.0.5\n' +
'    port: 38412\n' +
'\n' +
'# ueransim-ue.yaml - UE configuration\n' +
'sessions:\n' +
'  - type: "Ethernet"        # <-- Ethernet PDU session type\n' +
'    apn: "tsn"              # <-- DNN matching the TSN config\n' +
'    slice:\n' +
'      sst: 1'
            }</CodeBlock>

            <p><strong>With a Real gNB/UE:</strong></p>
            <ol>
              <li>Configure the gNB to connect to AMF at 127.0.0.5:38412 (SCTP)</li>
              <li>Configure the UE's APN/DNN as "tsn" with Ethernet PDU session type</li>
              <li>Power on the UE and wait for registration</li>
              <li>The UE should establish an Ethernet PDU session automatically</li>
            </ol>

            <p><strong>Verify UE Registration:</strong></p>
            <CodeBlock>{
'# Check connected UEs via AMF\n' +
'curl http://127.0.0.5:9090/ue-info\n' +
'\n' +
'# Check PDU sessions via SMF\n' +
'curl http://127.0.0.4:9090/pdu-info\n' +
'\n' +
'# Check connected gNBs\n' +
'curl http://127.0.0.5:9090/gnb-info'
            }</CodeBlock>

            <InfoBox>
              <strong>What happens during PDU session establishment:</strong>
              The SMF creates a GTP-U tunnel between the gNB and UPF for Ethernet frame transport.
              The UPF activates the NW-TT port for this session, and frames can now flow between
              the UE (DS-TT) and the physical NIC via the Linux bridge.
            </InfoBox>
          </SectionBody>
        </Section>

        {/* Section 11: Test Bridge */}
        <Section id="sec-test" color={oc.lime[6]}>
          <SectionHeader>
            <StepBadge color={oc.lime[6]}>11</StepBadge>
            <SectionTitle>Step 9: Test Bridge with Traffic</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              You can test the Linux bridge independently (without a real UE) using the included
              test script with veth pairs.
            </p>

            <InfoBox warn>
              <strong>Important:</strong> This tests the Linux bridge data path only. Traffic counters
              in the NW-TT Performance dashboard will only increment with actual GTP-U traffic from a
              real UE, because the UPF NW-TT processes frames inside the GTP tunnel, not on the bridge.
            </InfoBox>

            <p><strong>Install Scapy:</strong></p>
            <CodeBlock>{
'# Create a virtual environment\n' +
'python3 -m venv .venv\n' +
'source .venv/bin/activate\n' +
'pip install scapy'
            }</CodeBlock>

            <p><strong>Run the test script:</strong></p>
            <CodeBlock>{
'sudo .venv/bin/python3 tools/test-bridge.py'
            }</CodeBlock>

            <p><strong>What the test does:</strong></p>
            <ol>
              <li>Creates two veth pairs and attaches them to the TSN bridge</li>
              <li>Sets <Code>group_fwd_mask=16384</Code> to enable gPTP/LLDP forwarding</li>
              <li>Runs 9 tests: Basic Ethernet, Broadcast, VLAN/PCP, ARP, UDP Stream (50 frames),
                gPTP (EtherType 0x88F7), LLDP (EtherType 0x88CC), Bidirectional, High-Rate Burst</li>
              <li>Cleans up veth pairs when done</li>
            </ol>

            <p><strong>Expected results:</strong></p>
            <CodeBlock>{
'Test 1: Basic Ethernet Frame Forwarding      [PASS]\n' +
'Test 2: Broadcast Frame Flooding             [PASS]\n' +
'Test 3: VLAN-Tagged Frames (PCP 0,3,5,7)     [FAIL] *\n' +
'Test 4: ARP Resolution                       [FAIL] *\n' +
'Test 5: UDP Traffic Stream (50 frames)       [PASS]\n' +
'Test 6: gPTP Frame (EtherType 0x88F7)        [PASS]\n' +
'Test 7: LLDP Frame (EtherType 0x88CC)        [PASS]\n' +
'Test 8: Bidirectional Traffic                [PASS]\n' +
'Test 9: High-Rate Burst (500 frames)         [FAIL] *\n' +
'\n' +
'* VLAN fails because bridge VLAN filtering is not configured\n' +
'* ARP fails because kernel processes ARP on bridged veths\n' +
'* Burst may fail due to scapy Python send speed limitations'
            }</CodeBlock>

            <p><strong>Manual bridge testing with ping:</strong></p>
            <CodeBlock>{
'# Create veth pairs manually\n' +
'sudo ip link add veth-src type veth peer name veth-src-br\n' +
'sudo ip link add veth-dst type veth peer name veth-dst-br\n' +
'\n' +
'# Attach to bridge\n' +
'sudo brctl addif tsn-br-bridge-1 veth-src-br\n' +
'sudo brctl addif tsn-br-bridge-1 veth-dst-br\n' +
'\n' +
'# Assign IPs and bring up\n' +
'sudo ip addr add 10.100.0.1/24 dev veth-src\n' +
'sudo ip addr add 10.100.0.2/24 dev veth-dst\n' +
'sudo ip link set veth-src up && sudo ip link set veth-src-br up\n' +
'sudo ip link set veth-dst up && sudo ip link set veth-dst-br up\n' +
'\n' +
'# Test connectivity\n' +
'ping -c 3 -I veth-src 10.100.0.2\n' +
'\n' +
'# Clean up when done\n' +
'sudo ip link del veth-src\n' +
'sudo ip link del veth-dst'
            }</CodeBlock>
          </SectionBody>
        </Section>

        {/* Section 12: Monitor */}
        <Section id="sec-monitor" color={oc.blue[5]}>
          <SectionHeader>
            <StepBadge color={oc.blue[5]}>12</StepBadge>
            <SectionTitle>Step 10: Monitor in WebUI Dashboards</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              The WebUI provides several dashboards for monitoring the TSN integration:
            </p>

            <Divider />

            <p><strong>TSN Page (Sidebar: "TSN")</strong></p>
            <p>
              CRUD interface for managing TSN bridges and ports. Create, edit, delete bridges
              and their ports. View bridge configuration details including Linux bridge name,
              TAP device, physical interface, and attached ports.
            </p>

            <Divider />

            <p><strong>TSN Analytics (Sidebar: "TSN Analytics")</strong></p>
            <p>
              Comprehensive analytics from the TSN-AF including:
            </p>
            <ul>
              <li>Bridge configuration summary (ID, MAC, DNN, PCF session status)</li>
              <li>Port details (NW-TT/DS-TT, MAC, management containers)</li>
              <li>QoS mappings (PCP → 5QI configured values)</li>
              <li>TSC Assistance parameters (burst arrival, periodicity, survival time)</li>
              <li>Time synchronization subscription status</li>
            </ul>

            <Divider />

            <p><strong>NW-TT Performance (Sidebar: "NW-TT Perf")</strong></p>
            <p>
              Live per-port metrics from the UPF NW-TT, auto-refreshing every 2 seconds:
            </p>
            <ul>
              <li><strong>Throughput:</strong> RX/TX frame and byte counts, gPTP frames, LLDP frames</li>
              <li><strong>Residence Time:</strong> Min/avg/max propagation delay with histogram</li>
              <li><strong>Jitter:</strong> Current and peak inter-arrival variation</li>
              <li><strong>PCP Statistics:</strong> Per-priority-class frame counts (8 classes)</li>
              <li><strong>PSFP:</strong> Per-stream filtering pass/drop counters with pass rate</li>
              <li><strong>De-jitter Queue:</strong> Buffer depth, target delay, peak depth</li>
              <li><strong>Stream Filters:</strong> Active filter rules with match/miss counts</li>
            </ul>

            <InfoBox>
              <strong>Note:</strong> NW-TT Performance counters only increment when frames flow through
              the UPF's GTP-U data path (from a real UE with an active Ethernet PDU session).
              Bridge-level traffic (veth tests) does not pass through the NW-TT.
            </InfoBox>

            <Divider />

            <p><strong>TSN Topology (Sidebar: "TSN Topology")</strong></p>
            <p>
              Visual network topology diagram showing:
            </p>
            <ul>
              <li>TSN End Stations, DS-TT (UE), gNodeB, and 5GS TSN Bridge nodes</li>
              <li>Connection arrows with protocol labels (Ethernet, 5G NR, N3 GTP-U, 802.1Q)</li>
              <li>Live status indicators (green = connected, red = down, gray = unknown)</li>
              <li>Detail cards for bridge config, NW-TT data plane, and gPTP status</li>
            </ul>

            <Divider />

            <p><strong>TSN Sessions (Sidebar: "TSN Sessions")</strong></p>
            <p>
              Active Ethernet PDU session monitor showing one row per NW-TT port:
            </p>
            <ul>
              <li>Session summary bar (active count, total frames, bytes, average jitter)</li>
              <li>Per-session table with MAC, RX/TX frames, residence time, jitter, PSFP rate</li>
              <li>Expandable detail view with full per-port metrics</li>
            </ul>

            <Divider />

            <p><strong>UE Analytics (Sidebar: "UE Analytics")</strong></p>
            <p>
              Connected UE and gNB monitor:
            </p>
            <ul>
              <li>Summary cards: connected UEs, idle UEs, active gNBs, PDU session count</li>
              <li>gNB table with ID, PLMN, SCTP peer, connected UE count</li>
              <li>UE table with SUPI, CM state, gNB, PDU sessions, slice, AMBR</li>
              <li>Expandable UE detail: identity, radio info, security, AMBR, PDU session details with IP/QoS/N3 tunnel info</li>
            </ul>
          </SectionBody>
        </Section>

        {/* Section 13: API Reference */}
        <Section id="sec-api" color={'var(--text-secondary)'}>
          <SectionHeader>
            <StepBadge color={'var(--text-secondary)'}>13</StepBadge>
            <SectionTitle>API Reference</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p><strong>TSN-AF Management API</strong> (via WebUI proxy at <Code>http://localhost:9999/api/tsn/</Code>):</p>

            <ApiTable>
              <thead>
                <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>GET</td><td>/api/tsn/Bridge</td><td>List all bridges</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge</td><td>Create a bridge</td></tr>
                <tr><td>GET</td><td>/api/tsn/Bridge/:id</td><td>Get bridge details</td></tr>
                <tr><td>PUT</td><td>/api/tsn/Bridge/:id</td><td>Update bridge</td></tr>
                <tr><td>DELETE</td><td>/api/tsn/Bridge/:id</td><td>Delete bridge</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/Port</td><td>Add port to bridge</td></tr>
                <tr><td>GET</td><td>/api/tsn/Bridge/:id/Port/:pid</td><td>Get port details</td></tr>
                <tr><td>DELETE</td><td>/api/tsn/Bridge/:id/Port/:pid</td><td>Delete port</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/Port/:pid/configure</td><td>Configure port (static filters)</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/qos-mapping</td><td>Set PCP-to-5QI mapping</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/tsc-assistance</td><td>Configure TSC assistance</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/stream-reservations</td><td>Create stream reservation</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/Port/:pid/gcl</td><td>Configure Gate Control List</td></tr>
                <tr><td>POST</td><td>/api/tsn/Bridge/:id/Port/:pid/psfp</td><td>Configure PSFP rules</td></tr>
                <tr><td>GET</td><td>/api/tsn/Analytics</td><td>Get TSN analytics summary</td></tr>
                <tr><td>GET</td><td>/api/tsn/Interface</td><td>List network interfaces</td></tr>
              </tbody>
            </ApiTable>

            <Divider />

            <p><strong>UPF Metrics API</strong> (direct at <Code>http://127.0.0.7:9090/</Code>):</p>
            <ApiTable>
              <thead>
                <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>GET</td><td>/tsn-info</td><td>NW-TT bridge and port analytics (JSON)</td></tr>
              </tbody>
            </ApiTable>

            <Divider />

            <p><strong>AMF/SMF Metrics API</strong>:</p>
            <ApiTable>
              <thead>
                <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>GET</td><td>http://127.0.0.5:9090/ue-info</td><td>Connected UE information</td></tr>
                <tr><td>GET</td><td>http://127.0.0.5:9090/gnb-info</td><td>Connected gNB information</td></tr>
                <tr><td>GET</td><td>http://127.0.0.4:9090/pdu-info</td><td>Active PDU session details</td></tr>
              </tbody>
            </ApiTable>
          </SectionBody>
        </Section>

        {/* Section 14: Troubleshooting */}
        <Section id="sec-trouble" color={oc.red[5]}>
          <SectionHeader>
            <StepBadge color={oc.red[5]}>14</StepBadge>
            <SectionTitle>Troubleshooting</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p><strong>Bridge creation fails: "ioctl(SIOCBRADDBR) failed"</strong></p>
            <ul>
              <li><strong>Cause:</strong> TSN-AF does not have CAP_NET_ADMIN privilege</li>
              <li><strong>Fix:</strong> Run TSN-AF with <Code>sudo</Code> or set <Code>sudo setcap cap_net_admin+ep ./build/src/tsn-af/open5gs-tsn-afd</Code></li>
            </ul>

            <Divider />

            <p><strong>409 Conflict when adding a port</strong></p>
            <ul>
              <li><strong>Cause:</strong> A port with that number already exists on the bridge</li>
              <li><strong>Fix:</strong> Use a different port number, or delete the existing port first</li>
            </ul>

            <Divider />

            <p><strong>502 Bad Gateway on TSN API calls</strong></p>
            <ul>
              <li><strong>Cause:</strong> TSN-AF is not running or not reachable at 127.0.0.30:7777</li>
              <li><strong>Fix:</strong> Verify TSN-AF is running: <Code>ps aux | grep tsn-af</Code></li>
              <li>Check if the correct instance is running (kill duplicates if needed)</li>
            </ul>

            <Divider />

            <p><strong>Bridge disappears after TSN-AF restart</strong></p>
            <ul>
              <li><strong>Cause:</strong> Bridge state is stored in-memory only; it is lost when TSN-AF restarts</li>
              <li><strong>Fix:</strong> Recreate the bridge after restart. This is by design for the current implementation.</li>
            </ul>

            <Divider />

            <p><strong>NW-TT Performance dashboard shows no data</strong></p>
            <ul>
              <li><strong>Cause:</strong> No active Ethernet PDU sessions. The NW-TT processes frames only when
                they flow through the GTP-U tunnel from a real UE.</li>
              <li><strong>Fix:</strong> Connect a UE with an Ethernet PDU session (DNN=tsn). Traffic through
                the Linux bridge alone (veth tests) does not pass through the NW-TT data path.</li>
            </ul>

            <Divider />

            <p><strong>SMF crashes at startup: "fd_conf_parse: Unable to open configuration file"</strong></p>
            <ul>
              <li><strong>Cause:</strong> freeDiameter config file not found (only needed for 4G Diameter)</li>
              <li><strong>Fix:</strong> Comment out the <Code>freeDiameter:</Code> line in smf.yaml if you only need 5G</li>
            </ul>

            <Divider />

            <p><strong>gPTP/LLDP frames not crossing the bridge</strong></p>
            <ul>
              <li><strong>Cause:</strong> Linux bridges drop IEEE reserved multicast by default</li>
              <li><strong>Fix:</strong> Set the group forwarding mask:{' '}
                <Code>echo 16384 {'>'} /sys/class/net/tsn-br-xxx/bridge/group_fwd_mask</Code></li>
            </ul>

            <Divider />

            <p><strong>UPF /tsn-info returns empty ports array</strong></p>
            <ul>
              <li><strong>Cause:</strong> NW-TT is enabled in config but no Ethernet PDU sessions are active</li>
              <li><strong>Fix:</strong> This is expected. Ports appear in /tsn-info only when a UE has an active
                Ethernet PDU session. The UPF creates an NW-TT port per session.</li>
            </ul>

            <Divider />

            <p><strong>Checking logs:</strong></p>
            <CodeBlock>{
'# TSN-AF logs\n' +
'tail -f build/logs/tsn-af.log\n' +
'\n' +
'# UPF logs (watch for NW-TT messages)\n' +
'tail -f build/logs/upf.log\n' +
'\n' +
'# SMF logs (watch for PDU session establishment)\n' +
'tail -f build/logs/smf.log\n' +
'\n' +
'# AMF logs (watch for UE registration)\n' +
'tail -f build/logs/amf.log'
            }</CodeBlock>
          </SectionBody>
        </Section>

        {/* Section 15: NW-TT YAML Configuration Reference */}
        <Section id="sec-nwtt-config" color={oc.violet[5]}>
          <SectionHeader>
            <StepBadge color={oc.violet[5]}>15</StepBadge>
            <SectionTitle>NW-TT YAML Configuration Reference</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              The NW-TT (Network-side Translation Termination) bridge is configured in the UPF YAML
              configuration file under the <Code>nwtt:</Code> block inside the <Code>upf:</Code> section.
            </p>

            <ApiTable>
              <thead>
                <tr><th>Key</th><th>Type</th><th>Default</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td><Code>enabled</Code></td><td>bool</td><td>false</td><td>Enable the NW-TT bridge in the UPF</td></tr>
                <tr><td><Code>bridge_id</Code></td><td>uint32</td><td>1</td><td>Numeric bridge identifier</td></tr>
                <tr><td><Code>bridge_mac</Code></td><td>string</td><td>-</td><td>MAC address of the bridge (e.g. &quot;02:00:00:00:00:01&quot;)</td></tr>
                <tr><td><Code>qos_mappings</Code></td><td>array</td><td>[]</td><td>Array of PCP-to-QFI mappings (see below)</td></tr>
                <tr><td><Code>gptp</Code></td><td>object</td><td>-</td><td>gPTP / IEEE 802.1AS configuration block</td></tr>
              </tbody>
            </ApiTable>

            <p><strong>QoS Mappings</strong> — Each entry maps an IEEE 802.1Q PCP (Priority Code Point) value to a 5G QoS Flow Identifier:</p>
            <ApiTable>
              <thead>
                <tr><th>Key</th><th>Type</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td><Code>pcp</Code></td><td>0-7</td><td>802.1Q priority (7 = highest)</td></tr>
                <tr><td><Code>qfi</Code></td><td>1-255</td><td>5G QoS Flow Identifier</td></tr>
              </tbody>
            </ApiTable>

            <p><strong>Complete example:</strong></p>
            <CodeBlock>{
'upf:\n' +
'  nwtt:\n' +
'    enabled: true\n' +
'    bridge_id: 1\n' +
'    bridge_mac: "02:00:00:00:00:01"\n' +
'    qos_mappings:\n' +
'      - pcp: 7        # Network Control\n' +
'        qfi: 86       # Maps to 5QI 86 (TSN)\n' +
'      - pcp: 6        # Internetwork Control\n' +
'        qfi: 85\n' +
'      - pcp: 5        # Voice\n' +
'        qfi: 84\n' +
'    gptp:\n' +
'      enabled: true\n' +
'      time_domain_number: 0\n' +
'      degrade_on_unsync: true\n' +
'      monitoring:\n' +
'        enabled: true\n' +
'        transport_specific: 1'
            }</CodeBlock>
          </SectionBody>
        </Section>

        {/* Section 16: gPTP Configuration & Profiles */}
        <Section id="sec-gptp-config" color={oc.blue[5]}>
          <SectionHeader>
            <StepBadge color={oc.blue[5]}>16</StepBadge>
            <SectionTitle>gPTP Configuration &amp; Profiles</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              The 5GS TSN bridge acts as a <strong>transparent clock</strong> per IEEE 802.1AS.
              It adds residence time to the <Code>correctionField</Code> of PTP event messages
              (Sync, PDelay_Req, PDelay_Resp) as they traverse the bridge.
            </p>

            <ApiTable>
              <thead>
                <tr><th>Key</th><th>Type</th><th>Default</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td><Code>gptp.enabled</Code></td><td>bool</td><td>false</td><td>Enable gPTP frame detection and residence time correction</td></tr>
                <tr><td><Code>gptp.time_domain_number</Code></td><td>0-127</td><td>0</td><td>PTP domain number</td></tr>
                <tr><td><Code>gptp.degrade_on_unsync</Code></td><td>bool</td><td>false</td><td>Skip residence time correction when gPTP is not synchronized</td></tr>
                <tr><td><Code>gptp.monitoring.enabled</Code></td><td>bool</td><td>false</td><td>Enable periodic polling of ptp4l via the <Code>pmc</Code> tool</td></tr>
                <tr><td><Code>gptp.monitoring.transport_specific</Code></td><td>0 or 1</td><td>0</td><td>PTP transportSpecific field (1 for 802.1AS/gPTP, 0 for 1588v2)</td></tr>
              </tbody>
            </ApiTable>

            <p><strong>PTP Profiles</strong></p>
            <ul>
              <li><strong>IEEE 802.1AS (gPTP):</strong> Uses <Code>transport_specific: 1</Code>, Layer 2 transport,
                peer-to-peer delay mechanism. This is the standard profile for TSN industrial networks.</li>
              <li><strong>IEEE 1588v2:</strong> Uses <Code>transport_specific: 0</Code>, can use UDP/IP transport,
                supports both end-to-end and peer-to-peer delay mechanisms.</li>
            </ul>

            <p><strong>Prerequisites:</strong> The <Code>pmc</Code> command (from linuxptp package) must be in PATH for monitoring to work.
              The UPF polls ptp4l every 10 seconds using:</p>
            <CodeBlock>{
'pmc -u -b 0 -t <transport_specific> \'GET CURRENT_DATA_SET\'\n' +
'pmc -u -b 0 -t <transport_specific> \'GET PARENT_DATA_SET\''
            }</CodeBlock>

            <InfoBox>
              <strong>degrade_on_unsync:</strong> When enabled and gPTP sync is lost, the UPF will skip adding
              residence time to PTP event messages rather than propagating potentially inaccurate correction values.
              A warning is logged when sync state transitions. The number of skipped corrections is tracked and
              visible in the NW-TT Performance dashboard.
            </InfoBox>

            <p><strong>Manual status check:</strong></p>
            <CodeBlock>{
'# Check if ptp4l is providing valid data\n' +
'pmc -u -b 0 -t 1 \'GET CURRENT_DATA_SET\'\n' +
'# Look for offsetFromMaster and meanPathDelay values\n' +
'\n' +
'# Check GM identity\n' +
'pmc -u -b 0 -t 1 \'GET PARENT_DATA_SET\'\n' +
'# Look for grandmasterIdentity'
            }</CodeBlock>
          </SectionBody>
        </Section>

        {/* Section 17: LLDP Settings */}
        <Section id="sec-lldp-config" color={'var(--accent)'}>
          <SectionHeader>
            <StepBadge color={'var(--accent)'}>17</StepBadge>
            <SectionTitle>LLDP Settings</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              Link Layer Discovery Protocol (LLDP) is <strong>automatically enabled</strong> when the NW-TT bridge
              is active. There is no separate configuration key. The UPF transmits LLDP frames every
              30 seconds on each bridge port and processes incoming LLDP frames from neighbors.
            </p>

            <p><strong>LLDP Frames Transmitted:</strong></p>
            <ul>
              <li><strong>Chassis ID:</strong> Bridge MAC address</li>
              <li><strong>Port ID:</strong> Per-port MAC address</li>
              <li><strong>TTL:</strong> 120 seconds</li>
              <li><strong>System Name:</strong> &quot;AMRC-NW-TT&quot;</li>
              <li><strong>System Description:</strong> &quot;5GS TSN Bridge (NW-TT)&quot;</li>
              <li><strong>Port Description:</strong> &quot;NW-TT Port N&quot;</li>
            </ul>

            <p><strong>Neighbor Discovery:</strong> Incoming LLDP frames from connected TSN devices
              are parsed and stored per-port. Discovered neighbors are visible in the NW-TT Performance
              dashboard and the TSN Topology visualization.</p>

            <InfoBox>
              <strong>Important:</strong> If using a Linux bridge to connect the NW-TT to physical interfaces,
              you must enable LLDP frame forwarding. By default, Linux bridges drop LLDP (and other
              link-local multicast frames). Set the <Code>group_fwd_mask</Code> to allow LLDP:
            </InfoBox>
            <CodeBlock>{
'# Enable LLDP forwarding across the Linux bridge\n' +
'echo 0x4000 > /sys/class/net/<bridge-name>/bridge/group_fwd_mask\n' +
'\n' +
'# Verify\n' +
'cat /sys/class/net/<bridge-name>/bridge/group_fwd_mask\n' +
'# Should show 16384 (0x4000)'
            }</CodeBlock>

            <p><strong>Monitoring:</strong> LLDP neighbor information is shown per-port in the NW-TT
              Performance dashboard, including system name, chassis ID, port ID, TTL, and port description.</p>
          </SectionBody>
        </Section>

        {/* Section 18: PSFP / Stream Filter Configuration */}
        <Section id="sec-psfp-config" color={oc.red[5]}>
          <SectionHeader>
            <StepBadge color={oc.red[5]}>18</StepBadge>
            <SectionTitle>PSFP / Stream Filter Configuration</SectionTitle>
          </SectionHeader>
          <SectionBody>
            <p>
              Per-Stream Filtering and Policing (PSFP, IEEE 802.1Qci) allows the NW-TT bridge to filter
              Ethernet frames based on destination MAC address and VLAN ID, and to police traffic using
              a token bucket meter. Each port supports up to <strong>16 stream filters</strong>.
            </p>

            <p><strong>Stream Filter Model:</strong></p>
            <ul>
              <li><strong>Destination MAC:</strong> Exact match on the Ethernet destination address</li>
              <li><strong>VLAN ID:</strong> Optional VLAN tag match (802.1Q)</li>
              <li><strong>Match action:</strong> Frames matching any active filter are passed; non-matching frames increment the miss counter</li>
              <li><strong>If no filters are configured:</strong> All frames pass through (open policy)</li>
            </ul>

            <p><strong>PSFP Meter:</strong> A token bucket policer can be configured per port:</p>
            <ApiTable>
              <thead>
                <tr><th>Parameter</th><th>Unit</th><th>Description</th></tr>
              </thead>
              <tbody>
                <tr><td>Committed Info Rate (CIR)</td><td>bits/sec</td><td>Token replenishment rate</td></tr>
                <tr><td>Committed Burst Size (CBS)</td><td>bytes</td><td>Maximum token bucket depth</td></tr>
              </tbody>
            </ApiTable>
            <p>Frames that arrive when insufficient tokens are available are dropped.</p>

            <p><strong>Configuring via API:</strong></p>
            <CodeBlock>{
'# Set stream filters on bridge "mybridge", port 1\n' +
'curl -X POST http://localhost:9999/api/tsn/Bridge/mybridge/Port/1/psfp \\\n' +
'  -H "Content-Type: application/json" \\\n' +
'  -d \'{\n' +
'    "streamFilters": [\n' +
'      {\n' +
'        "instanceId": 0,\n' +
'        "destMac": "01:00:5e:00:01:01",\n' +
'        "vlanId": 100\n' +
'      },\n' +
'      {\n' +
'        "instanceId": 1,\n' +
'        "destMac": "33:33:00:00:00:01"\n' +
'      }\n' +
'    ]\n' +
'  }\''
            }</CodeBlock>

            <InfoBox>
              <strong>Monitoring:</strong> Per-filter match counts and byte counts are shown in the NW-TT
              Performance dashboard. The PSFP section shows passed/dropped frame counts and the pass rate.
              Use the Stream Filter Manager (Manage button) to add, edit, or remove individual filters.
            </InfoBox>
          </SectionBody>
        </Section>
      </Wrapper>
    );
  }
}

export default Guide;
