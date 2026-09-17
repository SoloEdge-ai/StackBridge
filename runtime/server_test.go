package stackruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestServerReturnsRuntimeIdentityForHandshake(t *testing.T) {
	t.Parallel()

	identity := RuntimeIdentity{
		ProtocolVersion:   ProtocolVersion,
		RuntimeInstanceID: "runtime.fixture.1",
		HostBootID:        "aa4bf2ca-5bc6-424f-98f9-22a671d323ce",
		Principal: Principal{
			UID:  1000,
			GID:  1000,
			Name: "fixture",
		},
		Platform:   "linux",
		Arch:       "amd64",
		DefaultCWD: "/workspace",
		Shell:      "/bin/sh",
		Capabilities: []string{
			"process.argv",
		},
	}
	server := NewServer(Dependencies{
		Identity: func(context.Context) (RuntimeIdentity, error) {
			return identity, nil
		},
	})
	input := strings.NewReader("{\"version\":2,\"id\":\"handshake-1\",\"method\":\"handshake\",\"params\":{}}\n")
	var output bytes.Buffer

	if err := server.Serve(context.Background(), input, &output); err != nil {
		t.Fatalf("Serve returned an error: %v", err)
	}

	var response Response
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	if response.Version != ProtocolVersion || response.ID != "handshake-1" || !response.OK {
		t.Fatalf("unexpected response envelope: %#v", response)
	}
	result, ok := response.Result.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type: %T", response.Result)
	}
	if result["runtimeInstanceId"] != "runtime.fixture.1" {
		t.Fatalf("unexpected runtime identity: %#v", result)
	}
}

func TestServerPassesStructuredArgvToTheExecutorWithoutShellParsing(t *testing.T) {
	t.Parallel()

	server := NewServer(Dependencies{
		Identity: func(context.Context) (RuntimeIdentity, error) {
			return RuntimeIdentity{}, nil
		},
		Execute: func(_ context.Context, request ExecRequest) (ExecResult, error) {
			if request.CWD != "/workspace/含 空格" {
				t.Fatalf("unexpected cwd: %q", request.CWD)
			}
			if request.Program != "/usr/bin/printf" {
				t.Fatalf("unexpected program: %q", request.Program)
			}
			expectedArgs := []string{"%s\\n", "空 格", "quote\"and'apostrophe", "line1\nline2"}
			if len(request.Args) != len(expectedArgs) {
				t.Fatalf("unexpected args: %#v", request.Args)
			}
			for index := range expectedArgs {
				if request.Args[index] != expectedArgs[index] {
					t.Fatalf("arg %d changed: got %q want %q", index, request.Args[index], expectedArgs[index])
				}
			}
			return ExecResult{ExitCode: 0, Stdout: "fixture-ok\n"}, nil
		},
	})
	input := strings.NewReader("{\"version\":2,\"id\":\"exec-1\",\"method\":\"exec\",\"params\":{\"cwd\":\"/workspace/含 空格\",\"program\":\"/usr/bin/printf\",\"args\":[\"%s\\\\n\",\"空 格\",\"quote\\\"and'apostrophe\",\"line1\\nline2\"],\"timeoutMs\":5000}}\n")
	var output bytes.Buffer

	if err := server.Serve(context.Background(), input, &output); err != nil {
		t.Fatalf("Serve returned an error: %v", err)
	}

	var response Response
	if err := json.Unmarshal(output.Bytes(), &response); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	if !response.OK {
		t.Fatalf("execution failed: %#v", response.Error)
	}
	result, ok := response.Result.(map[string]any)
	if !ok || result["stdout"] != "fixture-ok\n" || result["exitCode"] != float64(0) {
		t.Fatalf("unexpected execution result: %#v", response.Result)
	}
}

func TestServerIgnoresBlankLinesBetweenRequests(t *testing.T) {
	t.Parallel()

	server := NewServer(Dependencies{
		Identity: func(context.Context) (RuntimeIdentity, error) {
			return RuntimeIdentity{ProtocolVersion: ProtocolVersion}, nil
		},
	})
	input := strings.NewReader("\n{\"version\":2,\"id\":\"handshake-blank-lines\",\"method\":\"handshake\",\"params\":{}}\n\n")
	var output bytes.Buffer

	if err := server.Serve(context.Background(), input, &output); err != nil {
		t.Fatalf("Serve returned an error: %v", err)
	}

	lines := strings.Split(strings.TrimSpace(output.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one response, got %d: %q", len(lines), output.String())
	}
	var response Response
	if err := json.Unmarshal([]byte(lines[0]), &response); err != nil {
		t.Fatalf("response was not JSON: %v", err)
	}
	if !response.OK || response.ID != "handshake-blank-lines" {
		t.Fatalf("unexpected response: %#v", response)
	}
}
