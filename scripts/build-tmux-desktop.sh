#!/usr/bin/env bash
# Build tmux for macOS and stage it as the desktop app's sidecar
# (tauri.conf.json bundle.externalBin), next to the agent. Local sessions run
# Claude inside tmux, and the app must not ask its users to install it.
#
# Built from pinned, checksummed source: libevent and utf8proc are linked in
# statically, ncurses is the system's (macOS ships it, with a terminfo that has
# tmux-256color). The tmux version matches Homebrew's, so a server a user's own
# tmux already started on the app's socket still talks to this client.
#
# Like build-agent-desktop.sh, the binary is written under each name Tauri may
# ask for: per architecture, and lipo'd universal for the team DMG. Building
# takes a minute, so it is skipped while the staged binaries are this version.
# Output is gitignored.
set -euo pipefail

tmux_version=3.7c
tmux_sha256=7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf
libevent_version=2.1.13-stable
libevent_sha256=f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c
utf8proc_version=2.12.0
utf8proc_sha256=f564011d38b2888d583d510b08e69ffa15aa117155db1b9b49ef1dfe1fa25111
# tmux requires a choice on macOS and recommends jemalloc: the system calloc(3)
# appears not to zero some allocations.
jemalloc_version=5.4.0
jemalloc_sha256=200776fac271093e7c2f21edd6d62657ecd2be578d9328633f2a86bfa6ef4f1d
# The oldest macOS the sidecars support: the Go agent's floor.
export MACOSX_DEPLOYMENT_TARGET=11.0

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out_dir="$repo_root/runtime-desktop/src-tauri/binaries"
stamp="$out_dir/.tmux-$tmux_version"
targets=(aarch64-apple-darwin x86_64-apple-darwin universal-apple-darwin)

current=1
for target in "${targets[@]}"; do
  [ -x "$out_dir/tmux-$target" ] || current=0
done
if [ "$current" = 1 ] && [ -f "$stamp" ]; then
  echo "desktop tmux $tmux_version sidecars are current"
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch() { # url sha256 file
  curl -fsSL --retry 3 "$1" -o "$work/$3"
  echo "$2  $work/$3" | shasum -a 256 -c - >/dev/null
}
fetch "https://github.com/tmux/tmux/releases/download/$tmux_version/tmux-$tmux_version.tar.gz" "$tmux_sha256" tmux.tar.gz
fetch "https://github.com/libevent/libevent/releases/download/release-$libevent_version/libevent-$libevent_version.tar.gz" "$libevent_sha256" libevent.tar.gz
fetch "https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v$utf8proc_version.tar.gz" "$utf8proc_sha256" utf8proc.tar.gz
fetch "https://github.com/jemalloc/jemalloc/releases/download/$jemalloc_version/jemalloc-$jemalloc_version.tar.bz2" "$jemalloc_sha256" jemalloc.tar.bz2

jobs="$(sysctl -n hw.ncpu)"
for arch in arm64 x86_64; do
  # A cross build can't probe the page size, so jemalloc is told it.
  case "$arch" in
    arm64) host=aarch64-apple-darwin lg_page=14 ;;
    x86_64) host=x86_64-apple-darwin lg_page=12 ;;
  esac
  src="$work/$arch/src"
  prefix="$work/$arch/prefix"
  mkdir -p "$src" "$prefix/lib" "$prefix/include"
  for name in tmux libevent utf8proc jemalloc; do
    tar -xf "$work/$name.tar."* -C "$src"
  done
  flags="-arch $arch -mmacosx-version-min=$MACOSX_DEPLOYMENT_TARGET -O2"
  # Only what is built here: never a Homebrew library found through pkg-config.
  export PKG_CONFIG_PATH="$prefix/lib/pkgconfig" PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"

  (
    cd "$src/libevent-$libevent_version"
    ./configure --host="$host" --prefix="$prefix" --disable-shared --enable-static \
      --disable-openssl --disable-samples --disable-libevent-regress --disable-debug-mode \
      CFLAGS="$flags" >/dev/null
    make -j"$jobs" >/dev/null
    make install >/dev/null
  )

  (
    cd "$src/utf8proc-$utf8proc_version"
    make -j"$jobs" libutf8proc.a CFLAGS="$flags" >/dev/null
    cp libutf8proc.a "$prefix/lib/"
    cp utf8proc.h "$prefix/include/"
  )

  (
    cd "$src/jemalloc-$jemalloc_version"
    ./configure --host="$host" --prefix="$prefix" --with-lg-page="$lg_page" \
      --with-jemalloc-prefix= --disable-cxx --disable-stats --disable-doc CFLAGS="$flags" >/dev/null
    make -j"$jobs" build_lib_static >/dev/null
    make install_include install_lib_static >/dev/null
  )

  (
    cd "$src/tmux-$tmux_version"
    # -force_load: jemalloc takes over malloc through a constructor, which a
    # plain static link would drop as unreferenced.
    ./configure --host="$host" --enable-utf8proc --enable-jemalloc \
      CFLAGS="$flags -I$prefix/include" LDFLAGS="-arch $arch" \
      LIBEVENT_CORE_CFLAGS="-I$prefix/include" LIBEVENT_CORE_LIBS="$prefix/lib/libevent_core.a" \
      LIBUTF8PROC_CFLAGS="-I$prefix/include" LIBUTF8PROC_LIBS="$prefix/lib/libutf8proc.a" \
      JEMALLOC_CFLAGS="-I$prefix/include" JEMALLOC_LIBS="-Wl,-force_load,$prefix/lib/libjemalloc.a" >/dev/null
    make -j"$jobs" >/dev/null
  )
  cp "$src/tmux-$tmux_version/tmux" "$work/tmux-$arch"
done

# Nothing outside the system: a user's Mac has no Homebrew to load from.
for arch in arm64 x86_64; do
  if otool -L "$work/tmux-$arch" | tail -n +2 | grep -v '^\s*/usr/lib/' >&2; then
    echo "tmux-$arch links a library outside /usr/lib" >&2
    exit 1
  fi
done

mkdir -p "$out_dir"
rm -f "$out_dir"/.tmux-*
cp "$work/tmux-arm64" "$out_dir/tmux-aarch64-apple-darwin"
cp "$work/tmux-x86_64" "$out_dir/tmux-x86_64-apple-darwin"
lipo -create -output "$out_dir/tmux-universal-apple-darwin" "$work/tmux-arm64" "$work/tmux-x86_64"
touch "$stamp"

echo "built desktop tmux $tmux_version sidecars in $out_dir"
