/**
 * Linux launch path: H1Z1 is a Windows PE, so on Linux it runs through a
 * Proton runtime from the local Steam installation (`proton run H1Z1.exe …`).
 *
 * Only the process wrapper changes. The executable, its arguments, the working
 * directory and the environment the launcher prepared stay the same; POSIX
 * paths handed to the client are translated to their Wine `Z:` form because
 * the client resolves them as Windows paths.
 *
 * Runtime selection, most preferred first:
 *   1. `ROTK_PROTON_DIR`, a directory containing the `proton` script;
 *   2. the newest GE-Proton under a Steam `compatibilitytools.d`;
 *   3. the newest official `Proton N.M` of any Steam library;
 *   4. `Proton - Experimental` / `Proton Hotfix`.
 * Versions compare numerically: "Proton 9.0" must not outrank "Proton 10.0".
 *
 * The Wine prefix is dedicated to ROTK (`ROTK_PROTON_PREFIX`, default
 * `$XDG_DATA_HOME/rotk-launcher/proton`) so it never touches the prefix Steam
 * keeps for the live game.
 */

import { constants as fsConstants } from "node:fs";
import { access, mkdir, readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { linuxSteamRoots, parseLibraryFoldersVdf } from "./steam-paths.js";

export interface ProtonRuntime {
  /** Directory holding the `proton` script. */
  directory: string;
  /** Display name, e.g. "GE-Proton10-27" or "Proton 11.0". */
  name: string;
  /** Steam root the runtime was found under (STEAM_COMPAT_CLIENT_INSTALL_PATH). */
  steamRoot: string;
}

export interface ProtonCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  runtime: ProtonRuntime;
}

/**
 * The Wine path of a POSIX path (`/a/b` → `Z:\a\b`). A value that already
 * carries a drive letter is returned unchanged, so Windows paths pass through.
 */
export function toWinePath(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) return value;
  if (!value.startsWith("/")) return value;
  return `Z:${value.replace(/\//g, "\\")}`;
}

/** Numeric version components of a runtime name: "GE-Proton10-27" → [10, 27]. */
export function protonVersion(name: string): number[] {
  return (name.match(/\d+/g) ?? []).map((part) => Number.parseInt(part, 10));
}

