package stackruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

const (
	dockerMetadataTimeoutMS    = 10_000
	dockerExecutionGraceTimeMS = 5_000
	containerRuntimePath       = "/tmp/stackbridge-runtime-m0-b1"
)

var fullContainerIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type dockerMount struct {
	Type        string `json:"type"`
	Source      string `json:"source"`
	Destination string `json:"destination"`
	Mode        string `json:"mode"`
	RW          bool   `json:"rw"`
	Propagation string `json:"propagation"`
}

type dockerInspectRecord struct {
	ID    string `json:"Id"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
		PID       int    `json:"Pid"`
	} `json:"State"`
	Config struct {
		WorkingDir string `json:"WorkingDir"`
	} `json:"Config"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
		Mode        string `json:"Mode"`
		RW          bool   `json:"RW"`
		Propagation string `json:"Propagation"`
	} `json:"Mounts"`
}

type DockerCLI struct {
	dockerPath        string
	runtimePath       string
	execute           Executor
	processStartTicks func(int) (string, error)
}

func NewDockerCLI(execute Executor) (*DockerCLI, error) {
	if execute == nil {
		return nil, errors.New("Docker CLI executor is required")
	}
	dockerPath, err := exec.LookPath("docker")
	if err != nil {
		return nil, fmt.Errorf("find Docker CLI: %w", err)
	}
	runtimePath, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("find runtime executable: %w", err)
	}
	return newDockerCLI(dockerPath, runtimePath, execute), nil
}

func newDockerCLI(dockerPath, runtimePath string, execute Executor) *DockerCLI {
	return &DockerCLI{
		dockerPath: dockerPath, runtimePath: runtimePath, execute: execute, processStartTicks: readLinuxProcessStartTicks,
	}
}

func (docker *DockerCLI) Inspect(ctx context.Context, request DockerInspectRequest) (DockerBindingEvidence, error) {
	daemonID, err := docker.daemonID(ctx, request.ContextName)
	if err != nil {
		return DockerBindingEvidence{}, err
	}

	inspectResult, err := docker.runMetadata(ctx, request.ContextName, []string{"inspect", "--type", "container", "--", request.Selector})
	if err != nil {
		return DockerBindingEvidence{}, err
	}
	var records []dockerInspectRecord
	if err := json.Unmarshal([]byte(inspectResult.Stdout), &records); err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("decode Docker inspect response: %w", err)
	}
	if len(records) != 1 {
		return DockerBindingEvidence{}, fmt.Errorf("container selector resolved to %d containers", len(records))
	}
	record := records[0]
	if !fullContainerIDPattern.MatchString(record.ID) {
		return DockerBindingEvidence{}, errors.New("Docker returned an invalid full container ID")
	}
	if record.State.Status != "running" {
		return DockerBindingEvidence{}, fmt.Errorf("container is not running: %s", record.State.Status)
	}
	if _, err := time.Parse(time.RFC3339Nano, record.State.StartedAt); err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("Docker returned an invalid container start time: %w", err)
	}
	if record.State.PID < 1 {
		return DockerBindingEvidence{}, errors.New("Docker returned an invalid container init PID")
	}
	initStartTicks, err := docker.processStartTicks(record.State.PID)
	if err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("read container init identity: %w", err)
	}
	if _, err := docker.runMetadata(ctx, request.ContextName, []string{
		"cp", docker.runtimePath, record.ID + ":" + containerRuntimePath,
	}); err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("deploy container runtime: %w", err)
	}

	cwd := request.CWD
	if cwd == "" {
		cwd = record.Config.WorkingDir
		if cwd == "" {
			cwd = "/"
		}
	}
	probeCommand, err := docker.runMetadata(ctx, request.ContextName, []string{
		"exec", "--user", request.RequestedUser, "--workdir", cwd, record.ID,
		containerRuntimePath, "container-probe", initStartTicks,
	})
	if err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("run container runtime probe: %w", err)
	}
	var probe ContainerProbeResponse
	if err := decodeStrict([]byte(probeCommand.Stdout), &probe); err != nil {
		return DockerBindingEvidence{}, fmt.Errorf("decode container runtime probe: %w", err)
	}
	if !probe.OK || probe.Result == nil {
		if probe.Error != nil {
			return DockerBindingEvidence{}, fmt.Errorf("container runtime probe %s: %s", probe.Error.Code, probe.Error.Message)
		}
		return DockerBindingEvidence{}, errors.New("container runtime probe returned no result")
	}
	if probe.Result.InitStartTicks != initStartTicks {
		return DockerBindingEvidence{}, ErrStaleDockerBinding
	}

	mounts := make([]dockerMount, 0, len(record.Mounts))
	for _, mount := range record.Mounts {
		mounts = append(mounts, dockerMount{
			Type: mount.Type, Source: mount.Source, Destination: mount.Destination,
			Mode: mount.Mode, RW: mount.RW, Propagation: mount.Propagation,
		})
	}
	return DockerBindingEvidence{
		DockerDaemonID:          daemonID,
		ContainerID:             record.ID,
		ContainerStartedAt:      record.State.StartedAt,
		ContainerInitStartTicks: initStartTicks,
		ContainerState:          record.State.Status,
		Principal:               probe.Result.Principal,
		DefaultCWD:              probe.Result.DefaultCWD,
		Shell:                   probe.Result.Shell,
		MountsDigest:            digestDockerMounts(mounts),
		Capabilities:            probe.Result.Capabilities,
	}, nil
}

