/* Rich demo data so the UI can be seen fully populated. Exposes TSN.mock + TSN.demo. */
(function (T) {
  T.demo = false; // LIVE by default — the UI shows real UE data. Toggle on only for a styled preview with sample data.

  const N = 48;
  function seed(fn) { return Array.from({ length: N }, (_, i) => fn(i)); }
  function wander(base, amp, i, period) {
    return base + Math.sin(i / (period || 6)) * amp + (Math.random() - 0.5) * amp * 0.6;
  }

  const series = {
    ul: seed((i) => Math.max(0, wander(180, 40, i, 7))),     // uplink Mbps
    dl: seed((i) => Math.max(0, wander(120, 35, i, 5))),     // downlink Mbps
    latency: seed((i) => Math.max(4, wander(8, 2.2, i, 9))), // control one-way ms
    jitter: seed((i) => Math.max(0.3, wander(1.4, 0.7, i, 4))),
    offset: seed((i) => wander(0, 55, i, 3)),                // gPTP offset ns
    rsrp: seed((i) => wander(-78, 4, i, 8)),
  };

  function push(arr, v) { arr.push(v); if (arr.length > N) arr.shift(); }

  const mac = "8e:41:22:7b:0c:19";

  const streams = [
    { role: "CONTROL", vlan: 60, pcp: 7, dscp: 46, fiveqi: 82, qfi: 2,
      rate: 5.0, p50: 8.1, p99: 16.2, jitter: 1.2, loss: 0.4, color: T.theme.control },
    { role: "HP VIDEO", vlan: 70, pcp: 4, dscp: 34, fiveqi: 3, qfi: 2,
      rate: 18.4, p50: 11.8, p99: 22.5, jitter: 3.1, loss: 1.2, color: T.theme.hpvideo },
    { role: "BE VIDEO", vlan: 80, pcp: 0, dscp: 0, fiveqi: 9, qfi: 1,
      rate: 41.2, p50: 27.9, p99: 62.0, jitter: 9.4, loss: 5.8, color: T.theme.bevideo },
    { role: "BG FLOOD", vlan: 80, pcp: 0, dscp: 0, fiveqi: 9, qfi: 1,
      rate: 486.0, p50: 44.0, p99: 120.0, jitter: 18.0, loss: 11.0, color: "#cbd2dd" },
  ];

  const topology = {
    nodes: [
      { id: "endpoint", label: "TSN Endpoint", sub: "Camera / PLC", kind: "device" },
      { id: "ue", label: "This UE", sub: "DS-TT · RM520N", kind: "ue" },
      { id: "5g", label: "5G Network", sub: "gNB + Core", kind: "cloud" },
      { id: "core", label: "NW-TT", sub: "UPF bridge", kind: "server" },
      { id: "switch", label: "TSN Switch", sub: "FS TSN3220", kind: "switch" },
    ],
    links: [
      { from: "endpoint", to: "ue", quality: 100, label: "1 GbE" },
      { from: "ue", to: "5g", quality: 96, label: "n77 · VXLAN", wireless: true },
      { from: "5g", to: "core", quality: 99, label: "N3 GTP-U" },
      { from: "core", to: "switch", quality: 100, label: "1 GbE" },
    ],
  };

  T.mock = {
    tick() {
      push(series.ul, Math.max(0, wander(180, 40, series.ul.length, 7)));
      push(series.dl, Math.max(0, wander(120, 35, series.dl.length, 5)));
      push(series.latency, Math.max(4, wander(8, 2.2, series.latency.length, 9)));
      push(series.jitter, Math.max(0.3, wander(1.4, 0.7, series.jitter.length, 4)));
      push(series.offset, wander(0, 55, series.offset.length, 3));
      push(series.rsrp, wander(-78, 4, series.rsrp.length, 8));
    },
    series: () => series,
    streams: () => streams,
    topology: () => topology,

    status() {
      return {
        state: "running", step: "done", active_mode: "vxlan", last_error: null,
        modem: {
          device: "/dev/ttyUSB2", wwan_interface: "wwan0", cid: 1, mode: "vxlan",
          registered: true, pdu_active: true, mac_address: mac, ipv4: "10.45.0.17",
          band: "n77", cell: "PCI 42", operator: "AMRC-5G",
          signal: {
            rsrp: Math.round(series.rsrp[series.rsrp.length - 1]),
            rsrq: -11, sinr: 21, rssi: -55,
          },
        },
        transport: {
          mode: "vxlan", bridge: "ds-tt-br0", core_ip: "10.45.0.1", mtu: 1450,
          wired_nics: ["enp2s0"],
          classes: streams.slice(0, 3).map((s) => ({
            vlan: s.vlan, vni: s.vlan, pcp: s.pcp, dscp: s.dscp, role: s.role.toLowerCase() })),
        },
        gptp: {
          enabled: true, running: true, locked: true,
          offset_ns: Math.round(series.offset[series.offset.length - 1]),
          path_delay_ns: 214, interfaces: ["enp2s0"], grandmaster: "GPS · GM-1",
        },
      };
    },
    health() {
      return { healthy: true, checks: { modem: true, transport: true, gptp: true },
        state: "running" };
    },
    stats() {
      const if1 = (rx, tx) => ({ rx_bytes: rx, tx_bytes: tx, rx_packets: rx / 900 | 0,
        tx_packets: tx / 900 | 0, rx_dropped: 12, tx_dropped: 3 });
      return { uptime_s: 4213, interfaces: {
        wwan0: if1(9.1e9, 3.2e10), "ds-tt-br0": if1(3.3e10, 9.4e9), enp2s0: if1(3.4e10, 9.2e9),
      } };
    },
    discovery() {
      return { linux: true, inferred_role: { ip: "10.45.0.17", vlan: 60, role: "control" },
        modem: { serial: "/dev/ttyUSB2", wwan: "wwan0", present: true },
        tsn_nics: [{ interface: "enp2s0", hw_timestamping: true, carrier: 1 },
                   { interface: "enp3s0", hw_timestamping: true, carrier: 0 }] };
    },
    switchStatus() {
      return { host: "192.168.1.1", reachable: true, profile: "urllc-5qi82",
        cycle_ns: 1000000, ports: ["GE1/0/1", "GE1/0/2", "GE1/0/3", "GE1/0/4"],
        qbv_enabled: true, ptp_locked: true };
    },

    interfaces() {
      return [
        { name: "wwan0", kind: "modem", state: "up", carrier: true, mac: "8e:41:22:7b:0c:19",
          speed: "150 Mb/s", mtu: "1450", ipv4: "10.45.0.17/16" },
        { name: "enp2s0", kind: "ethernet", state: "up", carrier: true, mac: "00:1b:21:aa:01:02",
          speed: "1000 Mb/s", mtu: "1450", ipv4: "10.70.0.2/24" },
        { name: "enp3s0", kind: "ethernet", state: "down", carrier: false, mac: "00:1b:21:aa:01:03",
          speed: null, mtu: "1500", ipv4: null },
        { name: "enp4s0", kind: "ethernet", state: "up", carrier: true, mac: "00:1b:21:aa:01:04",
          speed: "1000 Mb/s", mtu: "1500", ipv4: "192.168.1.50/24" },
        { name: "wlp1s0", kind: "wifi", state: "up", carrier: true, mac: "a4:c3:f0:12:9d:5e",
          speed: "866 Mb/s", mtu: "1500", ipv4: "192.168.0.42/24" },
      ];
    },
    wifi() {
      return [
        { ssid: "AMRC-Factory", signal: 82, security: "WPA2", active: true },
        { ssid: "AMRC-Guest", signal: 61, security: "WPA2", active: false },
        { ssid: "Cincoze-Lab", signal: 47, security: "WPA3", active: false },
        { ssid: "OpenTest", signal: 33, security: "Open", active: false },
      ];
    },
  };
})(window.TSN);
