/** npm's global install of `pkg`. With `sudo` (where the installer isn't
 *  root), tried without it first: a prefix the user owns (nvm's) would be left
 *  with root's files, and a later install without sudo would fail on them.
 *  Only a failed install (root's prefix, or a package a root install left
 *  there) goes again through sudo, and through `env` with this shell's PATH:
 *  sudo swaps the PATH for its own secure_path, which leaves out wherever the
 *  image put node and npm (not /usr/bin on Daytona's), so a bare `sudo npm` is
 *  "command not found". */
export function npmInstallGlobal(pkg: string, { sudo }: { sudo: boolean }): string {
  const install = `npm install -g ${pkg}`;
  if (!sudo) return install;
  return `{ ${install} || sudo env "PATH=$PATH" ${install}; }`;
}
