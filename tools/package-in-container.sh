#!/usr/bin/env bash
set -euo pipefail
cargo build --locked --release -p hdlview-desktop --features custom-protocol
cargo build --locked --release -p hdlview
version=$(sed -n 's/^version = "\(.*\)"/\1/p' src-tauri/Cargo.toml)
package_dir=target/linux-package
rm -rf "$package_dir"
mkdir -p "$package_dir/DEBIAN" "$package_dir/usr/bin" "$package_dir/usr/share/applications" "$package_dir/usr/share/icons/hicolor/64x64/apps" "$package_dir/usr/share/doc/hdlview" "$package_dir/usr/share/hdlview"
install -m755 "${CARGO_TARGET_DIR}/release/hdlview-desktop" "$package_dir/usr/bin/hdlview-desktop"
install -m755 "${CARGO_TARGET_DIR}/release/hdlview" "$package_dir/usr/bin/hdlview"
strip "$package_dir/usr/bin/hdlview-desktop" "$package_dir/usr/bin/hdlview"
install -m644 src-tauri/icons/icon.png "$package_dir/usr/share/icons/hicolor/64x64/apps/hdlview.png"
install -m644 LICENSE README.md docs/DEPENDENCIES.md docs/QUALIFICATION.md docs/THIRD_PARTY_NOTICES.md "$package_dir/usr/share/doc/hdlview/"
cp -r examples tools/profiles "$package_dir/usr/share/hdlview/"
cat > "$package_dir/DEBIAN/control" <<CONTROL
Package: hdlview
Version: $version
Architecture: amd64
Maintainer: HDLView contributors
Depends: libwebkit2gtk-4.1-0, libgtk-3-0, libglib2.0-bin, libssl3, libstdc++6, libc6 (>= 2.35)
Section: electronics
Priority: optional
Description: HDL schematic and waveform exploration
 Local desktop application with immutable HDL snapshots and bidirectional probing.
CONTROL
cat > "$package_dir/usr/share/applications/hdlview.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=HDLView
Exec=hdlview-desktop
Icon=hdlview
Terminal=false
Categories=Development;Electronics;
DESKTOP
mkdir -p target/packages
dpkg-deb --root-owner-group --build "$package_dir" "target/packages/hdlview_${version}_amd64.deb"
