# Lessons from the first rig

Problems that cost real time on the first rig (AMRC, Aug–Oct 2026). For each:
the symptom, the cause, and where the fix now lives. Each one is either fixed
in this repository or flagged in the installer, so a new site does not repeat
it. The original notes are in `docs/history/`.

## Radio and gNB

**Camera uplink loss of 10–25 %, coming and going.**
The cause was srsRAN's default PUSCH link adaptation: the 256-QAM MCS table,
with an OLLA step of 0.001, which is far too slow to back off. The uplink
flipped between MCS 7 at 0 % BLER and MCS 21–24 at 35–42 % BLER. The camera
bearers were RLC UM, so every failed transport block became lost packets. The
UE's RSRP/SINR looked fine throughout, because they are downlink figures.
→ `core/gnb/gnb.yaml.in`: `pusch: mcs_table qam64, olla_snr_inc_step 0.01,
olla_max_snr_offset 10`, and RLC **AM** for 5QI 4/7/9 (5QI 4 PDCP discard −1).
Result: BLER 0–2 %, camera loss 0.00 %.
*How to look:* turn on `metrics.enable_log` briefly and read the
`Scheduler UE` lines (`pusch_snr_db`, `ul_mcs`, `ul_error_rate`) before
theorising. Measure loss with UE and core counters over the same window
(`tools/camera-loss-check.sh`), never one after the other.

**`metrics.enable_log` raised RF underflows about 4×.**
→ It is off in gnb.yaml.in. Turn it on only while debugging, then off again.

**"RF: underflow" is not the signal; "Downlink data late" is.**
About 1–2 underflows per second is the baseline, idle or loaded. "Downlink
data late" comes in bursts, means the host missed the slot deadline, and
matches downlink TCP damage. It is host real-time scheduling, not the air.
→ RT tuning: `core/scripts/rt-grub.sh` plus BIOS (DEPLOY §2.1). The installer
warns if CPU isolation is not active.

**The grub edit that applied 1 of 5 parameters.** A hand edit spread
`GRUB_CMDLINE_LINUX_DEFAULT` over several lines. grub-mkconfig kept only the
first line, so the reboot looked fine but `nohz_full` and the rest were gone.
→ `rt-grub.sh` writes one line and checks `grub.cfg` before you reboot;
`post_reboot_check.sh` checks the live kernel.

**X410 stream wedges.** fwupd's daily refresh stalled the PCIe bus. The gNB
stayed alive (so `Restart=always` never fired) while its RSS grew to 41 GB and
it transmitted nothing.
→ The core install disables `fwupd-refresh.timer`. `tsn_health.sh` detects
the wedge by RSS, UHD timeouts and PRACH depletion, not by whether the process
is alive.

**UHD needs jumbo frames.** At MTU 1500 the X410 gave RPC timeouts and a
segfault.
→ `X410_MTU=9000`, applied by `core-net.sh` before every gNB start.

**srsRAN dropped GBR on PDU Session Modify.** Open5GS adds the PCC rule's GBR
flow with a Modify. srsRAN converted GBR information only on Setup, so the
DRB got the generic non-GBR MAC config: same priority, PBR 8 kB/s. The modem
was then given two identical logical channels, which looked exactly like "the
modem ignores LCP".
→ `core/srsran/0001-…patch`, applied by `core/build.sh`.

## Core

**The UPF dropped camera bursts.** Its GTP-U socket uses the kernel default
receive buffer (208 KB), and bursts overflowed it. This showed up as uplink
"radio" loss.
→ `net.core.rmem_default = 8388608` (`core/etc/90-tsn-udp.conf`). The same
setting is used for the viewer.

**The GBR rule matches the UE's *source* port.** The PCC flow is written in
downlink form, "permit out udp from any 1-65535 to assigned 5202", and Open5GS
swaps it for the uplink. So camera 1 rides the GBR flow only if it **sends
from** port `GBR_SOURCE_PORT`. Everything sent *to* 5202 landed on the
default flow and invalidated a day of tests.
→ The UE daemon SNATs camera 1 to that source port (`source_port` in the
egress class). The subscriber record comes from `subscriber.json.in`.

**Nothing started the core at boot.** run5gs.sh started the NFs by hand; the
health timer noticed they were down three minutes after boot and ran it. NAT
and `ip_forward` were lost on every reboot.
→ `open5gs@.service` + `open5gs.target`, and `tsn5g-core-net.service`.

**The NRF died silently.** open5gs-nrfd aborted on subscription-pool
exhaustion. Every other NF sat in a retry loop and registration was rejected,
while `run5gs.sh status` still printed "running".
→ `tsn_health.sh` checks that the NRF is listening and looks for SBI error
storms; the NF units restart a dead NF.

**The UDM pointed at hnet keys that did not exist.** This was harmless only
because the SIM uses the null SUCI scheme.
→ Per-site keys are generated in `/etc/tsn5g/open5gs/hnet/`.

**Re-registration every ~9 minutes is configured** (`t3512: 540` in
amf.yaml), not a fault. A perfectly regular event is a timer.

