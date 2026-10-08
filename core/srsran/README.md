# core/srsran/

srsRAN Project is built from upstream at a pinned commit (`SRSRAN_REPO`,
`SRSRAN_COMMIT` in site.env) with the patches in this folder applied on top,
in name order. `core/build.sh srsran` does both.

| Patch | Why |
|---|---|
| `0001-ngap-carry-GBR-QoS-…patch` | srsRAN dropped the GBR QoS information when the core added a GBR flow with a PDU Session **Modify** (which is how Open5GS adds the PCC rule's flow). Without it the GBR flow for camera 1 never gets its guaranteed rate. On the first rig this was an unpushed local commit (`078c938` on `4bf1543`). |
| `0002-scheduler-forget-a-UE-s-QoS-rows-…patch` | The gNB aborted (`Assertion has_row_id(rid) failed`, `lcg_qos_context`) on 8 Oct 2026. When a UE is deactivated, srsRAN erases its GBR tracking rows but keeps pointing at them, so a buffer report arriving in that moment hits a deleted row. Only GBR flows have such a row, which is why camera 1's flow triggers it. Also fixes the wrong LCG id passed to `remove_lcg`. Still unfixed upstream (checked `main`, 8 Oct 2026). |

To add a patch: commit the change in a srsRAN checkout, then
`git format-patch -1 <commit> -o core/srsran/` and bump the number.
