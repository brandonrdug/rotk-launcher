import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { promisify } from "node:util";
import { validateClientSource } from "./path-policy.js";
import { linuxSteamRoots, parseLibraryFoldersVdf } from "./steam-paths.js";

export { parseLibraryFoldersVdf } from "./steam-paths.js";

const execFileAsync = promisify(execFile);

/**
 * Steam directory names the H1Z1 client shipped under across its renames.
 * Every candidate is still validated by content (H1Z1.exe, ClientConfig.ini,
 * steam_api64.dll), so an unrelated folder with a matching name is rejected.
 */
export const STEAM_GAME_DIRECTORY_CANDIDATES = [
  "H1Z1",
  "Z1 Battle Royale",
  "H1Z1 King of the Kill",
] as const;

/** Steam app id of H1Z1 (listed as "Z1 Battle Royale"). */
export const H1Z1_STEAM_APP_ID = "433850";

export interface SteamLocatorDependencies {
  readRegistrySteamPath(): Promise<string | null>;
  readTextFile(path: string): Promise<string | null>;
  directoryExists(path: string): Promise<boolean>;
  validateCandidate(path: string): Promise<string>;
  programFilesX86: string | null;
  programFiles: string | null;
  /** Extra Steam roots searched after the registry ones (Linux installs). */
  extraSteamRoots?: readonly string[];
}

async function readRegistrySteamPathFromWindows(): Promise<string | null> {
  if (process.platform !== "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "reg",
      ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"],
      { windowsHide: true },
    );
    const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

const DEFAULT_DEPENDENCIES: SteamLocatorDependencies = {
  readRegistrySteamPath: readRegistrySteamPathFromWindows,
  readTextFile: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  },
  directoryExists: async (path) => {
    try {
      await access(path, fsConstants.R_OK);
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
  validateCandidate: validateClientSource,
  programFilesX86: process.platform === "win32"
    ? process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)"
    : null,
  programFiles: process.platform === "win32" ? process.env.ProgramFiles ?? null : null,
  extraSteamRoots: process.platform === "linux" ? linuxSteamRoots() : [],
};

/**
 * Best-effort discovery of an installed H1Z1 client: Steam root from the
 * registry (with Program Files fallbacks), every library declared in
 * libraryfolders.vdf, then each known game directory name. Returns the first
 * candidate that passes the client-source validation, or null.
 */
export async function locateSteamClient(
  overrides: Partial<SteamLocatorDependencies> = {},
): Promise<string | null> {
  const deps: SteamLocatorDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };

  const steamRoots: string[] = [];
  const registrySteamPath = await deps.readRegistrySteamPath();
  if (registrySteamPath) steamRoots.push(normalize(registrySteamPath));
  for (const programFiles of [deps.programFilesX86, deps.programFiles]) {
    if (programFiles) steamRoots.push(join(programFiles, "Steam"));
  }
  steamRoots.push(...(deps.extraSteamRoots ?? []));

  const libraries: string[] = [];
  const seen = new Set<string>();
  const addLibrary = (library: string): void => {
    const key = normalize(library).toLocaleLowerCase("en-US");
    if (seen.has(key)) return;
    seen.add(key);
    libraries.push(normalize(library));
  };

  for (const steamRoot of steamRoots) {
    if (!(await deps.directoryExists(steamRoot))) continue;
    addLibrary(steamRoot);
    const manifest = await deps.readTextFile(join(steamRoot, "steamapps", "libraryfolders.vdf"));
    if (!manifest) continue;
    for (const library of parseLibraryFoldersVdf(manifest)) addLibrary(library);
  }

  for (const library of libraries) {
    // The app manifest names the real folder, whatever the game was called then.
    const appManifest = await deps.readTextFile(
      join(library, "steamapps", `appmanifest_${H1Z1_STEAM_APP_ID}.acf`),
    );
    // StateFlags bit 4 = fully installed; skip a library mid-download or mid-update.
    if (appManifest && !(Number(appManifest.match(/"StateFlags"\s*"(\d+)"/i)?.[1] ?? 0) & 4)) continue;
    const rawInstallDirectory = appManifest?.match(/"installdir"\s*"([^"]+)"/i)?.[1];
    // The manifest is plain text on disk: only accept a bare folder name.
    const installDirectory =
      rawInstallDirectory && !/[\\/]|\.\./.test(rawInstallDirectory) ? rawInstallDirectory : undefined;
    const names = [...new Map(
      [...(installDirectory ? [installDirectory] : []), ...STEAM_GAME_DIRECTORY_CANDIDATES]
        .map((name) => [name.toLocaleLowerCase("en-US"), name] as const),
    ).values()];
    for (const directoryName of names) {
      const candidate = join(library, "steamapps", "common", directoryName);
      try {
        return await deps.validateCandidate(candidate);
      } catch {
        continue;
      }
    }
  }
  return null;
}
