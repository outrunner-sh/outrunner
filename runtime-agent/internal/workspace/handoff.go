package workspace

// handoffNote tells a cloud box's agent how a file reaches the user, in its
// orientation: the user is at their own computer, which the agent can't
// reach, so "save it to my Downloads" means a link the app turns into a
// download (the web app's /api/workspaces/[id]/download, up to its 6 MB).
// Empty for the desktop app's agent on the user's own Mac, which no control
// plane launched: there the user's files are the agent's.
func (s *Service) handoffNote() string {
	if s.controlPlane == nil {
		return ""
	}
	return "# Handing files to the user\n\n" +
		"The user isn't at this computer: they use Outrunner from their own, which you can't reach. " +
		"You can't save anything there, and this computer's home, Downloads and Desktop are not theirs, so never say a file is on their computer. " +
		"To hand them a file (an image, an export, an archive), save it on this computer outside the repository unless it belongs there, " +
		"and link it in your reply by its path, for example `[icons.zip](~/exports/icons.zip)`: the link downloads it to their computer. " +
		"A link can't carry a file over 6 MB: compress it, or put it where they can reach it (a pull request, a release), and say so."
}
