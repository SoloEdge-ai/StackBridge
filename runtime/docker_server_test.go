package stackruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

type fakeDockerService struct {
	inspect func(context.Context, DockerInspectRequest) (DockerBindingEvidence, error)
	execute func(context.Context, DockerExecRequest) (ExecResult, error)
}

func (service fakeDockerService) Inspect(ctx context.Context, request DockerInspectRequest) (DockerBindingEvidence, error) {
	return service.inspect(ctx, request)
}

func (service fakeDockerService) Execute(ctx context.Context, request DockerExecRequest) (ExecResult, error) {
	return service.execute(ctx, request)
}

func TestServerReturnsVerifiedDockerBindingEvidence(t *testing.T) {
	t.Parallel()

	shell := "/bin/sh"
	server := NewServer(Dependencies{
		Identity: func(context.Context) (RuntimeIdentity, error) { return RuntimeIdentity{}, nil },
		Docker: fakeDockerService{
			inspect: func(_ context.Context, request DockerInspectRequest) (DockerBindingEvidence, error) {
				if request.ContextName != "default" || request.Selector != "stackbridge-fixture" || request.RequestedUser != "0:0" || request.CWD != "/workspace" {
					t.Fatalf("unexpected inspect request: %#v", request)
				}
				return DockerBindingEvidence{
					DockerDaemonID:          "daemon.fixture.1",
					ContainerID:             strings.Repeat("a", 64),
					ContainerStartedAt:      "2026-09-17T08:00:00.123456789Z",
					ContainerInitStartTicks: "424242",
					ContainerState:          "running",
					Principal:               Principal{UID: 0, GID: 0, Name: "root"},
					DefaultCWD:              "/workspace",
					Shell:                   &shell,
					MountsDigest:            "sha256:" + strings.Repeat("b", 64),
					Capabilities:            []string{"process.argv", "process.shell"},
				}, nil
			},
			execute: func(context.Context, DockerExecRequest) (ExecResult, error) {
				t.Fatal("execute should not be called")
				return ExecResult{}, nil
			},
		},
	})
	input := strings.NewReader(`{"version":1,"id":"docker-inspect-1","method":"docker.inspect","params":{"contextName":"default","selector":"stackbridge-fixture","requestedUser":"0:0","cwd":"/workspace"}}` + "\n")
	var output bytes.Buffer

	if err := server.Serve(context.Background(), input, &output); err != nil {
		t.Fatalf("Serve returned an error: %v", err)
	}

	var response Response
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	if !response.OK {
		t.Fatalf("inspect failed: %#v", response.Error)
	}
	result := response.Result.(map[string]any)
	if result["containerId"] != strings.Repeat("a", 64) || result["mountsDigest"] != "sha256:"+strings.Repeat("b", 64) {
		t.Fatalf("unexpected binding evidence: %#v", result)
	}
}

func TestServerReportsAStaleDockerBindingBeforeExecution(t *testing.T) {
	t.Parallel()

	server := NewServer(Dependencies{
		Identity: func(context.Context) (RuntimeIdentity, error) { return RuntimeIdentity{}, nil },
		Docker: fakeDockerService{
			inspect: func(context.Context, DockerInspectRequest) (DockerBindingEvidence, error) {
				t.Fatal("inspect should not be called")
				return DockerBindingEvidence{}, nil
			},
			execute: func(_ context.Context, request DockerExecRequest) (ExecResult, error) {
				if request.ContainerID != strings.Repeat("a", 64) || request.Program != "/usr/bin/printf" {
					t.Fatalf("unexpected execute request: %#v", request)
				}
				return ExecResult{}, ErrStaleDockerBinding
			},
		},
	})
	request := map[string]any{
		"version": 1,
		"id":      "docker-exec-stale",
		"method":  "docker.exec",
		"params": map[string]any{
			"contextName":                     "default",
			"dockerDaemonId":                  "daemon.fixture.1",
			"containerId":                     strings.Repeat("a", 64),
			"containerStartedAt":              "2026-09-17T08:00:00.123456789Z",
			"expectedContainerInitStartTicks": "424242",
			"mountsDigest":                    "sha256:" + strings.Repeat("b", 64),
			"user":                            "0:0",
			"expectedUid":                     0,
			"expectedGid":                     0,
			"cwd":                             "/workspace",
			"program":                         "/usr/bin/printf",
			"args":                            []string{"%s\\n", "container"},
			"timeoutMs":                       5000,
		},
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := server.Serve(context.Background(), bytes.NewReader(append(encoded, '\n')), &output); err != nil {
		t.Fatalf("Serve returned an error: %v", err)
	}

	var response Response
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	if response.OK || response.Error == nil || response.Error.Code != "stale_binding" {
		t.Fatalf("expected stale_binding, got %#v", response)
	}
}
