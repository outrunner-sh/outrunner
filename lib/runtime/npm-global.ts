/** npm's global install of `pkg`. With `sudo` (where the installer isn't
 *  root), tried without it first where the global node_modules is the user's:
 *  a prefix they own (nvm's) would be left with root's files, and a later
 *  install without sudo would fail on them. Root's node_modules (Daytona's) goes
 *  straight to sudo, without an install sure to fail first. A failed try (a
 *  package a root install left there) is quiet, so the error is sudo's; and
 *  sudo runs through `env` with this shell's PATH: it swaps the PATH for its
 *  own secure_path, which leaves out wherever the image put node and npm (not
 *  /usr/bin on Daytona's), so a bare `sudo npm` is "command not found". */
export function npmInstallGlobal(pkg: string, { sudo }: { sudo: boolean }): string {
  const install = `npm install -g ${pkg}`;
  if (!sudo) return install;
  return `{ { [ -w "$(npm root -g)" ] && ${install} >/dev/null 2>&1; } || sudo env "PATH=$PATH" ${install}; }`;
}
