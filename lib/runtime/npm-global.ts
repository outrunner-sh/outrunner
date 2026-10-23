/** npm's global install of `pkg`. `sudo` where the installer isn't root, and
 *  then through `env` with this shell's PATH: sudo swaps the PATH for its own
 *  secure_path, which leaves out wherever the image put node and npm (not
 *  /usr/bin on Daytona's), so a bare `sudo npm` is "command not found". */
export function npmInstallGlobal(pkg: string, { sudo }: { sudo: boolean }): string {
  return `${sudo ? `sudo env "PATH=$PATH" ` : ""}npm install -g ${pkg}`;
}