func (docker *DockerCLI) Execute(ctx context.Context, request DockerExecRequest) (ExecResult, error) {
	evidence, err := docker.Inspect(ctx, DockerInspectRequest{
		ContextName:   request.ContextName,
		Selector:      request.ContainerID,
		RequestedUser: request.User,
		CWD:           request.CWD,
	})
	if err != nil {
		return ExecResult{}, fmt.Errorf("%w: %v", ErrStaleDockerBinding, err)
	}
	if !dockerBindingMatches(request, evidence) {
		return ExecResult{}, ErrStaleDockerBinding
	}

	args := dockerExecutionArguments(request, evidence)
	result, err := docker.execute(ctx, ExecRequest{
		CWD:       "/",
		Program:   docker.dockerPath,
		Args:      args,
		TimeoutMS: request.TimeoutMS + dockerExecutionGraceTimeMS,
	})
	if err != nil {
		return ExecResult{}, err
	}
	if result.TimedOut {
		return ExecResult{}, ErrDockerExecutionUnknown
	}
	if result.ExitCode != 0 || result.StdoutTruncated {
		return ExecResult{}, fmt.Errorf("%w: container runtime transport failed: %s", ErrDockerExecutionUnknown, strings.TrimSpace(result.Stderr))
	}
	var response ContainerExecResponse
	if err := decodeStrict([]byte(result.Stdout), &response); err != nil {
		return ExecResult{}, fmt.Errorf("%w: decode container runtime response: %v", ErrDockerExecutionUnknown, err)
	}
	if !response.OK {
		if response.Error != nil && response.Error.Code == "stale_binding" {
			return ExecResult{}, ErrStaleDockerBinding
		}
		if response.Error == nil {
			return ExecResult{}, fmt.Errorf("%w: container runtime returned no error detail", ErrDockerExecutionUnknown)
		}
		return ExecResult{}, fmt.Errorf("container runtime %s: %s", response.Error.Code, response.Error.Message)
	}
	if response.Result == nil {
		return ExecResult{}, fmt.Errorf("%w: container runtime returned no result", ErrDockerExecutionUnknown)
	}
	return *response.Result, nil
}

