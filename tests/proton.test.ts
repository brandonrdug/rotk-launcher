import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildProtonCommand,
  listProtonRuntimes,
  mergeDllOverrides,
  sortProtonRuntimes,
  toWinePath,
} from "../electron/services/proton.js";

const roots: string[] = [];

async function fakeRuntime(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "proton"), "#!/bin/sh\n");
  await chmod(join(directory, "proton"), 0o755);
}

async function fakeSteam(): Promise<{ home: string; steam: string; library: string }> {
  const home = await mkdtemp(join(tmpdir(), "rotk-proton-"));
  roots.push(home);
  const steam = join(home, ".local", "share", "Steam");
  const library = join(home, "SteamLibrary");
  await mkdir(join(steam, "steamapps"), { recursive: true });
  await writeFile(
    join(steam, "steamapps", "libraryfolders.vdf"),
    `"libraryfolders"\n{\n  "0" { "path" "${steam}" }\n  "1" { "path" "${library}" }\n}\n`,
  );
  return { home, steam, library };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("toWinePath", () => {
  it("maps POSIX paths onto the Z: drive", () => {
    expect(toWinePath("/home/user/.config/ROTK Launcher/logs")).toBe("Z:\\home\\user\\.config\\ROTK Launcher\\logs");
  });

  it("leaves Windows and relative paths unchanged", () => {
    expect(toWinePath("C:\\Games\\ROTK")).toBe("C:\\Games\\ROTK");
    expect(toWinePath("logs")).toBe("logs");
  });
});

describe("sortProtonRuntimes", () => {
  it("prefers GE-Proton, then official releases, compared numerically", () => {
    const sorted = sortProtonRuntimes([
      { name: "Proton 9.0 (Beta)" },
      { name: "Proton - Experimental" },
      { name: "GE-Proton9-20" },
      { name: "Proton 10.0" },
      { name: "GE-Proton10-27" },
      { name: "Proton 11.0" },
    ]).map((runtime) => runtime.name);
    expect(sorted).toEqual([
      "GE-Proton10-27", "GE-Proton9-20", "Proton 11.0", "Proton 10.0", "Proton 9.0 (Beta)", "Proton - Experimental",
    ]);
  });
});

describe("mergeDllOverrides", () => {
  it("forces the native dinput8 proxy without dropping user overrides", () => {
    expect(mergeDllOverrides(undefined)).toBe("dinput8=n,b");
    expect(mergeDllOverrides("d3d11=n,b")).toBe("d3d11=n,b;dinput8=n,b");
    expect(mergeDllOverrides("dinput8=b")).toBe("dinput8=b");
  });
});

describe("listProtonRuntimes", () => {
  it("finds compatibility tools and library runtimes, skipping helper runtimes", async () => {
    const { home, steam, library } = await fakeSteam();
    await fakeRuntime(join(steam, "compatibilitytools.d", "GE-Proton10-27"));
    await fakeRuntime(join(library, "steamapps", "common", "Proton 11.0"));
    await fakeRuntime(join(library, "steamapps", "common", "Proton BattlEye Runtime"));
    await mkdir(join(library, "steamapps", "common", "Proton 10.0"), { recursive: true });

    const runtimes = await listProtonRuntimes({ HOME: home, XDG_DATA_HOME: join(home, ".local", "share") });
    expect(runtimes.map((runtime) => runtime.name)).toEqual(["GE-Proton10-27", "Proton 11.0"]);
    expect(runtimes[0]!.steamRoot).toBe(steam);
  });
});

describe("buildProtonCommand", () => {
  it("wraps the executable in proton run and prepares the prefix", async () => {
    const { home, steam } = await fakeSteam();
    await fakeRuntime(join(steam, "compatibilitytools.d", "GE-Proton10-27"));
    const prefix = join(home, "prefix");
    const command = await buildProtonCommand({
      executable: "/games/ROTK/H1Z1.exe",
      args: ["sessionid=abc"],
      env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), ROTK_PROTON_PREFIX: prefix, STEAMID: "1" },
      installationRoot: "/games/ROTK",
    });
    expect(command.command).toBe(join(steam, "compatibilitytools.d", "GE-Proton10-27", "proton"));
    expect(command.args).toEqual(["run", "/games/ROTK/H1Z1.exe", "sessionid=abc"]);
    expect(command.env).toMatchObject({
      STEAM_COMPAT_DATA_PATH: prefix,
      STEAM_COMPAT_CLIENT_INSTALL_PATH: steam,
      STEAM_COMPAT_INSTALL_PATH: "/games/ROTK",
      WINEDLLOVERRIDES: "dinput8=n,b",
      STEAMID: "1",
    });
  });

  it("names Proton when no runtime is installed", async () => {
    const { home } = await fakeSteam();
    await expect(buildProtonCommand({
      executable: "/games/ROTK/H1Z1.exe",
      args: [],
      env: { HOME: home, XDG_DATA_HOME: join(home, ".local", "share"), ROTK_STEAM_ROOT: join(home, "none") },
      installationRoot: "/games/ROTK",
    })).rejects.toThrow(/Proton/);
  });
});
