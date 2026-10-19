# Linux (unofficial)

This branch runs the ROTK launcher natively on Linux (Electron) and starts
`H1Z1.exe` through a Proton runtime from your Steam installation. It is **not
supported by the ROTK team**: upstream declined Linux support
(h1z1rotk/rotk-launcher#52), so report Linux problems here, not upstream.
The changes are small and platform-gated so the branch rebases cleanly onto
each upstream release; Windows behaviour is unchanged.

## Requirements

- Z1 Battle Royale installed through Steam (the launcher copies it to
  `~/Games/ROTK`; the Steam copy is never modified).
- A Proton runtime in Steam: GE-Proton in `compatibilitytools.d` or an official
  Proton.
- Node.js 22+ and npm to build.
- A Secret Service keyring (gnome-keyring, KWallet) to store the player key.
- Read access to two SMBIOS fields the server requires (see below).

## Install / update

```sh
git clone -b linux https://github.com/brandonrdug/rotk-launcher.git
cd rotk-launcher
scripts/linux/install.sh            # build + install this checkout
scripts/linux/install.sh --update   # rebase onto the newest upstream release tag, then install
```

This installs to `~/.local/opt/rotk-launcher`, links `~/.local/bin/rotk-launcher`
and adds a desktop entry. The in-app updater only knows the Windows installer,
so it is disabled on Linux: when the server asks for a newer launcher, run the
`--update` form (it rebases your local branch; nothing is downloaded but
upstream's source).

## Hardware fingerprint (`hwid_required`)

Every launch sends a hardware fingerprint that the ROTK server keyed-hashes for
ban enforcement; launches without the core identifiers are refused with
`hwid_required`. On Linux the launcher reads the **real** values of the same
hardware facts the Windows WMI queries read, from sysfs/procfs/udev, with no
shell and no elevation: `/etc/machine-id`, the system disk's serial, model and
firmware, the root filesystem UUID, SMBIOS system UUID and baseboard serial,
board name, BIOS version/date, SKU, CPU name, physical MAC addresses and
monitor EDID serials. Nothing is invented; a fact that cannot be read is left
out.

The kernel makes the SMBIOS system UUID and baseboard serial root-only, and the
server requires both. Grant read access once (persists across reboots; delete
the file to undo):

```sh
sudo install -m 0644 scripts/linux/rotk-launcher-dmi.conf /etc/tmpfiles.d/
sudo systemd-tmpfiles --create /etc/tmpfiles.d/rotk-launcher-dmi.conf
```

This lets any local program read those two serials, as Windows already does.

## How the game is launched

- Runtime: newest GE-Proton in `compatibilitytools.d`, else the newest official
  `Proton N.M`, else Experimental. Pin one with `ROTK_PROTON_DIR=/path/to/proton-dir`.
- Prefix: `~/.local/share/rotk-launcher/proton` (`ROTK_PROTON_PREFIX` to move it),
  separate from Steam's prefix for the live game.
- `WINEDLLOVERRIDES` gets `dinput8=n,b` so Wine loads the gameplay proxy instead
  of its builtin `dinput8`.
- Log directories passed to the client are translated to `Z:\…` paths.
- Proton variables in the launcher's environment (`PROTON_LOG=1`,
  `PROTON_ENABLE_WAYLAND=1`, …) reach the game.

## Keyring

On desktops Chromium does not recognise (Hyprland, Sway, …) it falls back to a
plain-text store and `safeStorage` refuses to save the player key. The launcher
therefore asks for `--password-store=gnome-libsecret` (or `kwallet6` on KDE).

## Not available on Linux

- Native diagnostics (`ROTK.Diagnostics.exe`, PresentMon). Debug reports still
  collect text logs.
- TPM anchor: Windows Platform Crypto Provider only. The server currently only
  logs its absence; if ROTK starts requiring it, or a Windows-only anti-cheat,
  this branch will stop working.

## The bundled `rotkc.dll` module

Since 2.0.40 the launcher ships `rotkc.dll`, a ROTK anti-cheat module that the
voice proxy loads into the game. It is an ordinary user-mode DLL and loads
fine under Proton (verified on 2.0.43 with GE-Proton10-27). The launcher's
Windows-only Visual C++ runtime check is skipped on Linux because Proton
provides that runtime. Whether ROTK treats Wine/Proton sessions differently
is theirs to decide; this branch does nothing to hide that it runs there.

## Troubleshooting

- `The ROTK account service refused the launch request (HTTP 403, <code>)`
  names the server's reason. `hwid_required`: see the fingerprint section.
- Game does not start: run `PROTON_LOG=1 rotk-launcher` and read `~/steam-*.log`.
