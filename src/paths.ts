// bo's own directories (XDG base directories): configuration people edit, state bo writes.

import os from "node:os";
import path from "node:path";

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME || os.homedir();
}

/** `$XDG_CONFIG_HOME/bo`: `config.toml`. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_CONFIG_HOME || path.join(home(env), ".config"), "bo");
}

/** `$XDG_STATE_HOME/bo`: the session index and the Codex home. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.XDG_STATE_HOME || path.join(home(env), ".local", "state"), "bo");
}
