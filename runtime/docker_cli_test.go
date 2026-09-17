package stackruntime

import (
	"context"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestDockerCLIInspectReturnsMinimalVerifiedEvidenceAndUsesStructuredArguments(t *testing.T) {
	t.Parallel()

	containerID := strings.Repeat("a", 64)
	var calls []ExecRequest
	executor := func(_ context.Context, request ExecRequest) (ExecResult, error) {
		calls = append(calls, request)
		switch {
		case slices.Equal(request.Args, []string{"--context", "default", "info", "--format", "{{.ID}}"}):
			return ExecResult{Stdout: "daemon.fixture.1\n"}, nil
		case len(request.Args) == 7 && request.Args[2] == "inspect" && request.Args[5] == "--":
			return ExecResult{Stdout: `[{"Id":"` + containerID + `","State":{"Status":"running","StartedAt":"2026-09-17T08:00:00.123456789Z","Pid":4321},"Config":{"WorkingDir":"/image"},"Mounts":[{"Type":"bind","Source":"/tmp/source","Destination":"/workspace/bind","Mode":"","RW":true,"Propagation":"rprivate"}]}]`}, nil
		case slices.Equal(request.Args, []string{"--context", "default", "cp", "/fixture/runtime", containerID + ":" + containerRuntimePath}):
			return ExecResult{}, nil
		case slices.Equal(request.Args, []string{"--context", "default", "exec", "--user", "0:0", "--workdir", "/workspace", containerID, containerRuntimePath, "container-probe", "424242"}):
			return ExecResult{Stdout: `{"version":1,"ok":true,"result":{"initStartTicks":"424242","principal":{"uid":0,"gid":0,"name":"root"},"defaultCwd":"/workspace","shell":"/bin/sh","capabilities":["process.argv","process.shell"]}}` + "\n"}, nil
		default:
			t.Fatalf("unexpected Docker command args: %#v", request.Args)
			return ExecResult{}, nil
		}
	}
	service := newDockerCLI("/usr/bin/docker", "/fixture/runtime", executor)
	service.processStartTicks = func(pid int) (string, error) {
		if pid != 4321 {
			t.Fatalf("unexpected container init PID: %d", pid)
		}
		return "424242", nil
	}

	evidence, err := service.Inspect(context.Background(), DockerInspectRequest{
		ContextName:   "default",
		Selector:      "fixture ; $(literal)",
		RequestedUser: "0:0",
		CWD:           "/workspace",
	})
	if err != nil {
		t.Fatalf("Inspect returned an error: %v", err)
	}
	if evidence.DockerDaemonID != "daemon.fixture.1" || evidence.ContainerID != containerID {
		t.Fatalf("unexpected identity evidence: %#v", evidence)
	}
	if evidence.ContainerInitStartTicks != "424242" {
		t.Fatalf("unexpected container init identity: %#v", evidence)
	}
	if evidence.Principal.UID != 0 || evidence.Principal.GID != 0 || evidence.Principal.Name != "root" {
		t.Fatalf("unexpected principal: %#v", evidence.Principal)
	}
	if evidence.Shell == nil || *evidence.Shell != "/bin/sh" || evidence.DefaultCWD != "/workspace" {
		t.Fatalf("unexpected execution defaults: %#v", evidence)
	}
	if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(evidence.MountsDigest) {
		t.Fatalf("unexpected mounts digest: %q", evidence.MountsDigest)
	}
	if got := calls[1].Args[6]; got != "fixture ; $(literal)" {
		t.Fatalf("selector was changed or shell-parsed: %q", got)
	}
}

func TestDockerBindingComparisonRejectsEveryMutableIdentityField(t *testing.T) {
	t.Parallel()

	request := DockerExecRequest{
		ContextName:                     "default",
		DockerDaemonID:                  "daemon.fixture.1",
		ContainerID:                     strings.Repeat("a", 64),
		ContainerStartedAt:              "2026-09-17T08:00:00.123456789Z",
		ExpectedContainerInitStartTicks: "424242",
		MountsDigest:                    "sha256:" + strings.Repeat("b", 64),
		ExpectedUID:                     pointerTo(0),
		ExpectedGID:                     pointerTo(0),
	}
	evidence := DockerBindingEvidence{
		DockerDaemonID:          request.DockerDaemonID,
		ContainerID:             request.ContainerID,
		ContainerStartedAt:      request.ContainerStartedAt,
		ContainerInitStartTicks: request.ExpectedContainerInitStartTicks,
		MountsDigest:            request.MountsDigest,
		ContainerState:          "running",
		Principal:               Principal{UID: 0, GID: 0},
	}
	if !dockerBindingMatches(request, evidence) {
		t.Fatal("identical running binding should match")
	}

	mutations := []func(*DockerBindingEvidence){
		func(value *DockerBindingEvidence) { value.DockerDaemonID = "daemon.fixture.2" },
		func(value *DockerBindingEvidence) { value.ContainerID = strings.Repeat("c", 64) },
		func(value *DockerBindingEvidence) { value.ContainerStartedAt = "2026-09-17T08:01:00Z" },
		func(value *DockerBindingEvidence) { value.ContainerInitStartTicks = "424243" },
		func(value *DockerBindingEvidence) { value.MountsDigest = "sha256:" + strings.Repeat("d", 64) },
		func(value *DockerBindingEvidence) { value.ContainerState = "exited" },
		func(value *DockerBindingEvidence) { value.Principal.UID = 1000 },
		func(value *DockerBindingEvidence) { value.Principal.GID = 1000 },
	}
	for index, mutate := range mutations {
		changed := evidence
		mutate(&changed)
		if dockerBindingMatches(request, changed) {
			t.Fatalf("mutation %d should invalidate the binding", index)
		}
	}
}

func TestDockerExecutionUsesTheVerifiedContainerAndNumericPrincipal(t *testing.T) {
	t.Parallel()

	request := DockerExecRequest{
		ContextName: "default",
		User:        "developer",
		CWD:         "/workspace",
		ContainerID: strings.Repeat("a", 64),
		Program:     "/usr/bin/id",
		Args:        []string{"-u"},
		TimeoutMS:   5_000,
	}
	evidence := DockerBindingEvidence{
		Principal:               Principal{UID: 1000, GID: 1001},
		ContainerInitStartTicks: "424242",
	}
	args := dockerExecutionArguments(request, evidence)
	expected := []string{
		"--context", "default", "exec", "--user", "1000:1001", "--workdir", "/workspace",
		request.ContainerID, containerRuntimePath, "container-exec", "424242", "5000", "/usr/bin/id", "-u",
	}
	if !slices.Equal(args, expected) {
		t.Fatalf("Docker execution was not pinned to the verified numeric principal: %#v", args)
	}
}

func TestLinuxProcessStartTicksParserHandlesSpacesInTheCommandName(t *testing.T) {
	t.Parallel()

	fields := []string{"S"}
	for range 18 {
		fields = append(fields, "0")
	}
	fields = append(fields, "424242", "0")
	value, err := parseLinuxProcessStartTicks("4321 (fixture worker) " + strings.Join(fields, " "))
	if err != nil {
		t.Fatalf("parseLinuxProcessStartTicks returned an error: %v", err)
	}
	if value != "424242" {
		t.Fatalf("unexpected start ticks: %q", value)
	}
}

func pointerTo(value int) *int {
	return &value
}

func TestMountDigestIsStableAcrossInspectOrdering(t *testing.T) {
	t.Parallel()

	first := []dockerMount{
		{Type: "bind", Source: "/b", Destination: "/workspace/b", RW: true},
		{Type: "volume", Source: "cache", Destination: "/cache", RW: true},
	}
	second := []dockerMount{first[1], first[0]}
	if digestDockerMounts(first) != digestDockerMounts(second) {
		t.Fatal("mount ordering must not change binding identity")
	}
}
