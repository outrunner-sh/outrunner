/** npm's global install of `pkg`. With `sudo` (where the installer isn't
 *  root), only when what the install writes (the global node_modules and the
 *  prefix's bin) isn't the user's: a prefix they own (nvm's) would be left with
 *  root's files, and a later install without sudo would fail on them. Through
 *  `env` with this shell's PATH:
 *  sudo swaps the PATH for its own secure_path, which leaves out wherever the
 *  image put node and npm (not /usr/bin on Daytona's), so a bare `sudo npm` is
 *  "command not found". */
export function npmInstallGlobal(pkg: string, { sudo }: { sudo: boolean }): string {
  const install = `npm install -g ${pkg}`;
  if (!sudo) return install;
  const writable = `[ -w "$(npm root -g)" ] && [ -w "$(npm prefix -g)/bin" ]`;
  return `{ if ${writable}; then ${install}; else sudo env "PATH=$PATH" ${install}; fi; }`;
}
