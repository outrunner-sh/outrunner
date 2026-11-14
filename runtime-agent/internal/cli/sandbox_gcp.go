package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var gcpProjectID = regexp.MustCompile(`^[a-z][a-z0-9-]{4,28}[a-z0-9]$`)
var gcpProjectNumber = regexp.MustCompile(`^[1-9][0-9]{4,20}$`)
var gcpZone = regexp.MustCompile(`^[a-z]+-[a-z]+[0-9]+-[a-z]$`)
var gcpConnectionID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const sandboxUsage = `Usage: outrunner sandbox connect gcp [--project ID] [--zone ZONE] [--size small|medium|large] [--yes] [--use]

Connect a billing-enabled Google Cloud project for your sandboxes.
Requires gcloud and permission to configure APIs, IAM, service accounts,
networking, and Workload Identity Federation. No JSON key is created.

  --project ID  Existing project; otherwise choose interactively
  --zone ZONE   VM zone (default us-central1-a)
  --size SIZE   Sandbox size (default small: 2 vCPU, 4 GB)
  --yes         Approve the described GCP setup without prompting
  --use         Use this connection for new sessions after verification

Google bills VM usage, retained disks, networking, and Cloud NAT even
when no sandbox is running. Rerun the same command to retry partial setup.
`

type gcpSetup struct {
	ID             string          `json:"id"`
	Issuer         string          `json:"issuer"`
	JWKS           json.RawMessage `json:"jwks"`
	Name           string          `json:"name"`
	Region         string          `json:"region"`
	Pool           string          `json:"pool"`
	Provider       string          `json:"provider"`
	Audience       string          `json:"audience"`
	ServiceAccount string          `json:"serviceAccount"`
}
type gcloudRunner func(context.Context, ...string) ([]byte, error)

