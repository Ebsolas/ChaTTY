# Arch Linux packages (not on the AUR)

Prebuilt **binary** packages that install ChaTTY from [GitHub Releases](https://github.com/Ebsolas/ChaTTY/releases).

| Directory | Architecture | Source asset |
|-----------|--------------|--------------|
| [`x86_64/`](x86_64/) | Standard Arch (`x86_64`) | `*_linux_x86_64_portable.tar.gz` |
| [`aarch64/`](aarch64/) | Arch Linux ARM / aarch64 | `*_linux_aarch64_portable.tar.gz` |

Package name: **`chatty-bin`** (provides `chatty`).

## Install (pick your arch)

### x86_64

```bash
git clone https://github.com/Ebsolas/ChaTTY.git
cd ChaTTY/packaging/arch/x86_64
makepkg -si
```

With an AUR helper (local package build):

```bash
cd ChaTTY/packaging/arch/x86_64
paru -Bi .
# or
yay -Bi .
```

### aarch64

```bash
git clone https://github.com/Ebsolas/ChaTTY.git
cd ChaTTY/packaging/arch/aarch64
makepkg -si
```

```bash
cd ChaTTY/packaging/arch/aarch64
paru -Bi .
# or
yay -Bi .
```

## What gets installed

| Path | Role |
|------|------|
| `/opt/chatty/` | Portable app tree (binaries + bundled libs) |
| `/usr/bin/chatty` | Launcher |
| `/usr/bin/chatty-host` | Durable session host |
| `/usr/share/applications/chatty.desktop` | Desktop entry |

## Updating after a new release

1. Bump `_tag`, `_appver`, and `pkgver` in the PKGBUILD for your arch.
2. Download the matching portable tarball and set `sha256sums` (`sha256sum` the file).
3. Rebuild: `makepkg -si` (or `paru -Bi .`).

## Requirements

- `base-devel` (for `makepkg`)
- Network access to download the release asset on first build
- Runtime libraries listed in `depends` (WebKit/GTK stack)

These PKGBUILDs do **not** compile from source. For a full toolchain build, use the main README (“Build from source”).
