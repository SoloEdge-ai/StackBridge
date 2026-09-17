//go:build linux

package stackruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
)

var installIdentifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$`)

type InstallManifest struct {
	SchemaVersion   int    `json:"schemaVersion"`
	DeploymentID    string `json:"deploymentId"`
	RuntimeVersion  string `json:"runtimeVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	SHA256          string `json:"sha256"`
}

type InstallResult struct {
	Status         string `json:"status"`
	CurrentTarget  string `json:"currentTarget"`
	PreviousTarget string `json:"previousTarget,omitempty"`
	RuntimeVersion string `json:"runtimeVersion"`
	SHA256         string `json:"sha256"`
}

func RollbackRuntime(ctx context.Context, root, deploymentID, expectedCurrent string) (InstallResult, error) {
	if err := ctx.Err(); err != nil {
		return InstallResult{}, err
	}
	if !installIdentifierPattern.MatchString(deploymentID) {
		return InstallResult{}, errors.New("deploymentId is invalid")
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return InstallResult{}, fmt.Errorf("resolve install root: %w", err)
	}
	if err := ensurePrivateDirectory(root); err != nil {
		return InstallResult{}, err
	}
	stateDir, err := ensureManagedDirectory(root, "state")
	if err != nil {
		return InstallResult{}, err
	}
	lock, err := os.OpenFile(filepath.Join(stateDir, "install.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return InstallResult{}, fmt.Errorf("open install lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return InstallResult{}, fmt.Errorf("lock runtime install: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck

	current, err := readManagedLink(root, "current")
	if err != nil {
		return InstallResult{}, err
	}
	if current != expectedCurrent {
		return InstallResult{}, errors.New("current runtime changed before rollback")
	}
	previous, err := readManagedLink(root, "previous")
	if err != nil {
		return InstallResult{}, err
	}
	if previous == "" {
		return InstallResult{}, errors.New("no previous runtime is available")
	}
	manifest, err := verifyManagedTarget(root, previous)
	if err != nil {
		return InstallResult{}, fmt.Errorf("verify previous runtime: %w", err)
	}
	if err := replaceManagedLink(root, "current", previous, deploymentID); err != nil {
		return InstallResult{}, err
	}
	if err := replaceManagedLink(root, "previous", current, deploymentID); err != nil {
		return InstallResult{}, err
	}
	if err := syncDirectory(root); err != nil {
		return InstallResult{}, err
	}
	return InstallResult{
		Status:         "rolled_back",
		CurrentTarget:  previous,
		PreviousTarget: current,
		RuntimeVersion: manifest.RuntimeVersion,
		SHA256:         manifest.SHA256,
	}, nil
}

func InstallRuntime(ctx context.Context, root, source string, manifest InstallManifest) (InstallResult, error) {
	if err := ctx.Err(); err != nil {
		return InstallResult{}, err
	}
	if err := validateInstallManifest(manifest); err != nil {
		return InstallResult{}, err
	}
	if manifest.Platform != runtime.GOOS || manifest.Arch != runtime.GOARCH {
		return InstallResult{}, fmt.Errorf("runtime artifact is %s/%s, host is %s/%s", manifest.Platform, manifest.Arch, runtime.GOOS, runtime.GOARCH)
	}
	root, err := filepath.Abs(root)
	if err != nil {
		return InstallResult{}, fmt.Errorf("resolve install root: %w", err)
	}
	source, err = filepath.Abs(source)
	if err != nil {
		return InstallResult{}, fmt.Errorf("resolve staged runtime: %w", err)
	}
	if err := ensurePrivateDirectory(root); err != nil {
		return InstallResult{}, err
	}
	if err := verifyRealPathInsideRoot(root, source); err != nil {
		return InstallResult{}, err
	}
	stateDir, err := ensureManagedDirectory(root, "state")
	if err != nil {
		return InstallResult{}, err
	}
	if _, err := ensureManagedDirectory(root, "runtimes"); err != nil {
		return InstallResult{}, err
	}

	lock, err := os.OpenFile(filepath.Join(stateDir, "install.lock"), os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return InstallResult{}, fmt.Errorf("open install lock: %w", err)
	}
	defer lock.Close()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		return InstallResult{}, fmt.Errorf("lock runtime install: %w", err)
	}
	defer syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) //nolint:errcheck

	actualDigest, err := digestFile(source)
	if err != nil {
		return InstallResult{}, fmt.Errorf("hash staged runtime: %w", err)
	}
	if actualDigest != manifest.SHA256 {
		return InstallResult{}, fmt.Errorf("runtime digest mismatch: got %s", actualDigest)
	}

	digestHex := strings.TrimPrefix(manifest.SHA256, "sha256:")
	targetRelative := filepath.ToSlash(filepath.Join("runtimes", manifest.RuntimeVersion, manifest.Platform+"-"+manifest.Arch, digestHex))
	targetDir, err := ensureManagedDirectory(
		root,
		"runtimes",
		manifest.RuntimeVersion,
		manifest.Platform+"-"+manifest.Arch,
		digestHex,
	)
	if err != nil {
		return InstallResult{}, err
	}
	finalRuntime := filepath.Join(targetDir, "stackbridge-runtime")
	if existingDigest, digestErr := digestFile(finalRuntime); digestErr == nil {
		if existingDigest != manifest.SHA256 {
			return InstallResult{}, errors.New("managed runtime path contains a different binary")
		}
		if err := os.Remove(source); err != nil && !os.IsNotExist(err) {
			return InstallResult{}, fmt.Errorf("remove duplicate staged runtime: %w", err)
		}
	} else if os.IsNotExist(digestErr) {
		if err := os.Rename(source, finalRuntime); err != nil {
			return InstallResult{}, fmt.Errorf("activate staged runtime file: %w", err)
		}
	} else {
		return InstallResult{}, fmt.Errorf("inspect managed runtime: %w", digestErr)
	}
	if err := os.Chmod(finalRuntime, 0o755); err != nil {
		return InstallResult{}, fmt.Errorf("set runtime permissions: %w", err)
	}
	manifestBytes, err := json.Marshal(manifest)
	if err != nil {
		return InstallResult{}, fmt.Errorf("encode runtime manifest: %w", err)
	}
	if err := os.WriteFile(filepath.Join(targetDir, "manifest.json"), append(manifestBytes, '\n'), 0o600); err != nil {
		return InstallResult{}, fmt.Errorf("write runtime manifest: %w", err)
	}
	if err := syncDirectory(targetDir); err != nil {
		return InstallResult{}, err
	}

	previous, err := readManagedLink(root, "current")
	if err != nil {
		return InstallResult{}, err
	}
	if previous == targetRelative {
		return InstallResult{Status: "reused", CurrentTarget: targetRelative, RuntimeVersion: manifest.RuntimeVersion, SHA256: manifest.SHA256}, nil
	}
	if previous != "" {
		if err := replaceManagedLink(root, "previous", previous, manifest.DeploymentID); err != nil {
			return InstallResult{}, err
		}
	}
	if err := replaceManagedLink(root, "current", targetRelative, manifest.DeploymentID); err != nil {
		return InstallResult{}, err
	}
	if err := syncDirectory(root); err != nil {
		return InstallResult{}, err
	}

	return InstallResult{
		Status:         "installed",
		CurrentTarget:  targetRelative,
		PreviousTarget: previous,
		RuntimeVersion: manifest.RuntimeVersion,
		SHA256:         manifest.SHA256,
	}, nil
}

func validateInstallManifest(manifest InstallManifest) error {
	if manifest.SchemaVersion != 1 {
		return errors.New("install schemaVersion must be 1")
	}
	if !installIdentifierPattern.MatchString(manifest.DeploymentID) {
		return errors.New("deploymentId is invalid")
	}
	if !installIdentifierPattern.MatchString(manifest.RuntimeVersion) {
		return errors.New("runtimeVersion is invalid")
	}
	if manifest.ProtocolVersion != ProtocolVersion {
		return fmt.Errorf("runtime protocol version must be %d", ProtocolVersion)
	}
	if manifest.Platform != "linux" || (manifest.Arch != "amd64" && manifest.Arch != "arm64") {
		return errors.New("unsupported runtime platform or architecture")
	}
	if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(manifest.SHA256) {
		return errors.New("sha256 is invalid")
	}
	return nil
}

func ensurePrivateDirectory(path string) error {
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		if err := os.Mkdir(path, 0o700); err != nil {
			return fmt.Errorf("create managed directory: %w", err)
		}
		info, err = os.Lstat(path)
	}
	if err != nil {
		return fmt.Errorf("inspect managed directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("managed path must be a real directory")
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("secure managed directory: %w", err)
	}
	return nil
}

func ensureManagedDirectory(root string, components ...string) (string, error) {
	current := root
	for _, component := range components {
		if component == "" || component == "." || component == ".." || filepath.Base(component) != component {
			return "", errors.New("managed directory component is invalid")
		}
		current = filepath.Join(current, component)
		if err := ensurePrivateDirectory(current); err != nil {
			return "", err
		}
	}
	return current, nil
}

func verifyRealPathInsideRoot(root, path string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return fmt.Errorf("resolve real install root: %w", err)
	}
	realPath, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve real staged runtime: %w", err)
	}
	relative, err := filepath.Rel(realRoot, realPath)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return errors.New("staged runtime must be inside the real StackBridge root")
	}
	return nil
}

func digestFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyManagedTarget(root, target string) (InstallManifest, error) {
	if filepath.IsAbs(target) || target == ".." || strings.HasPrefix(target, ".."+string(filepath.Separator)) {
		return InstallManifest{}, errors.New("managed runtime target escapes the StackBridge root")
	}
	directory := filepath.Join(root, filepath.FromSlash(target))
	manifestBytes, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return InstallManifest{}, err
	}
	var manifest InstallManifest
	decoder := json.NewDecoder(strings.NewReader(string(manifestBytes)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		return InstallManifest{}, err
	}
	if err := validateInstallManifest(manifest); err != nil {
		return InstallManifest{}, err
	}
	digest, err := digestFile(filepath.Join(directory, "stackbridge-runtime"))
	if err != nil {
		return InstallManifest{}, err
	}
	if digest != manifest.SHA256 {
		return InstallManifest{}, errors.New("managed runtime digest mismatch")
	}
	return manifest, nil
}

func readManagedLink(root, name string) (string, error) {
	path := filepath.Join(root, name)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("inspect %s link: %w", name, err)
	}
	if info.Mode()&os.ModeSymlink == 0 {
		return "", fmt.Errorf("managed %s path is not a symlink", name)
	}
	target, err := os.Readlink(path)
	if err != nil {
		return "", fmt.Errorf("read %s link: %w", name, err)
	}
	if filepath.IsAbs(target) || target == ".." || strings.HasPrefix(target, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("managed %s link escapes the StackBridge root", name)
	}
	return filepath.ToSlash(target), nil
}

func replaceManagedLink(root, name, target, deploymentID string) error {
	temporary := filepath.Join(root, "."+name+"."+deploymentID+".next")
	_ = os.Remove(temporary)
	if err := os.Symlink(filepath.FromSlash(target), temporary); err != nil {
		return fmt.Errorf("create %s link: %w", name, err)
	}
	if err := os.Rename(temporary, filepath.Join(root, name)); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("replace %s link: %w", name, err)
	}
	return nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open directory for sync: %w", err)
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return fmt.Errorf("sync directory: %w", err)
	}
	return nil
}
