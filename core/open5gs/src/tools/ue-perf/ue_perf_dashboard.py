#!/usr/bin/env python3
"""
Render a self-contained HTML dashboard from a ue_perf_collector.py .jsonl log.
  ./ue_perf_dashboard.py --in /tmp/ue_perf.jsonl --out /tmp/ue_perf_dashboard.html
Stdlib only, inline SVG (no external dependencies / works offline).
"""
import argparse, json, statistics as st

TEAL="#0d9488"; AMBER="#f59e0b"; VIOLET="#7c3aed"; INK="#0f172a"; MUT="#64748b"; FAINT="#94a3b8"; GRID="#eef2f6"

def line_multi(series_list, ts, w=1000, h=320, pad=58, ylabel="", fmt="{:.1f}", legend=None):
    allys=[y for s in series_list for y in s[0]]
    if not allys: allys=[0,1]
    ymin=min(0,min(allys)); ymax=max(allys) or 1
    if ymax==ymin: ymax=ymin+1
    xmin,xmax=(min(ts),max(ts)) if ts else (0,1)
    if xmax==xmin: xmax=xmin+1
    def X(x): return pad+(x-xmin)/(xmax-xmin)*(w-pad-16)
    def Y(y): return h-pad-(y-ymin)/(ymax-ymin)*(h-pad-24)
    grid=""
    for i in range(6):
        yy=ymin+(ymax-ymin)*i/5; gy=Y(yy)
        grid+=f'<line x1="{pad}" y1="{gy:.1f}" x2="{w-16}" y2="{gy:.1f}" stroke="{GRID}"/>'
        grid+=f'<text x="{pad-8}" y="{gy+4:.1f}" text-anchor="end" font-size="12.5" fill="{FAINT}">{fmt.format(yy)}</text>'
    xlab=""
    for i in range(7):
        xx=xmin+(xmax-xmin)*i/6; gx=X(xx)
        xlab+=f'<text x="{gx:.1f}" y="{h-pad+22}" text-anchor="middle" font-size="12.5" fill="{FAINT}">{xx:.0f}s</text>'
    polys=""
    for ys,color in series_list:
        pts=" ".join(f"{X(x):.1f},{Y(y):.1f}" for x,y in zip(ts,ys))
        polys+=f'<polyline fill="none" stroke="{color}" stroke-width="2.1" stroke-linejoin="round" points="{pts}"/>'
    leg=""
    if legend:
        lx=pad+8
        for lab,color in legend:
            leg+=f'<rect x="{lx}" y="8" width="11" height="11" rx="2" fill="{color}"/>'
            leg+=f'<text x="{lx+16}" y="18" font-size="12.5" fill="{INK}">{lab}</text>'
            lx+=len(lab)*8+44
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" preserveAspectRatio="xMidYMid meet">{grid}{xlab}{polys}'
            f'<text x="{pad}" y="20" font-size="13.5" fill="{INK}" font-weight="700">{ylabel}</text>{leg}</svg>')