function compareVersionsDescending(left: string, right: string): number {
  const a = protonVersion(left);
  const b = protonVersion(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (b[index] ?? -1) - (a[index] ?? -1);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Preference class of a runtime name; lower is preferred. */
function runtimeRank(name: string): number {
  if (/^GE-Proton\d/i.test(name)) return 0;
  if (/^Proton \d/i.test(name)) return 1;
  if (/^Proton - Experimental$/i.test(name)) return 2;
  if (/^Proton Hotfix$/i.test(name)) return 3;
  return 4;
}

export function sortProtonRuntimes<T extends { name: string }>(runtimes: readonly T[]): T[] {
  return [...runtimes].sort((left, right) =>
    runtimeRank(left.name) - runtimeRank(right.name) || compareVersionsDescending(left.name, right.name));
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listDirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
}

async function steamLibraries(steamRoot: string): Promise<string[]> {
  const libraries = [steamRoot];
  const manifest = await readFile(join(steamRoot, "steamapps", "libraryfolders.vdf"), "utf8").catch(() => null);
  if (manifest) libraries.push(...parseLibraryFoldersVdf(manifest));
  return [...new Set(libraries.map((library) => normalize(library)))];
}

/** Every usable Proton runtime of the local Steam installations, best first. */
export async function listProtonRuntimes(env: NodeJS.ProcessEnv = process.env): Promise<ProtonRuntime[]> {
  const found: ProtonRuntime[] = [];
  const seen = new Set<string>();
  const add = async (directory: string, name: string, steamRoot: string): Promise<void> => {
    // ~/.steam/steam is usually a link to ~/.local/share/Steam: count each
    // runtime once, under the first root that reached it.
    const key = await realpath(directory).catch(() => normalize(directory));
    if (seen.has(key) || !(await isExecutableFile(join(directory, "proton")))) return;
    seen.add(key);
    found.push({ directory: normalize(directory), name, steamRoot });
  };

  for (const steamRoot of linuxSteamRoots(env)) {
    if (!(await stat(steamRoot).then((info) => info.isDirectory(), () => false))) continue;
    for (const name of await listDirectories(join(steamRoot, "compatibilitytools.d"))) {
      await add(join(steamRoot, "compatibilitytools.d", name), name, steamRoot);
    }
    for (const library of await steamLibraries(steamRoot)) {
      for (const name of await listDirectories(join(library, "steamapps", "common"))) {
        if (!/^proton/i.test(name) || /runtime|voice/i.test(name)) continue;
        await add(join(library, "steamapps", "common", name), name, steamRoot);
      }
    }
  }
  return sortProtonRuntimes(found);
}

/** The runtime a launch uses: the `ROTK_PROTON_DIR` pin, else the best found. */
export async function locateProtonRuntime(env: NodeJS.ProcessEnv = process.env): Promise<ProtonRuntime | null> {
  const pinned = env.ROTK_PROTON_DIR?.trim();
  if (pinned) {
    if (!isAbsolute(pinned) || !(await isExecutableFile(join(pinned, "proton")))) {
      throw new Error(`ROTK_PROTON_DIR does not contain an executable proton script: ${pinned}`);
    }
    const steamRoot = (await Promise.all(linuxSteamRoots(env).map(async (root) =>
      (await stat(root).then((info) => info.isDirectory(), () => false)) ? root : null))).find(Boolean);
    return { directory: normalize(pinned), name: pinned.split("/").filter(Boolean).pop() ?? pinned, steamRoot: steamRoot ?? pinned };
  }
  return (await listProtonRuntimes(env))[0] ?? null;
}

export function defaultProtonPrefix(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): string {
  const pinned = env.ROTK_PROTON_PREFIX?.trim();
  if (pinned && isAbsolute(pinned)) return normalize(pinned);
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "rotk-launcher", "proton");
}

/**
 * DLLs the launcher deploys next to H1Z1.exe that Wine also ships as
 * builtins. Wine prefers its builtin copy unless told otherwise, which would
 * silently drop the gameplay proxy.
 */
const NATIVE_DLL_OVERRIDES = ["dinput8"] as const;

export function mergeDllOverrides(existing: string | undefined): string {
  const entries = (existing ?? "").split(";").map((entry) => entry.trim()).filter(Boolean);
  const named = new Set(entries.flatMap((entry) => entry.split("=")[0]!.split(",").map((dll) => dll.trim().toLowerCase())));
  for (const dll of NATIVE_DLL_OVERRIDES) if (!named.has(dll)) entries.push(`${dll}=n,b`);
  return entries.join(";");
}

/** Wrap a Windows executable launch in `proton run`, preparing the prefix. */
export async function buildProtonCommand(input: {
  executable: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  installationRoot: string;
}): Promise<ProtonCommand> {
  const runtime = await locateProtonRuntime(input.env);
  if (!runtime) {
    throw new Error(
      "No Proton runtime was found. Install GE-Proton or Proton from Steam, or set ROTK_PROTON_DIR.",
    );
  }
  const prefix = defaultProtonPrefix(input.env);
  // Proton locks `<prefix>/pfx.lock` before creating anything: a missing
  // parent makes it exit 1 with a bare FileNotFoundError.
  await mkdir(prefix, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...input.env,
    STEAM_COMPAT_DATA_PATH: prefix,
    STEAM_COMPAT_CLIENT_INSTALL_PATH: runtime.steamRoot,
    STEAM_COMPAT_INSTALL_PATH: input.installationRoot,
    WINEDLLOVERRIDES: mergeDllOverrides(input.env.WINEDLLOVERRIDES),
  };
  return {
    command: join(runtime.directory, "proton"),
    args: ["run", input.executable, ...input.args],
    env,
    runtime,
  };
}
