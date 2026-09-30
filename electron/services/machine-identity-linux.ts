/**
 * Linux readers for the hardware fingerprint slots (see machine-identity.ts).
 *
 * Each slot reads the same hardware fact the Windows WMI query reads, from
 * sysfs, procfs and the udev database, without a shell and without elevation.
 * The SMBIOS system UUID and baseboard serial are core slots the server
 * requires, but the kernel makes them root-only; they are read when the
 * system grants the user access (docs/LINUX.md) and otherwise unanswered.
 * Nothing is approximated: a value that is not the real one would only
 * poison the player's own fingerprint.
 *
 * Every reader is best-effort; a slot that cannot be read is omitted.
 */

import { readdir, readFile, readlink, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type SlotReader = (root: string) => Promise<string | undefined>;

async function readText(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/\0/g, "").trim() || undefined;
  } catch {
    return undefined;
  }
}

const dmi = (root: string, name: string): Promise<string | undefined> =>
  readText(join(root, "sys", "class", "dmi", "id", name));

/** The block device mounted at `/`, from mountinfo (btrfs st_dev is virtual). */
async function rootMountSource(root: string): Promise<string | undefined> {
  const mountinfo = await readText(join(root, "proc", "self", "mountinfo"));
  for (const line of mountinfo?.split("\n") ?? []) {
    const [left, right] = line.split(" - ");
    if (left?.split(" ")[4] !== "/" || !right) continue;
    const source = right.split(" ")[1];
    if (source?.startsWith("/dev/")) return source;
  }
  return undefined;
}

/** sysfs directory of the kernel block device behind a /dev path. */
async function blockDirectory(root: string, devicePath: string): Promise<string | undefined> {
  try {
    const node = basename(await realpath(join(root, devicePath)));
    return await realpath(join(root, "sys", "class", "block", node));
  } catch {
    return undefined;
  }
}

/**
 * The physical disk under a block device: a partition's parent, followed
 * through device-mapper/md `slaves` (LUKS, LVM) to the first real disk.
 */
async function physicalDisk(directory: string, depth = 0): Promise<string | undefined> {
  if (depth > 8) return undefined;
  const slaves = await readdir(join(directory, "slaves")).catch(() => []);
  if (slaves.length > 0) {
    const first = [...slaves].sort()[0]!;
    return physicalDisk(await realpath(join(directory, "slaves", first)), depth + 1);
  }
  if (await readText(join(directory, "partition"))) return dirname(directory);
  return directory;
}

async function systemDisk(root: string): Promise<string | undefined> {
  const source = await rootMountSource(root);
  if (!source) return undefined;
  const directory = await blockDirectory(root, source);
  return directory ? physicalDisk(directory) : undefined;
}

/** A property from the udev database entry of a block device. */
async function udevProperty(root: string, diskDirectory: string, key: string): Promise<string | undefined> {
  const dev = await readText(join(diskDirectory, "dev"));
  if (!dev) return undefined;
  const data = await readText(join(root, "run", "udev", "data", `b${dev}`));
  const line = data?.split("\n").find((entry) => entry.startsWith(`E:${key}=`));
  return line?.slice(key.length + 3).trim() || undefined;
}

function diskReader(sysfsName: string, udevKey: string): SlotReader {
  return async (root) => {
    const disk = await systemDisk(root);
    if (!disk) return undefined;
    return await readText(join(disk, "device", sysfsName)) ?? udevProperty(root, disk, udevKey);
  };
}

/** Filesystem UUID of the volume mounted at `/` (the system drive's volume id). */
async function volumeSerial(root: string): Promise<string | undefined> {
  const source = await rootMountSource(root);
  if (!source) return undefined;
  const target = await realpath(join(root, source)).catch(() => undefined);
  const byUuid = join(root, "dev", "disk", "by-uuid");
  for (const uuid of (await readdir(byUuid).catch(() => [])).sort()) {
    const link = await readlink(join(byUuid, uuid)).catch(() => undefined);
    if (link && target && basename(link) === basename(target)) return uuid;
  }
  return undefined;
}

/** SMBIOS dates are MM/DD/YYYY; Windows reports yyyy-MM-dd. */
async function biosReleaseDate(root: string): Promise<string | undefined> {
  const match = (await dmi(root, "bios_date"))?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[1]}-${match[2]}` : undefined;
}

async function cpuName(root: string): Promise<string | undefined> {
  const cpuinfo = await readText(join(root, "proc", "cpuinfo"));
  return cpuinfo?.match(/^model name\s*:\s*(.+)$/m)?.[1];
}

/** MACs of the physical network adapters (those backed by a device). */
async function macAddresses(root: string): Promise<string | undefined> {
  const net = join(root, "sys", "class", "net");
  const addresses = new Set<string>();
  for (const name of await readdir(net).catch(() => [])) {
    if (!(await readlink(join(net, name, "device")).catch(() => undefined))) continue;
    const address = await readText(join(net, name, "address"));
    if (address && address !== "00:00:00:00:00:00") addresses.add(address.toUpperCase());
  }
  return addresses.size > 0 ? [...addresses].sort().join(",") : undefined;
}

/** EDID serial-number descriptors (tag 0xFF) of the connected monitors. */
export function edidSerial(edid: Buffer): string | undefined {
  if (edid.length < 128) return undefined;
  for (let offset = 54; offset <= 108; offset += 18) {
    if (edid[offset] === 0 && edid[offset + 1] === 0 && edid[offset + 3] === 0xff) {
      const text = edid.subarray(offset + 5, offset + 18).toString("latin1");
      const serial = text.split("\n")[0]!.trim();
      if (serial) return serial;
    }
  }
  return undefined;
}

async function monitorEdidSerials(root: string): Promise<string | undefined> {
  const drm = join(root, "sys", "class", "drm");
  const serials: string[] = [];
  for (const name of await readdir(drm).catch(() => [])) {
    if (!/^card\d+-/.test(name)) continue;
    if ((await readText(join(drm, name, "status"))) !== "connected") continue;
    const edid = await readFile(join(drm, name, "edid")).catch(() => undefined);
    const serial = edid ? edidSerial(edid) : undefined;
    if (serial) serials.push(serial);
  }
  return serials.length > 0 ? serials.sort().join(",") : undefined;
}

export const LINUX_SLOT_READERS: Readonly<Record<string, SlotReader>> = Object.freeze({
  machine_guid: (root) => readText(join(root, "etc", "machine-id")),
  smbios_uuid: (root) => dmi(root, "product_uuid"),
  baseboard_serial: (root) => dmi(root, "board_serial"),
  disk_serial: diskReader("serial", "ID_SERIAL_SHORT"),
  disk_model: diskReader("model", "ID_MODEL"),
  disk_firmware: diskReader("firmware_rev", "ID_REVISION"),
  volume_serial: volumeSerial,
  baseboard_product: (root) => dmi(root, "board_name"),
  bios_version: (root) => dmi(root, "bios_version"),
  bios_release_date: biosReleaseDate,
  system_sku: (root) => dmi(root, "product_sku"),
  cpu_name: cpuName,
  mac_addresses: macAddresses,
  monitor_edid_serials: monitorEdidSerials,
});

/** Raw values for the requested slots this platform can read. */
export async function readLinuxHwid(
  slots: readonly string[],
  root = "/",
): Promise<Record<string, string | undefined>> {
  const entries = await Promise.all(slots.map(async (slot) => {
    const reader = LINUX_SLOT_READERS[slot];
    return [slot, reader ? await reader(root).catch(() => undefined) : undefined] as const;
  }));
  return Object.fromEntries(entries);
}