def histogram(vals, w=1000, h=300, pad=58, color=VIOLET, xlabel=""):
    vals=[v for v in vals if v is not None]
    if not vals: vals=[0]
    mx=max(vals) or 1; nb=24; bw_=mx/nb
    bins=[0]*nb
    for v in vals: bins[min(nb-1,int(v/bw_))]+=1
    bmax=max(bins) or 1; bw=(w-pad-16)/nb; bars=""
    for i,c in enumerate(bins):
        bh=(c/bmax)*(h-pad-24)
        bars+=f'<rect x="{pad+i*bw:.1f}" y="{h-pad-bh:.1f}" rx="2" width="{bw-2.5:.1f}" height="{bh:.1f}" fill="{color}" opacity="0.85"/>'
    grid=""
    for i in range(6):
        gy=h-pad-(i/5)*(h-pad-24)
        grid+=f'<line x1="{pad}" y1="{gy:.1f}" x2="{w-16}" y2="{gy:.1f}" stroke="{GRID}"/>'
        grid+=f'<text x="{pad-8}" y="{gy+4:.1f}" text-anchor="end" font-size="12.5" fill="{FAINT}">{bmax*i/5:.0f}</text>'
    xl=""
    for i in range(7):
        xx=mx*i/6; gx=pad+(xx/mx)*(w-pad-16)
        xl+=f'<text x="{gx:.1f}" y="{h-pad+22}" text-anchor="middle" font-size="12.5" fill="{FAINT}">{xx:.1f}</text>'
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" preserveAspectRatio="xMidYMid meet">{grid}{bars}{xl}'
            f'<text x="{w/2}" y="{h-7}" text-anchor="middle" font-size="12.5" fill="{FAINT}">{xlabel}</text></svg>')

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", default="/tmp/ue_perf.jsonl")
    ap.add_argument("--out", default="/tmp/ue_perf_dashboard.html")
    ap.add_argument("--date", default="")
    a=ap.parse_args()
    R=[json.loads(l) for l in open(a.inp) if l.strip()]
    if not R: print("no records"); return
    ts=[r["t"] for r in R]
    dl=[r.get("dl_mbps",0) for r in R]; ul=[r.get("ul_mbps",0) for r in R]
    dlpps=[r.get("dl_pps",0) for r in R]; ulpps=[r.get("ul_pps",0) for r in R]
    lat=[r.get("lat_avg") for r in R]; latv=[x for x in lat if x is not None]
    have_lat=len(latv)>0
    active=[r for r in R if r.get("active")]
    drop=max((r.get("dropped",0) for r in R), default=0)
    rxb=[r.get("rx_bytes",0) for r in R]; txb=[r.get("tx_bytes",0) for r in R]
    vol_ul=(max(rxb)-min(rxb))/1e6 if rxb else 0
    vol_dl=(max(txb)-min(txb))/1e6 if txb else 0
    def pk(v): return max(v) if v else 0
    def av(v):
        v=[x for x in v if x]; return st.mean(v) if v else 0
    def p95(v):
        v=sorted(x for x in v if x is not None)
        return v[int(round(0.95*(len(v)-1)))] if v else 0
    meta_qfi=next((r.get("qfi") for r in R if r.get("qfi") is not None), "-")
    meta_5qi=next((r.get("fiveqi") for r in R if r.get("fiveqi") is not None), "-")
    meta_mac=next((r.get("ue_mac") for r in R if r.get("ue_mac")), "-")
    uptime=100*len(active)/len(R) if R else 0
    dur=round(ts[-1]-ts[0]) if ts else 0

    def kpi(l,v,s="",ac=TEAL): return f'<div class="kpi" style="--ac:{ac}"><div class="kpi-lab">{l}</div><div class="kpi-val">{v}</div><div class="kpi-sub">{s}</div></div>'
    c_thr=line_multi([(dl,TEAL),(ul,AMBER)], ts, ylabel="Throughput (Mbps) vs time", fmt="{:.1f}",
                     legend=[("Downlink",TEAL),("Uplink",AMBER)])
    c_pps=line_multi([(dlpps,TEAL),(ulpps,AMBER)], ts, ylabel="Packet rate (pps) vs time", fmt="{:.0f}",
                     legend=[("DL pps",TEAL),("UL pps",AMBER)])
    c_lat = line_multi([(latv,VIOLET)], [r["t"] for r in R if r.get("lat_avg") is not None],
                       ylabel="Latency RTT avg (ms) vs time", fmt="{:.0f}") if have_lat else ""
    c_lath = histogram(latv, color=VIOLET, xlabel="RTT (ms)") if have_lat else ""

    lat_cards = (kpi("Avg latency", f"{av(latv):.1f} ms", f"p95 {p95(latv):.1f} ms", VIOLET) +
                 kpi("Max latency", f"{max(latv):.1f} ms", "worst RTT", VIOLET)) if have_lat else \
                kpi("Latency", "n/a", "no ping target", FAINT)

    doc=f"""<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>UE Performance — AMRC 5G-TSN</title><style>
*{{box-sizing:border-box}} body{{font-family:system-ui,-apple-system,'Segoe UI',Roboto,Arial,sans-serif;margin:0;background:#f5f7f9;color:{INK}}}
.wrap{{max-width:1160px;margin:0 auto;padding:30px 26px 40px}}
header{{background:linear-gradient(120deg,#0b1220,#0f3b38 48%,#0d9488);color:#fff;border-radius:20px;padding:30px 34px;margin-bottom:22px;box-shadow:0 18px 40px -20px rgba(13,148,136,.55)}}
header h1{{margin:0 0 8px;font-size:26px;font-weight:800}} header .sub{{opacity:.9;font-size:14px}}
.kpis{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}}
.kpi{{background:#fff;border-radius:16px;padding:16px 18px;border:1px solid #eaeef2;box-shadow:0 10px 24px -18px rgba(16,24,40,.18);position:relative;overflow:hidden}}
.kpi::before{{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--ac)}}
.kpi-lab{{font-size:11px;color:{MUT};font-weight:700;letter-spacing:.4px;text-transform:uppercase}}
.kpi-val{{font-size:25px;font-weight:800;margin-top:5px}} .kpi-sub{{font-size:11.5px;color:#9aa6b2;margin-top:3px}}
.card{{background:#fff;border-radius:18px;padding:22px 24px;margin-bottom:18px;border:1px solid #eaeef2;box-shadow:0 14px 30px -22px rgba(16,24,40,.2)}}
.card h2{{margin:0 0 4px;font-size:16.5px;display:flex;align-items:center;gap:9px;font-weight:700}}
.card h2::before{{content:"";width:8px;height:18px;border-radius:3px;background:{TEAL}}}
.card .note{{font-size:12.5px;color:{MUT};margin:6px 0 14px}}
table{{width:100%;border-collapse:collapse;font-size:13px}} td,th{{text-align:left;padding:8px;border-bottom:1px solid #eef2f6}}
td:last-child{{font-weight:700;font-variant-numeric:tabular-nums}}
.two{{display:grid;grid-template-columns:1fr 1fr;gap:18px}}
footer{{font-size:11.5px;color:#9aa6b2;text-align:center;margin-top:10px}}
@media(max-width:780px){{.kpis{{grid-template-columns:repeat(2,1fr)}}.two{{grid-template-columns:1fr}}}}
</style></head><body><div class="wrap">
<header><h1>UE Performance — 5G Data-Plane KPIs</h1>
<div class="sub">Collected at the core (UPF NW-TT counters + active latency). {a.date}</div></header>
<div class="kpis">
 {kpi("Peak downlink", f"{pk(dl):.2f} Mbps", f"avg {av(dl):.2f}", TEAL)}
 {kpi("Peak uplink", f"{pk(ul):.2f} Mbps", f"avg {av(ul):.2f}", AMBER)}
 {lat_cards}
 {kpi("Volume DL / UL", f"{vol_dl:.1f} / {vol_ul:.1f} MB", "session total")}
 {kpi("Dropped (PSFP)", f"{drop}", "policed frames", AMBER)}
 {kpi("Session uptime", f"{uptime:.0f}%", f"{dur}s window")}
</div>
<div class="card"><h2>Throughput</h2>
 <p class="note">UL/DL goodput derived from NW-TT byte counters (Δbytes×8/Δt). Gaps = idle / link down.</p>{c_thr}</div>
<div class="card"><h2>Packet rate</h2><p class="note">Frames per second, each direction.</p>{c_pps}</div>
{'<div class="card"><h2>Latency over time</h2><p class="note">Active RTT to the device (ms). Tracks the 5G radio variability.</p>'+c_lat+'</div>' if have_lat else ''}
{'<div class="two"><div class="card"><h2>Latency distribution</h2><p class="note">RTT histogram.</p>'+c_lath+'</div>' if have_lat else '<div class="two">'}
 <div class="card"><h2>Session</h2><table>
  <tr><td>Device (DS-TT) MAC</td><td>{meta_mac}</td></tr>
  <tr><td>QFI / 5QI</td><td>{meta_qfi} / {meta_5qi}</td></tr>
  <tr><td>Peak DL / UL</td><td>{pk(dl):.2f} / {pk(ul):.2f} Mbps</td></tr>
  <tr><td>Avg DL / UL</td><td>{av(dl):.2f} / {av(ul):.2f} Mbps</td></tr>
  <tr><td>Dropped frames</td><td>{drop}</td></tr>
  <tr><td>Samples / window</td><td>{len(R)} / {dur}s</td></tr>
 </table></div>
</div>
<footer>Generated from {len(R)} samples · {a.inp} · AMRC 5G-TSN</footer>
</div></body></html>"""
    open(a.out,"w").write(doc)
    print("WROTE",a.out,len(doc),"bytes")

if __name__=="__main__":
    main()
