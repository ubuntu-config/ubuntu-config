#!/usr/bin/env bash
#
# Write a backtrace of each core file in CORES_DIR and compress the core files.
#
# Usage: backtrace-cores.sh CORES_DIR DEBS_DIR...
#
# Runs as root in the container of a CI job, after the job's script. The kernel writes the core files of processes which
# crashed in the job into CORES_DIR, as core.COMM.PID.TIME. Writes the backtraces of all threads of each core file CORE
# to CORE.backtrace.txt and then compresses CORE to CORE.zst. gdb reads the debug symbols of the packages built here from
# the .ddeb files in each DEBS_DIR, and those of Ubuntu's packages from debuginfod.ubuntu.com. Installs gdb and zstd
# only when CORES_DIR has a core file, and does nothing otherwise.

set -euo pipefail

CORES=$1
shift

shopt -s nullglob

cores=()
for core in "$CORES"/core.*; do
  case "$core" in *.zst|*.backtrace.txt) continue ;; esac
  [ -f "$core" ] && cores+=("$core")
done
[ ${#cores[@]} -gt 0 ] || exit 0
echo "backtrace-cores: ${#cores[@]} core files in $CORES"

apt-get update -q
# libc6-dbg has the debug symbols of the C library, which debuginfod.ubuntu.com lacks for some of its updates.
apt-get install -y -q --no-install-recommends ca-certificates gdb libc6-dbg zstd

# A .ddeb holds only debug files, under /usr/lib/debug/.build-id/, where gdb finds each by the build ID of its binary,
# also for a binary the job extracted elsewhere, like mutter into /tmp/mutter-root.
for dir in "$@"; do
  for ddeb in "$dir"/*.ddeb; do
    dpkg-deb -x "$ddeb" /
  done
done

# gdb loads the executable from the path the core file records, which is still there, as the job's container is the
# same one in which the process crashed.
gdb=(gdb -nx -batch -ex 'info sharedlibrary' -ex 'thread apply all bt full')
export DEBUGINFOD_URLS=https://debuginfod.ubuntu.com
for core in "${cores[@]}"; do
  echo "backtrace-cores: $core"
  status=0
  timeout 900 "${gdb[@]}" -iex 'set debuginfod enabled on' -c "$core" > "$core.backtrace.txt" 2>&1 || status=$?
  # Downloads from debuginfod.ubuntu.com which do not finish within 15 minutes leave a backtrace with only the symbols
  # of the packages built here and of exported functions.
  if [ $status = 124 ]; then
    echo "backtrace-cores: downloading debug symbols did not finish within 15 minutes, $core.backtrace.txt has only local symbols"
    timeout 300 "${gdb[@]}" -iex 'set debuginfod enabled off' -c "$core" > "$core.backtrace.txt" 2>&1 || true
  fi
  zstd -q --rm -T0 "$core" || echo "backtrace-cores: could not compress $core"
done
