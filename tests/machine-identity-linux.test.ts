import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { edidSerial, readLinuxHwid } from "../electron/services/machine-identity-linux.js";

const roots: string[] = [];

async function put(root: string, path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function link(root: string, path: string, target: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await symlink(target, join(root, path));
}

/** A fake / with the root filesystem on nvme0n1p2. */
async function fakeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rotk-hwid-"));
  roots.push(root);
  const disk = "sys/devices/pci0000:00/nvme/nvme0/nvme0n1";
  await put(root, "proc/self/mountinfo",
    "23 1 0:25 /@ / rw,relatime shared:1 - btrfs /dev/nvme0n1p2 rw,ssd\n"
    + "40 23 0:30 / /home rw shared:2 - btrfs /dev/sda1 rw\n");
  await put(root, "dev/nvme0n1p2", "");
  await put(root, `${disk}/dev`, "259:0\n");
  await put(root, `${disk}/device/serial`, "  S6XNNS0T123456  \n");
  await put(root, `${disk}/device/model`, "Samsung SSD 990 PRO 2TB\n");
  await put(root, `${disk}/nvme0n1p2/partition`, "2\n");
  await link(root, "sys/class/block/nvme0n1p2", join(root, disk, "nvme0n1p2"));
  await link(root, "dev/disk/by-uuid/0f3c2a1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b", "../../nvme0n1p2");
  await put(root, "run/udev/data/b259:0", "E:ID_REVISION=4B2QJXD7\n");
  await put(root, "etc/machine-id", "0123456789abcdef0123456789abcdef\n");
  await put(root, "sys/class/dmi/id/bios_date", "03/11/2026\n");
  await put(root, "proc/cpuinfo", "processor\t: 0\nmodel name\t: AMD Ryzen 7 7800X3D 8-Core Processor\n");
  await put(root, "sys/devices/net/eno1/address", "a8:a1:59:00:00:01\n");
  await link(root, "sys/class/net/eno1", join(root, "sys/devices/net/eno1"));
  await link(root, "sys/devices/net/eno1/device", "../../pci0000:00");
  await put(root, "sys/devices/virtual/net/lo/address", "00:00:00:00:00:00\n");
  await link(root, "sys/class/net/lo", join(root, "sys/devices/virtual/net/lo"));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("readLinuxHwid", () => {
  it("reads the system disk, volume and machine facts without elevation", async () => {
    const root = await fakeRoot();
    const vector = await readLinuxHwid([
      "machine_guid", "disk_serial", "disk_model", "disk_firmware", "volume_serial",
      "bios_release_date", "cpu_name", "mac_addresses", "smbios_uuid",
    ], root);
    expect(vector).toEqual({
      machine_guid: "0123456789abcdef0123456789abcdef",
      disk_serial: "S6XNNS0T123456",
      disk_model: "Samsung SSD 990 PRO 2TB",
      disk_firmware: "4B2QJXD7",
      volume_serial: "0f3c2a1e-5b6d-4e7f-8a9b-0c1d2e3f4a5b",
      bios_release_date: "2026-03-11",
      cpu_name: "AMD Ryzen 7 7800X3D 8-Core Processor",
      mac_addresses: "A8:A1:59:00:00:01",
      smbios_uuid: undefined,
    });
  });
});

describe("edidSerial", () => {
  it("reads the 0xFF serial descriptor", () => {
    const edid = Buffer.alloc(128);
    edid.set([0, 0, 0, 0xff, 0], 72);
    edid.write("ABC123\n     ", 77, "latin1");
    expect(edidSerial(edid)).toBe("ABC123");
    expect(edidSerial(Buffer.alloc(128))).toBeUndefined();
  });
});