func runGcloud(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gcloud", args...)
	cmd.Env = append(os.Environ(), "CLOUDSDK_CORE_DISABLE_PROMPTS=1")
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		detail := strings.TrimSpace(stderr.String())
		if len(detail) > 2000 {
			detail = detail[len(detail)-2000:]
		}
		return nil, fmt.Errorf("gcloud %s failed: %s", strings.Join(args[:min(3, len(args))], " "), detail)
	}
	return stdout.Bytes(), nil
}
func sandboxCommand(ctx context.Context, base, path string, config Config, account string, args []string, in terminal, out, errout io.Writer) int {
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		fmt.Fprint(out, sandboxUsage)
		return 0
	}
	if len(args) < 2 || args[0] != "connect" || args[1] != "gcp" {
		fmt.Fprint(errout, sandboxUsage)
		return 2
	}
	flags := flag.NewFlagSet("sandbox connect gcp", flag.ContinueOnError)
	flags.SetOutput(errout)
	flags.Usage = func() { fmt.Fprint(errout, sandboxUsage) }
	project := flags.String("project", "", "GCP project ID")
	zone := flags.String("zone", "us-central1-a", "VM zone")
	size := flags.String("size", "small", "sandbox size")
	yes := flags.Bool("yes", false, "approve setup")
	use := flags.Bool("use", false, "use GCP for new sessions")
	if err := flags.Parse(args[2:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() != 0 || !gcpZone.MatchString(*zone) || (*size != "small" && *size != "medium" && *size != "large") || (*project != "" && !gcpProjectID.MatchString(*project)) {
		fmt.Fprintln(errout, "Choose a valid project, zone, and size (small, medium, or large).")
		return 2
	}
	if _, err := exec.LookPath("gcloud"); err != nil {
		fmt.Fprintln(errout, "Install gcloud: https://cloud.google.com/sdk/docs/install\nOr run this command in Google Cloud Shell: https://shell.cloud.google.com")
		return 1
	}
	if !in.interactive && (!*yes || *project == "") {
		fmt.Fprintln(errout, "Non-interactive setup requires --project and --yes. Add --use to switch new sessions to GCP.")
		return 2
	}
	config, code := ensureSignedIn(ctx, base, path, config, account, in, out, errout)
	if code != 0 {
		return code
	}
	if err := connectGcp(ctx, base, config, *project, *zone, *size, *yes, *use, in, out, runGcloud); err != nil {
		fmt.Fprintln(errout, "outrunner:", err)
		return 1
	}
	return 0
}
func gcpCall(ctx context.Context, base string, config Config, body, result any) error {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
	}
	data, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, appURL(base, "/api/cli/sandbox/gcp"), bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+config.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("reach Outrunner: %w", err)
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, 1024*1024)
	if response.StatusCode >= 300 {
		var failure struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(limited).Decode(&failure)
		if failure.Error == "" {
			failure.Error = response.Status
		}
		return errors.New(failure.Error)
	}
	return json.NewDecoder(limited).Decode(result)
}
func connectGcp(ctx context.Context, base string, config Config, project, zone, size string, yes, use bool, in terminal, out io.Writer, run gcloudRunner) error {
	active, err := run(ctx, "auth", "list", "--filter=status:ACTIVE", "--format=value(account)")
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(active)) == "" {
		fmt.Fprintln(out, "Sign in to Google Cloud in your browser…")
		if _, err = run(ctx, "auth", "login", "--quiet", "--brief"); err != nil {
			return err
		}
	}
	if project == "" {
		raw, err := run(ctx, "projects", "list", "--format=json(projectId,name)")
		if err != nil {
			return err
		}
		var projects []struct {
			ID   string `json:"projectId"`
			Name string `json:"name"`
		}
		if json.Unmarshal(raw, &projects) != nil || len(projects) == 0 {
			return errors.New("no Google Cloud projects found; create a billing-enabled project first")
		}
		for i, p := range projects {
			fmt.Fprintf(out, "%d. %s (%s)\n", i+1, p.ID, p.Name)
		}
		fmt.Fprint(out, "Choose a project number: ")
		line, ok := <-in.lines
		if !ok {
			return errors.New("no project selected")
		}
		choice, err := strconv.Atoi(strings.TrimSpace(line))
		if err != nil || choice < 1 || choice > len(projects) {
			return errors.New("choose one of the listed projects")
		}
		project = projects[choice-1].ID
	}
	if !gcpProjectID.MatchString(project) {
		return errors.New("invalid Google Cloud project ID")
	}
	raw, err := run(ctx, "projects", "describe", project, "--format=value(projectNumber)")
	if err != nil {
		return err
	}
	number := strings.TrimSpace(string(raw))
	if !gcpProjectNumber.MatchString(number) {
		return errors.New("Google Cloud did not return a valid project number")
	}
	billing, err := run(ctx, "billing", "projects", "describe", project, "--format=value(billingEnabled)")
	if err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(string(billing)), "true") {
		return fmt.Errorf("enable billing for project %s in Google Cloud, then rerun this command", project)
	}
	fmt.Fprintf(out, "\nProject: %s\nZone: %s\nSandbox size: %s\n\n", project, zone, size)
	fmt.Fprintln(out, "Outrunner will configure APIs, a dedicated service account and IAM role, Workload Identity Federation, a private VPC/subnet, IAP SSH access, and Cloud NAT.")
	fmt.Fprintln(out, "A temporary 2-vCPU VM will test the runtime-agent, then be deleted. Google bills VM usage, retained disks, networking, and Cloud NAT even when no sandbox is running.")
	fmt.Fprintln(out, "Outrunner can create, stop, start, and delete its sandbox VMs in this project. Prefer a dedicated project. No JSON service-account key is created.")
	if !yes && !in.confirmNo("Configure Google Cloud for Outrunner?") {
		fmt.Fprintln(out, "Setup cancelled; no GCP resources were changed.")
		return nil
	}
	var setup gcpSetup
	if err = gcpCall(ctx, base, config, map[string]any{"action": "begin", "projectId": project, "projectNumber": number, "zone": zone}, &setup); err != nil {
		return err
	}
	if err = validateGcpSetup(base, project, number, zone, setup); err != nil {
		return err
	}
	if err = configureGcp(ctx, project, setup, run, out); err != nil {
		return fmt.Errorf("%w\nSetup may be partial. Rerun the same command to retry. Dedicated resources may incur charges until removed; see docs/gcp-sandboxes.md", err)
	}
	fmt.Fprintln(out, "\nTesting a private VM and the runtime-agent; first startup can take several minutes…")
	verifyCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	var verified struct {
		Connected bool `json:"connected"`
	}
	if err = gcpCall(verifyCtx, base, config, map[string]string{"action": "verify", "id": setup.ID}, &verified); err != nil {
		return fmt.Errorf("connection test failed: %w\nCheck permissions/networking and rerun the same command. Cloud NAT remains configured", err)
	}
	if !verified.Connected {
		return errors.New("Outrunner did not confirm that the GCP sandbox test passed")
	}
	fmt.Fprintf(out, "Google Cloud connected: %s. The temporary VM was deleted.\n", project)
	if !use && in.interactive {
		use = in.confirmNo("Use Google Cloud for new sessions?")
	}
	if use {
		var selected struct {
			Sandbox string `json:"sandbox"`
		}
		if err = gcpCall(ctx, base, config, map[string]string{"action": "use", "id": setup.ID, "size": size}, &selected); err != nil {
			return err
		}
		if selected.Sandbox != "gcp" {
			return errors.New("Outrunner did not confirm the sandbox selection")
		}
		fmt.Fprintln(out, "New cloud sessions now run in your Google Cloud project.")
	} else {
		fmt.Fprintln(out, "Select Google Cloud in Outrunner → Settings → Sandbox when you're ready.")
	}
	return nil
}
func validateGcpSetup(base, project, number, zone string, s gcpSetup) error {
	if !gcpConnectionID.MatchString(s.ID) {
		return errors.New("Outrunner returned an invalid GCP connection")
	}
	name := "outrunner-" + strings.ReplaceAll(s.ID, "-", "")[:16]
	region := zone[:strings.LastIndex(zone, "-")]
	audience := "https://iam.googleapis.com/projects/" + number + "/locations/global/workloadIdentityPools/" + name + "/providers/outrunner"
	if s.Name != name || s.Pool != name || s.Provider != "outrunner" || s.Region != region || s.ServiceAccount != name+"@"+project+".iam.gserviceaccount.com" || s.Audience != audience || s.Issuer != strings.TrimRight(base, "/")+"/api/gcp/identity" || !strings.HasPrefix(s.Issuer, "https://") {
		return errors.New("Outrunner returned unexpected GCP setup metadata; no resources were changed")
	}
	var jwks struct {
		Keys []struct {
			Kty string `json:"kty"`
			Alg string `json:"alg"`
			D   string `json:"d"`
		}
	}
	if json.Unmarshal(s.JWKS, &jwks) != nil || len(jwks.Keys) != 1 || jwks.Keys[0].Kty != "EC" || jwks.Keys[0].Alg != "ES256" || jwks.Keys[0].D != "" {
		return errors.New("Outrunner returned invalid public identity keys")
	}
	return nil
}
func gcpMissing(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "not_found") || strings.Contains(s, "not found") || strings.Contains(s, "does not exist")
}
func configureGcp(ctx context.Context, project string, s gcpSetup, run gcloudRunner, out io.Writer) error {
	command := func(args ...string) error {
		_, err := run(ctx, append(args, "--project="+project, "--quiet")...)
		return err
	}
	ensure := func(describe, create []string) error {
		_, err := run(ctx, append(describe, "--project="+project, "--quiet")...)
		if err == nil {
			return nil
		}
		if !gcpMissing(err) {
			return err
		}
		return command(create...)
	}
	fmt.Fprintln(out, "Enabling Google Cloud APIs…")
	if err := command("services", "enable", "compute.googleapis.com", "iam.googleapis.com", "iamcredentials.googleapis.com", "sts.googleapis.com", "oslogin.googleapis.com", "iap.googleapis.com", "cloudresourcemanager.googleapis.com"); err != nil {
		return err
	}
	fmt.Fprintln(out, "Configuring the dedicated service account and keyless access…")
	if err := ensure([]string{"iam", "service-accounts", "describe", s.ServiceAccount}, []string{"iam", "service-accounts", "create", s.Name, "--display-name=Outrunner sandboxes"}); err != nil {
		return err
	}
	if err := ensure([]string{"iam", "workload-identity-pools", "describe", s.Pool, "--location=global"}, []string{"iam", "workload-identity-pools", "create", s.Pool, "--location=global", "--display-name=Outrunner"}); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "outrunner-gcp-public-keys-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	jwksPath := filepath.Join(dir, "jwks.json")
	if err = os.WriteFile(jwksPath, s.JWKS, 0600); err != nil {
		return err
	}
	providerArgs := []string{"--location=global", "--workload-identity-pool=" + s.Pool, "--issuer-uri=" + s.Issuer, "--allowed-audiences=" + s.Audience, "--attribute-mapping=google.subject=assertion.sub", "--attribute-condition=assertion.sub == '" + s.ID + "'", "--jwk-json-path=" + jwksPath}
	_, err = run(ctx, "iam", "workload-identity-pools", "providers", "describe", s.Provider, "--location=global", "--workload-identity-pool="+s.Pool, "--project="+project, "--quiet")
	verb := "update-oidc"
	if err != nil {
		if !gcpMissing(err) {
			return err
		}
		verb = "create-oidc"
	}
	if err = command(append([]string{"iam", "workload-identity-pools", "providers", verb, s.Provider}, providerArgs...)...); err != nil {
		return err
	}
	number := strings.Split(s.Audience, "/")[4]
	principal := "principal://iam.googleapis.com/projects/" + number + "/locations/global/workloadIdentityPools/" + s.Pool + "/subject/" + s.ID
	if err = command("iam", "service-accounts", "add-iam-policy-binding", s.ServiceAccount, "--member="+principal, "--role=roles/iam.workloadIdentityUser", "--condition=None"); err != nil {
		return err
	}
	role := "outrunner_" + strings.ReplaceAll(s.ID, "-", "")[:16]
	permissions := strings.Join([]string{"compute.instances.create", "compute.instances.delete", "compute.instances.get", "compute.instances.list", "compute.instances.start", "compute.instances.stop", "compute.instances.setMetadata", "compute.instances.setLabels", "compute.instances.setTags", "compute.instances.getGuestAttributes", "compute.disks.create", "compute.disks.get", "compute.disks.delete", "compute.disks.use", "compute.subnetworks.use", "compute.networks.use", "compute.zoneOperations.get", "serviceusage.services.use"}, ",")
	_, err = run(ctx, "iam", "roles", "describe", role, "--project="+project, "--quiet")
	roleVerb := "update"
	if err != nil {
		if !gcpMissing(err) {
			return err
		}
		roleVerb = "create"
	}
	if err = command("iam", "roles", roleVerb, role, "--title=Outrunner sandbox lifecycle", "--permissions="+permissions, "--stage=GA"); err != nil {
		return err
	}
	for _, grant := range []string{"projects/" + project + "/roles/" + role, "roles/compute.osAdminLogin", "roles/iap.tunnelResourceAccessor"} {
		if err = command("projects", "add-iam-policy-binding", project, "--member=serviceAccount:"+s.ServiceAccount, "--role="+grant, "--condition=None"); err != nil {
			return err
		}
	}
	fmt.Fprintln(out, "Configuring the private sandbox network and outbound internet access…")
	if err = ensure([]string{"compute", "networks", "describe", s.Name}, []string{"compute", "networks", "create", s.Name, "--subnet-mode=custom"}); err != nil {
		return err
	}
	if err = ensure([]string{"compute", "networks", "subnets", "describe", s.Name, "--region=" + s.Region}, []string{"compute", "networks", "subnets", "create", s.Name, "--network=" + s.Name, "--region=" + s.Region, "--range=10.88.0.0/24", "--enable-private-ip-google-access"}); err != nil {
		return err
	}
	if err = ensure([]string{"compute", "routers", "describe", s.Name, "--region=" + s.Region}, []string{"compute", "routers", "create", s.Name, "--network=" + s.Name, "--region=" + s.Region}); err != nil {
		return err
	}
	if err = ensure([]string{"compute", "routers", "nats", "describe", s.Name, "--router=" + s.Name, "--region=" + s.Region}, []string{"compute", "routers", "nats", "create", s.Name, "--router=" + s.Name, "--region=" + s.Region, "--nat-custom-subnet-ip-ranges=" + s.Name, "--auto-allocate-nat-external-ips"}); err != nil {
		return err
	}
	return ensure([]string{"compute", "firewall-rules", "describe", s.Name + "-iap"}, []string{"compute", "firewall-rules", "create", s.Name + "-iap", "--network=" + s.Name, "--direction=INGRESS", "--allow=tcp:22", "--source-ranges=35.235.240.0/20", "--target-tags=" + s.Name})
}
