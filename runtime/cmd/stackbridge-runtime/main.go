//go:build linux

package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strconv"

	stackruntime "github.com/SoloEdge-ai/StackBridge/runtime"
)

var runtimeVersion = "0.2.0-dev"

type runtimeVersionInfo struct {
	RuntimeVersion  string `json:"runtimeVersion"`
	ProtocolVersion int    `json:"protocolVersion"`
	Platform        string `json:"platform"`
	Arch            string `json:"arch"`
	SHA256          string `json:"sha256"`
}

type rollbackRequest struct {
	SchemaVersion   int    `json:"schemaVersion"`
	DeploymentID    string `json:"deploymentId"`
	ExpectedCurrent string `json:"expectedCurrent"`
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		runVersion()
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "install" {
		runInstall()
		return
	}
	if len(os.Args) == 2 && os.Args[1] == "rollback" {
		runRollback()
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "container-exec" {
		runContainerExec()
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "container-probe" {
		runContainerProbe()
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "stdio" {
		fmt.Fprintln(os.Stderr, "usage: stackbridge-runtime version | install | rollback | stdio | container-probe <init-start-ticks> | container-exec <init-start-ticks> <timeout-ms> <program> [args...]")
		os.Exit(2)
	}

	runtimeInstanceID, err := newRuntimeInstanceID()
	if err != nil {
		fmt.Fprintf(os.Stderr, "create runtime instance id: %v\n", err)
		os.Exit(1)
	}
	executor := stackruntime.NewOSExecutor(1_048_576)
	identity := stackruntime.NewLinuxIdentityProvider(runtimeInstanceID)
	version := mustVersionInfo()
	identityWithBuild := func(ctx context.Context) (stackruntime.RuntimeIdentity, error) {
		result, identityErr := identity(ctx)
		if identityErr == nil {
			result.RuntimeVersion = version.RuntimeVersion
			result.RuntimeDigest = version.SHA256
		}
		return result, identityErr
	}
	dependencies := stackruntime.Dependencies{Identity: identityWithBuild, Execute: executor}
	if docker, dockerErr := stackruntime.NewDockerCLI(stackruntime.NewOSExecutor(13 * 1_048_576)); dockerErr == nil {
		dependencies.Docker = docker
		dependencies.Identity = func(ctx context.Context) (stackruntime.RuntimeIdentity, error) {
			result, identityErr := identityWithBuild(ctx)
			if identityErr == nil {
				result.Capabilities = append(result.Capabilities, "docker.discover")
			}
			return result, identityErr
		}
	}
	server := stackruntime.NewServer(dependencies)
	if err := server.Serve(context.Background(), os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "runtime protocol failed: %v\n", err)
		os.Exit(1)
	}
}

func runVersion() {
	encodeContainerResponse(mustVersionInfo())
}

func runInstall() {
	var manifest stackruntime.InstallManifest
	decodeStrictJSON(&manifest)
	root := runtimeRoot()
	executable, err := os.Executable()
	if err != nil {
		fatalf("resolve runtime executable: %v", err)
	}
	result, err := stackruntime.InstallRuntime(context.Background(), root, executable, manifest)
	if err != nil {
		fatalf("install runtime: %v", err)
	}
	encodeContainerResponse(result)
}

func runRollback() {
	var request rollbackRequest
	decodeStrictJSON(&request)
	if request.SchemaVersion != 1 {
		fatalf("rollback schemaVersion must be 1")
	}
	result, err := stackruntime.RollbackRuntime(context.Background(), runtimeRoot(), request.DeploymentID, request.ExpectedCurrent)
	if err != nil {
		fatalf("rollback runtime: %v", err)
	}
	encodeContainerResponse(result)
}

func runtimeRoot() string {
	home, err := os.UserHomeDir()
	if err != nil {
		fatalf("resolve user home: %v", err)
	}
	return filepath.Join(home, ".sbridge")
}

func mustVersionInfo() runtimeVersionInfo {
	executable, err := os.Executable()
	if err != nil {
		fatalf("resolve runtime executable: %v", err)
	}
	file, err := os.Open(executable)
	if err != nil {
		fatalf("open runtime executable: %v", err)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		fatalf("hash runtime executable: %v", err)
	}
	return runtimeVersionInfo{
		RuntimeVersion:  runtimeVersion,
		ProtocolVersion: stackruntime.ProtocolVersion,
		Platform:        "linux",
		Arch:            goruntime.GOARCH,
		SHA256:          "sha256:" + hex.EncodeToString(hash.Sum(nil)),
	}
}

func decodeStrictJSON(target any) {
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 1_048_576))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		fatalf("decode request: %v", err)
	}
}

func fatalf(format string, values ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", values...)
	os.Exit(1)
}

func runContainerExec() {
	if len(os.Args) < 5 {
		fmt.Fprintln(os.Stderr, "container-exec requires init start ticks, timeout, and program")
		os.Exit(2)
	}
	timeoutMS, err := strconv.Atoi(os.Args[3])
	if err != nil {
		fmt.Fprintln(os.Stderr, "container-exec timeout must be an integer")
		os.Exit(2)
	}
	response := stackruntime.RunContainerExec(context.Background(), stackruntime.ContainerExecRequest{
		ExpectedInitStartTicks: os.Args[2],
		Program:                os.Args[4],
		Args:                   os.Args[5:],
		TimeoutMS:              timeoutMS,
	})
	encodeContainerResponse(response)
}

func runContainerProbe() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "container-probe requires init start ticks")
		os.Exit(2)
	}
	encodeContainerResponse(stackruntime.RunContainerProbe(os.Args[2]))
}

func encodeContainerResponse(response any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(response); err != nil {
		fmt.Fprintf(os.Stderr, "encode container execution response: %v\n", err)
		os.Exit(1)
	}
}

func newRuntimeInstanceID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return "runtime." + hex.EncodeToString(bytes), nil
}