func dockerExecutionArguments(request DockerExecRequest, evidence DockerBindingEvidence) []string {
	verifiedUser := fmt.Sprintf("%d:%d", evidence.Principal.UID, evidence.Principal.GID)
	args := dockerArguments(request.ContextName, []string{
		"exec", "--user", verifiedUser, "--workdir", request.CWD, request.ContainerID,
		containerRuntimePath, "container-exec", evidence.ContainerInitStartTicks,
		strconv.Itoa(request.TimeoutMS), request.Program,
	})
	return append(args, request.Args...)
}

func (docker *DockerCLI) daemonID(ctx context.Context, contextName string) (string, error) {
	result, err := docker.runMetadata(ctx, contextName, []string{"info", "--format", "{{.ID}}"})
	if err != nil {
		return "", err
	}
	value := strings.TrimSpace(result.Stdout)
	if value == "" {
		return "", errors.New("Docker returned an empty daemon ID")
	}
	return value, nil
}

func (docker *DockerCLI) runMetadata(ctx context.Context, contextName string, args []string) (ExecResult, error) {
	result, err := docker.execute(ctx, ExecRequest{
		CWD: "/", Program: docker.dockerPath, Args: dockerArguments(contextName, args), TimeoutMS: dockerMetadataTimeoutMS,
	})
	if err != nil {
		return ExecResult{}, err
	}
	if result.TimedOut {
		return ExecResult{}, errors.New("Docker metadata command timed out")
	}
	if result.ExitCode != 0 {
		message := strings.TrimSpace(result.Stderr)
		if message == "" {
			message = fmt.Sprintf("Docker command exited with code %d", result.ExitCode)
		}
		return ExecResult{}, errors.New(message)
	}
	return result, nil
}

func dockerArguments(contextName string, args []string) []string {
	result := make([]string, 0, len(args)+2)
	result = append(result, "--context", contextName)
	return append(result, args...)
}

func dockerBindingMatches(request DockerExecRequest, evidence DockerBindingEvidence) bool {
	return request.ExpectedUID != nil && request.ExpectedGID != nil &&
		request.DockerDaemonID == evidence.DockerDaemonID &&
		request.ContainerID == evidence.ContainerID &&
		request.ContainerStartedAt == evidence.ContainerStartedAt &&
		request.ExpectedContainerInitStartTicks == evidence.ContainerInitStartTicks &&
		request.MountsDigest == evidence.MountsDigest &&
		*request.ExpectedUID == evidence.Principal.UID &&
		*request.ExpectedGID == evidence.Principal.GID &&
		evidence.ContainerState == "running"
}

func readLinuxProcessStartTicks(pid int) (string, error) {
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return "", err
	}
	return parseLinuxProcessStartTicks(string(data))
}

func parseLinuxProcessStartTicks(stat string) (string, error) {
	closing := strings.LastIndex(stat, ") ")
	if closing < 0 {
		return "", errors.New("invalid Linux process stat")
	}
	fields := strings.Fields(stat[closing+2:])
	const startTimeIndexAfterCommand = 19
	if len(fields) <= startTimeIndexAfterCommand {
		return "", errors.New("Linux process stat is missing start time")
	}
	value := fields[startTimeIndexAfterCommand]
	parsed, err := strconv.ParseUint(value, 10, 64)
	if err != nil || parsed == 0 {
		return "", errors.New("Linux process stat has an invalid start time")
	}
	return value, nil
}

func digestDockerMounts(mounts []dockerMount) string {
	ordered := slices.Clone(mounts)
	slices.SortFunc(ordered, func(left, right dockerMount) int {
		return strings.Compare(dockerMountIdentityKey(left), dockerMountIdentityKey(right))
	})
	encoded, err := json.Marshal(ordered)
	if err != nil {
		panic(fmt.Sprintf("encode Docker mount identity: %v", err))
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func dockerMountIdentityKey(mount dockerMount) string {
	return strings.Join([]string{
		mount.Destination,
		mount.Type,
		mount.Source,
		mount.Mode,
		strconv.FormatBool(mount.RW),
		mount.Propagation,
	}, "\x00")
}
