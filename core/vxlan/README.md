# core/vxlan: NW-TT, the core's end of the camera tunnels

The UE can carry each camera as **VLAN-tagged Ethernet inside its own VXLAN
tunnel** (Cameras page → Video path → *VLAN + VXLAN*; `ue/tsn5g_ue/net/campath.py`).
Together with the 5G system, the UE's tunnel start (DS-TT) and the core's
tunnel end (NW-TT) behave like one TSN bridge between the cameras and the
video server.

| | Camera 1 | Camera 2 |
|---|---|---|
| VXLAN id (VNI) | 70 | 80 |
| VLAN · PCP | 70 · 4 (video) | 80 · 0 |
| UE address in the VLAN | 10.70.0.2 | 10.80.0.2 |
| Video server address | **10.70.0.1** | **10.80.0.1** |
| Video port (unchanged) | 50451 | 50452 |
| Outer UDP | UE:**5202** → core:4789 | UE:5212 → core:4789 |
| Outer DSCP | 34 (AF41) | 0 |
| 5G flow | GBR, QFI 2 (the PCC rule matches source port 5202) | default, QFI 1 |

The outer source port is fixed on purpose. The GBR rule on the core matches
the UE's source port 5202, so camera 1's tunnel stays on the GBR flow exactly
as its direct stream did. Nothing in Open5GS needs to change.

## Set up on the core

```bash
cd ~/tsn5g-testbed && git pull
sudo core/scripts/nw-tt.sh up       # once, by hand
sudo core/scripts/nw-tt.sh status
```

`install.sh core` installs `tsn5g-nwtt.service`, which runs the same at every
boot after `tsn5g-core-net.service`.

What it builds:

```
ogstun ─ nwtt-vx70 (VXLAN 70) ─ nwtt70 (VLAN 70, 10.70.0.1/24) ─┐
       └ nwtt-vx80 (VXLAN 80) ─ nwtt80 (VLAN 80, 10.80.0.1/24) ─┴ video server (pathView, ports 50451/50452)
```

- The tunnels have no fixed remote: the UE's address changes with every data
  call, so each tunnel learns the UE's end from the first packet.
- MTU: bearer 1400 → VXLAN device 1364 → inner 1346. Set `NWTT_BEARER_MTU`
  when the session MTU becomes 1500.
- `INPUT` accepts UDP 4789 on `ogstun`.

## Check it end to end

1. On the UE, switch Cameras → Video path to **VLAN + VXLAN**.
2. On the Cameras page, *Core endpoint* turns green ("10.70.0.1 answers")
   once the UE has resolved the server across the tunnel.
3. On the core:
   - `sudo core/scripts/nw-tt.sh status` shows each VLAN's learned UE end
     and its packet count rising;
   - `sudo tcpdump -i nwtt70 -n -c 5 udp port 50451` shows camera 1's video.
4. The viewer must accept video on 10.70.0.1:50451 and 10.80.0.1:50452. If it
   listens on all addresses (the usual case), nothing changes. If it is bound
   to the bearer address, point it at these.

## A separate video server or a TSN switch

To leave the core on a physical port instead of terminating here, bridge the
VXLAN device with that port and move the address off:

```bash
sudo ip link del nwtt70
sudo ip link add br70 type bridge vlan_filtering 1
sudo ip link set nwtt-vx70 master br70 && sudo ip link set <port> master br70
sudo bridge vlan add dev nwtt-vx70 vid 70 && sudo bridge vlan add dev <port> vid 70
sudo ip link set br70 up
```

The frames then leave the port still tagged VLAN 70 with PCP 4. A TSN switch
can then schedule on them.
