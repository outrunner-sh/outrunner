package snapshot

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

// A session of several repositories (a folder of checkouts, one a
// repository, each off its own mirror) is captured as the same two tree
// artifacts as a session of one, each a tar holding one file a checkout:
// the bundle artifact <name>.bundle, the patch artifact <name>.patch. The
// manifest's tree says so (TreeKindCheckouts) and lists the checkouts, so
// the artifact set, its upload and download URLs, are those of every
// Snapshot.

// TreeKindCheckouts is a tree of several checkouts.
const TreeKindCheckouts = "git-bundles+patches"

// checkoutName is a checkout folder: also its file's name in the tars.
var checkoutName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$`)

// Checkout is one repository of a session of several, as captured or
// restored.
type Checkout struct {
	// Name is its folder in the session's.
	Name string
	// FullName is `owner/name`, recorded in the manifest.
	FullName string
	// BaseBranch is the branch it targets, recorded in the manifest.
	BaseBranch string
	// MirrorPath is its mirror on the box, which a restore imports into.
	MirrorPath string
}

// TreeCheckout is a checkout as the manifest records it.
type TreeCheckout struct {
	Name       string  `json:"name"`
	FullName   string  `json:"fullName,omitempty"`
	BaseBranch string  `json:"baseBranch,omitempty"`
	LastCommit *string `json:"lastCommit"`
}

func validCheckouts(checkouts []Checkout) error {
	seen := map[string]bool{}
	for _, c := range checkouts {
		if !checkoutName.MatchString(c.Name) || seen[c.Name] {
			return fmt.Errorf("snapshot: checkout %q", c.Name)
		}
		seen[c.Name] = true
	}
	return nil
}

// buildCheckoutTrees writes the two tars of a folder of checkouts into
// staging, and the manifest's list of them.
func buildCheckoutTrees(ctx context.Context, folder string, checkouts []Checkout, staging string) (bundle, patch string, listed []TreeCheckout, err error) {
	if err := validCheckouts(checkouts); err != nil {
		return "", "", nil, err
	}
	parts := filepath.Join(staging, "checkouts")
	if err := os.MkdirAll(parts, 0o755); err != nil {
		return "", "", nil, err
	}
	var bundles, patches []string
	for _, c := range checkouts {
		dir := filepath.Join(folder, c.Name)
		b, err := buildBundle(ctx, dir, filepath.Join(parts, c.Name+".bundle"))
		if err != nil {
			return "", "", nil, fmt.Errorf("%s: %w", c.Name, err)
		}
		p, err := buildPatch(ctx, dir, filepath.Join(parts, c.Name+".patch"))
		if err != nil {
			return "", "", nil, fmt.Errorf("%s: %w", c.Name, err)
		}
		bundles, patches = append(bundles, b), append(patches, p)
		listed = append(listed, TreeCheckout{Name: c.Name, FullName: c.FullName, BaseBranch: c.BaseBranch, LastCommit: lastCommit(ctx, dir)})
	}
	bundle, patch = filepath.Join(staging, BundleName), filepath.Join(staging, PatchName)
	if err := writeTar(bundle, bundles); err != nil {
		return "", "", nil, err
	}
	if err := writeTar(patch, patches); err != nil {
		return "", "", nil, err
	}
	return bundle, patch, listed, nil
}

// writeTar writes files into a tar at dst, each under its base name.
func writeTar(dst string, files []string) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	tw := tar.NewWriter(out)
	for _, file := range files {
		f, err := os.Open(file)
		if err != nil {
			return err
		}
		info, err := f.Stat()
		if err != nil {
			f.Close()
			return err
		}
		if err := tw.WriteHeader(&tar.Header{Name: filepath.Base(file), Mode: 0o644, Size: info.Size(), Typeflag: tar.TypeReg}); err != nil {
			f.Close()
			return err
		}
		_, err = io.Copy(tw, f)
		f.Close()
		if err != nil {
			return err
		}
	}
	return tw.Close()
}

// extractTar unpacks the files of a tar at src into dir, only those named
// in want (a checkout's file): nothing else, and nothing outside dir. A
// file it lacks is absent (an empty patch, say).
func extractTar(src, dir string, want map[string]bool) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tr := tar.NewReader(in)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("read tar: %w", err)
		}
		if h.Typeflag != tar.TypeReg || !want[h.Name] {
			continue
		}
		out, err := os.Create(filepath.Join(dir, h.Name))
		if err != nil {
			return err
		}
		_, err = io.Copy(out, tr)
		out.Close()
		if err != nil {
			return err
		}
	}
}

// materializeCheckouts rebuilds a folder of checkouts from the two tars:
// each bundle's bundleRef (branch when "") imported into its mirror on
// branch, checked out in folder/<name>, its patch applied, and verified.
func materializeCheckouts(ctx context.Context, folder, branch, bundleRef, bundleTar, patchTar string, checkouts []Checkout, staging string) error {
	if bundleRef == "" {
		bundleRef = branch
	}
	if err := validCheckouts(checkouts); err != nil {
		return err
	}
	parts := filepath.Join(staging, "checkouts")
	if err := os.MkdirAll(parts, 0o755); err != nil {
		return err
	}
	want := map[string]bool{}
	for _, c := range checkouts {
		want[c.Name+".bundle"], want[c.Name+".patch"] = true, true
	}
	if err := extractTar(bundleTar, parts, want); err != nil {
		return fmt.Errorf("bundles: %w", err)
	}
	if err := extractTar(patchTar, parts, want); err != nil {
		return fmt.Errorf("patches: %w", err)
	}
	for _, c := range checkouts {
		dir := filepath.Join(folder, c.Name)
		removeWorktree(ctx, c.MirrorPath, dir)
		bundle := filepath.Join(parts, c.Name+".bundle")
		if _, err := os.Stat(bundle); err != nil {
			return fmt.Errorf("restore: the snapshot has no bundle for %s", c.Name)
		}
		if err := importBundle(ctx, c.MirrorPath, bundle, bundleRef, branch); err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		if err := addWorktree(ctx, c.MirrorPath, dir, branch); err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		if err := applyPatch(ctx, dir, filepath.Join(parts, c.Name+".patch")); err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
		if err := verify(ctx, c.MirrorPath, dir, branch); err != nil {
			return fmt.Errorf("%s: %w", c.Name, err)
		}
	}
	return nil
}
