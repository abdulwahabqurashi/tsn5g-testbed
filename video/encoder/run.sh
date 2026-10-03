#!/bin/bash

set -euo pipefail

appDir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export SPINNAKER_GENTL64_CTI="$appDir/gentl/Spinnaker_GenTL.cti"
export GENICAM_GENTL64_PATH="$appDir/gentl${GENICAM_GENTL64_PATH:+:$GENICAM_GENTL64_PATH}"

# libSpinnaker.so.4 has no RUNPATH of its own, and RUNPATH is not inherited by
# transitive dependencies, so the loader cannot find its siblings (libGenApi,
# libGCBase, libiomp5) in lib/. LD_LIBRARY_PATH applies to all lookups.
export LD_LIBRARY_PATH="$appDir/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

# Both tarballs ship only the xcb platform plugin; without this Qt probes for
# Wayland, fails, and aborts on a Wayland session.
export QT_QPA_PLATFORM="${QT_QPA_PLATFORM:-xcb}"

exec "$appDir/bin/pathStream1" "$@"
