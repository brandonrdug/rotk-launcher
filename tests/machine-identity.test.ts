import { describe, expect, it } from "vitest";
import {
  HWID_CORE_SLOTS,
  HWID_KNOWN_SLOTS,
  buildHwidScript,
  cleanComponent,
  collectHwid,
  parseHwidOutput,
  selectHwidSlots,
} from "../electron/services/machine-identity";

describe("machine identity parsing", () => {
  it("drops placeholder and empty values", () => {
    expect(cleanComponent("  Real-Serial-123 ")).toBe("real-serial-123");
    expect(cleanComponent("")).toBeUndefined();
    expect(cleanComponent("To be filled by O.E.M.")).toBeUndefined();
    expect(cleanComponent("FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF")).toBeUndefined();
    expect(cleanComponent("System Serial Number")).toBeUndefined();
    expect(cleanComponent(null)).toBeUndefined();
  });

  it("reads the script's JSON, one cleaned value per requested slot", () => {
    const stdout = "﻿{\"machine_guid\":\"3F2504E0-4F89-41D3-9A0C-0305E82C3301\",\"disk_serial\":\" S4EW NX0N \",\"bios_serial\":\"To be filled by O.E.M.\",\"gpu_name\":42,\"volume_serial\":\"1A2B3C4D\"}\r\n";
    expect(parseHwidOutput(stdout, ["machine_guid", "disk_serial", "bios_serial", "gpu_name", "volume_serial", "cpu_name"]))
      .toEqual({
        machine_guid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        disk_serial: "s4ew nx0n",
        volume_serial: "1a2b3c4d",
      });
    expect(parseHwidOutput("not json", ["machine_guid"])).toEqual({});
    expect(parseHwidOutput("[1,2]", ["machine_guid"])).toEqual({});
    expect(parseHwidOutput("", ["machine_guid"])).toEqual({});
  });
});

describe("slot selection and script", () => {
  it("knows the core five and the pool the server draws from", () => {
    for (const slot of HWID_CORE_SLOTS) expect(HWID_KNOWN_SLOTS).toContain(slot);
    for (const slot of ["bios_serial", "mac_addresses", "monitor_edid_serials", "cpu_processor_id", "os_install_date"]) {
      expect(HWID_KNOWN_SLOTS).toContain(slot);
    }
  });

  it("reads only the requested slots it knows, once each, in request order", () => {
    expect(selectHwidSlots(["gpu_name", "machine_guid", "gpu_name", "tpm_manufacturer_id", "not a slot; rm -rf"]))
      .toEqual(["gpu_name", "machine_guid"]);
    expect(selectHwidSlots([])).toEqual([]);
  });

  it("builds one script with one guarded reader per slot and nothing from the request text", () => {
    const script = buildHwidScript(["machine_guid", "cpu_name"]);
    expect(script.startsWith("$ErrorActionPreference = 'Stop'\n$r = @{}\n")).toBe(true);
    expect(script.endsWith("$r | ConvertTo-Json -Compress")).toBe(true);
    expect(script).toContain("$r['machine_guid'] = $v");
    expect(script).toContain("Win32_Processor");
    expect(script).not.toContain("Win32_BIOS");
    expect((script.match(/^try \{/gm) ?? []).length).toBe(2);
  });
});

describe("collectHwid", () => {
  it("runs the script for the requested known slots and returns the cleaned vector", async () => {
    if (process.platform !== "win32") return; // gated on win32; collector is a no-op elsewhere
    const scripts: string[] = [];
    const vector = await collectHwid(["machine_guid", "bios_serial", "unknown_slot"], {
      run: async (script) => {
        scripts.push(script);
        return JSON.stringify({ machine_guid: "MG-1", bios_serial: "BIOS-2", volume_serial: "not asked" });
      },
    });
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain("$r['bios_serial']");
    expect(scripts[0]).not.toContain("unknown_slot");
    // A slot the script happens to print but nobody asked for is not answered.
    expect(vector).toEqual({ machine_guid: "mg-1", bios_serial: "bios-2" });
  });

  it("defaults to the core five", async () => {
    if (process.platform !== "win32") return;
    let script = "";
    await collectHwid(undefined, { run: async (s) => { script = s; return "{}"; } });
    for (const slot of HWID_CORE_SLOTS) expect(script).toContain(`$r['${slot}']`);
    expect(script).not.toContain("bios_serial");
  });

  it("asks nothing when no requested slot is known, and never throws", async () => {
    if (process.platform !== "win32") return;
    let ran = false;
    expect(await collectHwid(["nope"], { run: async () => { ran = true; return "{}"; } })).toEqual({});
    expect(ran).toBe(false);
    expect(await collectHwid(["machine_guid"], { run: async () => { throw new Error("wmi failed"); } })).toEqual({});
  });

  it("returns an empty vector off Windows and Linux", async () => {
    if (process.platform === "win32" || process.platform === "linux") return;
    expect(await collectHwid(["machine_guid"], { run: async () => "{}" })).toEqual({});
  });

  it("reads Linux slots from the system instead of PowerShell", async () => {
    if (process.platform !== "linux") return;
    const vector = await collectHwid(["machine_guid", "not_a_slot"], {
      run: async () => { throw new Error("PowerShell must not run on Linux"); },
    });
    expect(Object.keys(vector)).toEqual(["machine_guid"]);
    expect(vector.machine_guid).toMatch(/^[0-9a-f]{32}$/);
  });
});