## UE

**The RM520N attaches to SA only with `nr5g_disable_mode=0`.** Values 1 and 2
both leave it searching forever. While it is 1, writes to `nr5g_band` return
OK and are silently discarded. Set mode 0 **first**, then the band list
(must include 78). `+CSQ: 99,99` means "not camped", not "no RF".

**ModemManager must be masked, not stopped.** D-Bus restarts it, and it then
fights the daemon for the AT port and rewrites radio settings.
→ `install.sh ue` masks it.

**NetworkManager overwrote the camera NICs' addresses** about 15 minutes after
the daemon set them.
→ `99-tsn-cameras.conf` (unmanaged-devices).

**Both encoders grabbed both cameras.** The encoder opens the first camera it
finds on any NIC.
→ Camera 2's NIC lives in its own network namespace
(`tsn5g-cam2-netns.service`), with NAT and a leak guard to the bearer. Don't
tie that unit to the NIC's device unit: moving the NIC into the namespace
removes the device, and `BindsTo=` would stop the unit.

**The encoder has no auto-start.** Streaming begins only when its Qt Start
button is clicked, and there is no config key for it.
→ `tsn5g_ue/encoder_gui.py` clicks it through XTEST on the virtual screen.
`tsn5g-cameras.service` does this after boot. To stop an encoder, close its
window or use `cameras-start.sh stop`, which waits for the camera to release
its control channel. A plain kill leaves the camera reserved for a while.

**The modem does not separate traffic by itself under congestion.** The LCP
tests showed both flows losing alike when the uplink was flooded, even with
the GBR flow configured.
→ Priority is enforced on the UE, before the modem: an HTB root shaped just
below what the radio can carry (auto-rate, delay-based, measured with pings
to `CORE_BEARER_IP` that ride the protected lane), camera 1 in the protected
class. Demo result: camera 1 at 99.8–100 % with the policy on, against
78–83 % off.

**The UE clock ran 37 s ahead of the core.** PTP put CLOCK_REALTIME on the
grandmaster's TAI with no UTC offset (the GM advertises utcOffsetValid=0),
which made cross-host timestamps nonsense.
→ The daemon runs phc2sys with `-O -UTC_OFFSET` and sets the kernel TAI
offset (adjtimex ADJ_TAI). `demo-run.sh` still measures the offset before
slicing captures.

**A throughput test aimed at the core's LAN address never touches 5G.**
~940 Mbit/s is the tell. Aim at `CORE_BEARER_IP` and bind to the bearer
address.

**systemctl "Method call timed out" from the UI.** polkit wanted a password
agent, and non-interactive shells have none.
→ The polkit rule from `install.sh ue`.

## Time-sensitive uplink (Stage 6, Oct 2026)

**A Qbv gate on the UE does not protect anything on its own.** It limits
*time*, not bytes, so between protected windows the best-effort traffic still
fills the modem's buffer, and the protected window opens onto a full queue
(sandbox: 23-49 % protected loss with a gate alone). Gate plus the priority
shaper equals the shaper alone for a talker timed to its window, and adds
1-2 ms for one that is not.
-> The protection comes from shaping below the radio with strict priority.
A gate becomes useful only once the radio shares the gate's clock (X410 on
the grandmaster) or schedules on the same cycle (configured grant).

**Software taprio and its link speed.** taprio sizes each window's byte budget
from the device's ethtool speed. An IFB reports none and is treated as
10 Mbit/s (about one packet per window); a veth reports 10 Gbit/s. A `tbf`
under taprio stalled completely on kernel 6.8.

**The shaper rate is what sets the tail.** Shaped at 40 Mbit/s (about the
radio's capacity) the protected stream's p99 delay under flood was 84-130 ms:
whenever the radio dipped below the shaper, packets queued *in the modem*,
which has no priority. Shaped at 25 Mbit/s: p99 28 ms, better than an idle
link. Auto-rate exists to keep the shaper below the radio's current capacity.
Three gNB timers were tried first and did not move the tail (RLC
t-poll-retransmit 100->40, retx-BSR 80->20); the SR period 20->5 ms did help
the idle median.

**A fixed SNAT port collides across restarts.** Camera 1 and the test talker
are NATed to ONE source port (the GBR filter's). A new process on a new local
port collides with the old conntrack entry, which holds that mapping for 30 s,
and every packet is dropped (`conntrack -S`: insert_failed). It cost two test
runs (75 % "loss").
-> Clear the entries on restart (`cameras-start.sh`, `qbv-live.sh`), or keep
the local port fixed.

## Tooling

- `pkill -f "iperf3 -s -p N"` run through ssh also matched (and killed) the
  ssh shell's own command line. Anchor the pattern: `pkill -f "^iperf3 …"`.
- iperf3 can print a warning before its JSON. Parse from the first `{`, and
  capture stderr separately.
- The viewer forwarded over SSH X11 was throttled until the kernel dropped
  905,696 packets. Use a virtual screen plus VNC (`vnc-display.sh`) on both
  machines.
