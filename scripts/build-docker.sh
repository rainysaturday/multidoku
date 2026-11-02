#!/usr/bin/env bash
# Build the SudokuCoop image, including Raspberry Pi targets.
#
#   ./scripts/build-docker.sh                 # build for this machine
#   ./scripts/build-docker.sh pi              # linux/arm64  (64-bit Pi OS: Pi 3/4/5)
#   ./scripts/build-docker.sh pi32            # linux/arm/v7 (32-bit Pi OS)
#   ./scripts/build-docker.sh pi --save sudoku-coop-arm64.tar.gz
#   ./scripts/build-docker.sh pi --push ghcr.io/you/sudoku-coop
#
# --save writes a gzipped tarball you can copy to the Pi and load there with:
#   gunzip -c sudoku-coop-arm64.tar.gz | docker load
# so you need no registry, and no compiling on the Pi itself.
#
# Cross-building for a Pi architecture from an x86 machine needs QEMU binfmt
# registration (buildx does it for you, or):
#   docker run --privileged --rm tonistiigi/binfmt --install all
# Otherwise build on the Pi itself — plain `docker build -t sudoku-coop .` there.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-sudoku-coop}
PLATFORM=""
PUSH=""
SAVE=""
TAG=latest

usage() { grep '^# ' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while (($#)); do
  case "$1" in
    pi|arm64)   PLATFORM=linux/arm64 ;;
    pi32|armv7) PLATFORM=linux/arm/v7 ;;
    --platform) PLATFORM=${2:?missing platform}; shift ;;
    --tag)      TAG=${2:?missing tag}; shift ;;
    --push)     PUSH=${2:?missing image ref to push}; shift ;;
    --save)     SAVE=${2:?missing output path}; shift ;;
    -h|--help)  usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
  shift
done

have_buildx() { docker buildx version >/dev/null 2>&1; }

# Can this host actually run the target architecture (natively or via QEMU binfmt)?
platform_ok() {
  local arch=${1##*/} host
  host=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/;s/armv7l/arm/;s/armv6l/arm/')
  [[ $arch == "$host" || $arch == "$host"l ]] && return 0
  docker run --rm --platform "$1" node:22-bookworm-slim node -e '0' >/dev/null 2>&1
}

if [[ -n $PLATFORM ]] && ! platform_ok "$PLATFORM"; then
  cat >&2 <<EOF
Cannot build for $PLATFORM on this host: no QEMU emulation is registered.

Pick one:
  1. Register emulation, then re-run this command:
       docker run --privileged --rm tonistiigi/binfmt --install all
  2. Build on the Pi itself (native, and fastest on older boards):
       cd sudoku-coop && docker build -t sudoku-coop .
EOF
  exit 1
fi

# buildx is needed for multi-arch/--push/--output; classic build covers the rest.
if have_buildx; then
  build_args=(buildx build -t "${IMAGE}:${TAG}")
  [[ -n $PLATFORM ]] && build_args+=(--platform "$PLATFORM")
  [[ -n $PUSH ]] && build_args+=(-t "${PUSH}:${TAG}" --push)
  [[ -n $SAVE ]] && build_args+=(-o "type=docker,dest=${SAVE}.tar")
else
  build_args=(build)
  [[ -n $PLATFORM ]] && build_args+=(--platform "$PLATFORM")
  build_args+=(-t "${IMAGE}:${TAG}" .)
fi

echo "+ docker ${build_args[*]}"
docker "${build_args[@]}"

# Classic build has no --output, so export the image ourselves.
if [[ -n $SAVE ]] && ! have_buildx; then
  docker save "${IMAGE}:${TAG}" | gzip > "${SAVE}.tar.gz"
fi

if [[ -n $SAVE ]]; then
  [[ -f ${SAVE}.tar && ! -f ${SAVE}.tar.gz ]] && gzip -f "${SAVE}.tar"
  echo
  echo "Saved ${SAVE}.tar.gz — copy it to the Pi, then:"
  echo "  gunzip -c ${SAVE}.tar.gz | docker load"
  echo "  docker run -d --name sudoku-coop -p 8787:8787 --restart unless-stopped ${IMAGE}:${TAG}"
fi

if [[ -n $PUSH ]]; then
  have_buildx || docker push "${PUSH}:${TAG}"
  echo "Pushed ${PUSH}:${TAG}"
else
  echo
  echo "Built ${IMAGE}:${TAG}. Run it with:"
  echo "  docker run --rm -p 8787:8787 ${IMAGE}:${TAG}"
fi
