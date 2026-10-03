#!/bin/bash
# Build what the core runs, from pinned sources. install.sh core calls this;
# it can also be run alone, e.g. after changing a patch.
#
#   sudo core/build.sh [all|deps|srsran|open5gs|webui]
#
#   deps      Ubuntu 24.04 packages, UHD 4.6 (Ubuntu archive), MongoDB 7.0 and
#             Node.js 20 (their own apt repositories)
#   srsran    SRSRAN_REPO @ SRSRAN_COMMIT + core/srsran/*.patch -> $PREFIX/build/srsRAN_Project
#             Release, -march=native (build on the machine that runs it)
#   open5gs   core/open5gs/src -> $PREFIX/build/open5gs (meson, debug buildtype:
#             what the first rig ran and was tested with)
#   webui     npm install for the Open5GS WebUI
#
# Each step skips work that is already done for the same inputs.
set -euo pipefail
# shellcheck source=../lib/render.sh
. "$(dirname "$(readlink -f "$0")")/../lib/render.sh"
[ -n "${SITE_FILE:-}" ] || load_site "${SITE_ENV:-$( [ -f "$REPO_ROOT/site.env" ] && echo "$REPO_ROOT/site.env" || echo /etc/tsn5g/site.env)}"
need_root
BUILD=$PREFIX/build
O5GS_SRC=${O5GS_SRC:-$REPO_ROOT/core/open5gs/src}
JOBS=$(nproc)

deps() {
    say "build deps"
    apt_install ca-certificates curl gnupg git build-essential cmake pkg-config \
        ninja-build meson flex bison python3-pip python3-setuptools python3-wheel \
        libsctp-dev libgnutls28-dev libgcrypt20-dev libssl-dev libidn-dev \
        libmongoc-dev libbson-dev libyaml-dev libnghttp2-dev libmicrohttpd-dev \
        libcurl4-gnutls-dev libtins-dev libtalloc-dev \
        libfftw3-dev libmbedtls-dev libyaml-cpp-dev libgtest-dev libzmq3-dev \
        libuhd-dev uhd-host numactl ethtool iperf3 tcpdump iptables iproute2 openssl gettext-base rsync

    if ! dpkg -s mongodb-org >/dev/null 2>&1; then
        say "MongoDB $MONGODB_SERIES (repo.mongodb.org; the jammy build, as on the first rig)"
        run sh -c "curl -fsSL https://www.mongodb.org/static/pgp/server-$MONGODB_SERIES.asc | gpg --dearmor -o /usr/share/keyrings/mongodb-server-$MONGODB_SERIES.gpg --yes"
        run sh -c "echo 'deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-$MONGODB_SERIES.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/$MONGODB_SERIES multiverse' > /etc/apt/sources.list.d/mongodb-org-$MONGODB_SERIES.list"
        run apt-get update -q
        run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q mongodb-org
    fi
    run systemctl enable --now mongod

    if ! node -v 2>/dev/null | grep -q '^v20\.'; then
        say "Node.js 20 (deb.nodesource.com)"
        run sh -c "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg --yes"
        run sh -c "printf 'Types: deb\nURIs: https://deb.nodesource.com/node_20.x\nSuites: nodistro\nComponents: main\nArchitectures: amd64\nSigned-By: /usr/share/keyrings/nodesource.gpg\n' > /etc/apt/sources.list.d/nodesource.sources"
        run apt-get update -q
        run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
    fi
}

srsran() {
    local dir=$BUILD/srsRAN_Project stamp want
    want="$SRSRAN_COMMIT $(cat "$REPO_ROOT"/core/srsran/*.patch | sha256sum | cut -c1-16)"
    stamp=$dir/build/.tsn5g-built
    if [ -x "$dir/build/apps/gnb/gnb" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
        say "srsRAN already built at $want"; return
    fi
    say "srsRAN $SRSRAN_COMMIT + $(ls "$REPO_ROOT"/core/srsran/*.patch | wc -l) patch(es)"
    [ -d "$dir/.git" ] || run git clone "$SRSRAN_REPO" "$dir"
    run git -C "$dir" fetch --quiet origin
    run git -C "$dir" checkout --quiet --force --detach "$SRSRAN_COMMIT"
    run git -C "$dir" -c user.name=tsn5g -c user.email=tsn5g@localhost am --quiet "$REPO_ROOT"/core/srsran/*.patch
    run cmake -S "$dir" -B "$dir/build" -DCMAKE_BUILD_TYPE=Release -DENABLE_UHD=ON \
        -DENABLE_DPDK=OFF -DENABLE_WERROR=OFF -DMARCH=native
    run cmake --build "$dir/build" --target gnb -j "$JOBS"
    if [ "$DRY_RUN" != 1 ]; then echo "$want" > "$stamp"; fi
}

open5gs() {
    local dir=$BUILD/open5gs
    say "Open5GS (TSN fork) from $O5GS_SRC"
    [ -f "$dir/build.ninja" ] || run meson setup "$dir" "$O5GS_SRC" --buildtype=debug
    run ninja -C "$dir"
}

webui() {
    say "Open5GS WebUI dependencies"
    run sh -c "cd '$O5GS_SRC/webui' && npm install --legacy-peer-deps --no-audit --no-fund"
    # It runs as CORE_USER and writes its .env (session secrets) and .next here.
    run chown -R "$CORE_USER:" "$O5GS_SRC/webui"
}

run mkdir -p "$BUILD"
case "${1:-all}" in
    all) deps; srsran; open5gs; webui ;;
    deps|srsran|open5gs|webui) "$1" ;;
    *) die "usage: $0 [all|deps|srsran|open5gs|webui]" ;;
esac
