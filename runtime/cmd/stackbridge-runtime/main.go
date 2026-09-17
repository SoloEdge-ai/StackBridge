//go:build linux

package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"

	stackruntime "github.com/SoloEdge-ai/StackBridge/runtime"
)

func main() {
	if len(os.Args) >= 2 && os.Args[1] == "container-exec" {
		runContainerExec()
		return
	}
	if len(os.Args) >= 2 && os.Args[1] == "container-probe" {
		runContainerProbe()
		return
	}
	if len(os.Args) != 2 || os.Args[1] != "stdio" {
		fmt.Fprintln(os.Stderr, "usage: stackbridge-runtime stdio | container-probe <init-start-ticks> | container-exec <init-start-ticks> <timeout-ms> <program> [args...]")
		os.Exit(2)
	}

	runtimeInstanceID, err := newRuntimeInstanceID()
	if err != nil {
		fmt.Fprintf(os.Stderr, "create runtime instance id: %v\n", err)
		os.Exit(1)
	}
	executor := stackruntime.NewOSExecutor(1_048_576)
	identity := stackruntime.NewLinuxIdentityProvider(runtimeInstanceID)
	dependencies := stackruntime.Dependencies{Identity: identity, Execute: executor}
	if docker, dockerErr := stackruntime.NewDockerCLI(stackruntime.NewOSExecutor(13 * 1_048_576)); dockerErr == nil {
		dependencies.Docker = docker
		dependencies.Identity = func(ctx context.Context) (stackruntime.RuntimeIdentity, error) {
			result, identityErr := identity(ctx)
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
