//go:build linux

package stackruntime

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestInstallRuntimeActivatesVerifiedBinary(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".sbridge")
	staging := filepath.Join(root, "staging")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(staging, "runtime-deploy-1.part")
	contents := []byte("verified runtime fixture")
	if err := os.WriteFile(source, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("sha256:%x", sha256.Sum256(contents))

	result, err := InstallRuntime(context.Background(), root, source, InstallManifest{
		SchemaVersion:   1,
		DeploymentID:    "deploy-1",
		RuntimeVersion:  "0.1.0",
		ProtocolVersion: 2,
		Platform:        "linux",
		Arch:            "amd64",
		SHA256:          digest,
	})
	if err != nil {
		t.Fatalf("install runtime: %v", err)
	}

	if result.Status != "installed" || result.PreviousTarget != "" {
		t.Fatalf("unexpected result: %#v", result)
	}
	current, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil {
		t.Fatalf("read current symlink: %v", err)
	}
	if current != result.CurrentTarget {
		t.Fatalf("current target = %q, want %q", current, result.CurrentTarget)
	}
	installed := filepath.Join(root, filepath.FromSlash(current), "stackbridge-runtime")
	actual, err := os.ReadFile(installed)
	if err != nil {
		t.Fatalf("read installed runtime: %v", err)
	}
	if string(actual) != string(contents) {
		t.Fatalf("installed contents = %q", actual)
	}
	info, err := os.Stat(installed)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("runtime mode = %o, want 755", info.Mode().Perm())
	}
	if _, err := os.Stat(source); !os.IsNotExist(err) {
		t.Fatalf("staged source still exists: %v", err)
	}
}

func TestRollbackRuntimeRestoresPreviousVerifiedTarget(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".sbridge")
	first := installFixture(t, root, "deploy-1", "0.1.0", []byte("runtime one"))
	second := installFixture(t, root, "deploy-2", "0.2.0", []byte("runtime two"))
	if second.PreviousTarget != first.CurrentTarget {
		t.Fatalf("previous target = %q, want %q", second.PreviousTarget, first.CurrentTarget)
	}

	result, err := RollbackRuntime(context.Background(), root, "deploy-2", second.CurrentTarget)
	if err != nil {
		t.Fatalf("rollback runtime: %v", err)
	}
	if result.CurrentTarget != first.CurrentTarget {
		t.Fatalf("rolled back target = %q, want %q", result.CurrentTarget, first.CurrentTarget)
	}
	current, err := os.Readlink(filepath.Join(root, "current"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.ToSlash(current) != first.CurrentTarget {
		t.Fatalf("current link = %q, want %q", current, first.CurrentTarget)
	}
}

func TestInstallRuntimeRejectsStagingSymlinkEscape(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".sbridge")
	outside := t.TempDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "staging")); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(root, "staging", "deploy.part")
	contents := []byte("escaped runtime")
	if err := os.WriteFile(filepath.Join(outside, "deploy.part"), contents, 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := InstallRuntime(context.Background(), root, source, fixtureManifest("deploy", "0.1.0", contents))
	if err == nil || !strings.Contains(err.Error(), "real StackBridge root") {
		t.Fatalf("expected staging symlink rejection, got %v", err)
	}
}

func TestInstallRuntimeRejectsIntermediateRuntimeSymlink(t *testing.T) {
	root := filepath.Join(t.TempDir(), ".sbridge")
	staging := filepath.Join(root, "staging")
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "runtimes"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "runtimes", "0.1.0")); err != nil {
		t.Fatal(err)
	}
	contents := []byte("verified runtime")
	source := filepath.Join(staging, "deploy.part")
	if err := os.WriteFile(source, contents, 0o700); err != nil {
		t.Fatal(err)
	}

	_, err := InstallRuntime(context.Background(), root, source, fixtureManifest("deploy", "0.1.0", contents))
	if err == nil || !strings.Contains(err.Error(), "real directory") {
		t.Fatalf("expected intermediate symlink rejection, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "stackbridge-runtime")); !os.IsNotExist(err) {
		t.Fatalf("runtime escaped managed root: %v", err)
	}
}

func installFixture(t *testing.T, root, deploymentID, version string, contents []byte) InstallResult {
	t.Helper()
	staging := filepath.Join(root, "staging")
	if err := os.MkdirAll(staging, 0o700); err != nil {
		t.Fatal(err)
	}
	source := filepath.Join(staging, deploymentID+".part")
	if err := os.WriteFile(source, contents, 0o700); err != nil {
		t.Fatal(err)
	}
	result, err := InstallRuntime(context.Background(), root, source, fixtureManifest(deploymentID, version, contents))
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func fixtureManifest(deploymentID, version string, contents []byte) InstallManifest {
	return InstallManifest{
		SchemaVersion:   1,
		DeploymentID:    deploymentID,
		RuntimeVersion:  version,
		ProtocolVersion: ProtocolVersion,
		Platform:        "linux",
		Arch:            "amd64",
		SHA256:          fmt.Sprintf("sha256:%x", sha256.Sum256(contents)),
	}
}
