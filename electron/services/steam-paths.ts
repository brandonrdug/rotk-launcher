/**
 * Steam path helpers with no process dependencies, shared by the client
 * locator and the Linux Proton launcher.
 */

import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

/**
 * Extract every library root recorded in Steam's libraryfolders.vdf. The
 * parser is intentionally tolerant: it only reads `"path" "..."` pairs and
 * unescapes VDF backslash sequences, because the surrounding structure has
 * changed across Steam versions.
 */
export function parseLibraryFoldersVdf(content: string): string[] {
  const libraries: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(/"path"\s*"((?:\\.|[^"\\])*)"/gi)) {
    const raw = match[1].replace(/\\(.)/g, "$1").trim();
    if (!raw) continue;
    const library = normalize(raw);
    const key = library.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    libraries.push(library);
  }
  return libraries;
}

/** Steam roots of a Linux user: native, legacy symlinks and Flatpak. */
export function linuxSteamRoots(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): string[] {
  const roots = [
    env.ROTK_STEAM_ROOT,
    join(env.XDG_DATA_HOME || join(home, ".local", "share"), "Steam"),
    join(home, ".steam", "steam"),
    join(home, ".steam", "root"),
    join(home, ".var", "app", "com.valvesoftware.Steam", ".local", "share", "Steam"),
  ];
  return roots.filter((root): root is string => typeof root === "string" && root.trim() !== "" && isAbsolute(root));
}
