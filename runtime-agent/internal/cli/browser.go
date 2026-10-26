package cli

import (
	"os"
	"os/exec"
	"runtime"
)

// openBrowser is what the commands open URLs with: OpenBrowser, swapped for
// a fake browser in tests.
var openBrowser = OpenBrowser

// OpenBrowser opens a URL in the user's browser. OUTRUNNER_NO_BROWSER=1
// skips it (a remote shell, a test): the URL is printed either way.
func OpenBrowser(url string) error {
	if os.Getenv("OUTRUNNER_NO_BROWSER") == "1" {
		return nil
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	return cmd.Start()
}
