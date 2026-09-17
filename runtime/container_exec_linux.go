//go:build linux

package stackruntime

import (
	"context"
	"os"
	"os/user"
	"syscall"
)

type ContainerProbeResult struct {
	InitStartTicks string    `json:"initStartTicks"`
	Principal      Principal `json:"principal"`
	DefaultCWD     string    `json:"defaultCwd"`
	Shell          *string   `json:"shell"`
	Capabilities   []string  `json:"capabilities"`
}

type ContainerProbeResponse struct {
	Version int                   `json:"version"`
	OK      bool                  `json:"ok"`
	Result  *ContainerProbeResult `json:"result,omitempty"`
	Error   *ProtocolError        `json:"error,omitempty"`
}

type ContainerExecRequest struct {
	ExpectedInitStartTicks string
	Program                string
	Args                   []string
	TimeoutMS              int
}

type ContainerExecResponse struct {
	Version int            `json:"version"`
	OK      bool           `json:"ok"`
	Result  *ExecResult    `json:"result,omitempty"`
	Error   *ProtocolError `json:"error,omitempty"`
}

func RunContainerProbe(expectedInitStartTicks string) ContainerProbeResponse {
	currentInitStartTicks, err := readLinuxProcessStartTicks(1)
	if err != nil {
		return containerProbeError("identity_unavailable", err.Error())
	}
	if expectedInitStartTicks == "" || expectedInitStartTicks != currentInitStartTicks {
		return containerProbeError("stale_binding", ErrStaleDockerBinding.Error())
	}
	cwd, err := os.Getwd()
	if err != nil {
		return containerProbeError("identity_unavailable", err.Error())
	}
	principalName := ""
	if currentUser, lookupErr := user.Current(); lookupErr == nil {
		principalName = currentUser.Username
	}
	var shell *string
	for _, candidate := range []string{"/bin/sh", "/bin/bash"} {
		if syscall.Access(candidate, 1) == nil {
			resolved := candidate
			shell = &resolved
			break
		}
	}
	capabilities := []string{"process.argv"}
	if shell != nil {
		capabilities = append(capabilities, "process.shell")
	}
	result := ContainerProbeResult{
		InitStartTicks: currentInitStartTicks,
		Principal: Principal{
			UID: os.Getuid(), GID: os.Getgid(), Name: principalName,
		},
		DefaultCWD:   cwd,
		Shell:        shell,
		Capabilities: capabilities,
	}
	return ContainerProbeResponse{Version: ProtocolVersion, OK: true, Result: &result}
}

func RunContainerExec(ctx context.Context, request ContainerExecRequest) ContainerExecResponse {
	currentInitStartTicks, err := readLinuxProcessStartTicks(1)
	if err != nil {
		return containerExecError("identity_unavailable", err.Error())
	}
	if request.ExpectedInitStartTicks == "" || request.ExpectedInitStartTicks != currentInitStartTicks {
		return containerExecError("stale_binding", ErrStaleDockerBinding.Error())
	}
	cwd, err := os.Getwd()
	if err != nil {
		return containerExecError("execution_failed", err.Error())
	}
	if err := validateExecution(cwd, request.Program, request.Args, request.TimeoutMS); err != nil {
		return containerExecError("invalid_params", err.Error())
	}

	result, err := NewOSExecutor(1_048_576)(ctx, ExecRequest{
		CWD:       cwd,
		Program:   request.Program,
		Args:      request.Args,
		TimeoutMS: request.TimeoutMS,
	})
	if err != nil {
		return containerExecError("execution_failed", err.Error())
	}
	return ContainerExecResponse{Version: ProtocolVersion, OK: true, Result: &result}
}

func containerExecError(code, message string) ContainerExecResponse {
	return ContainerExecResponse{
		Version: ProtocolVersion,
		OK:      false,
		Error:   &ProtocolError{Code: code, Message: message},
	}
}

func containerProbeError(code, message string) ContainerProbeResponse {
	return ContainerProbeResponse{
		Version: ProtocolVersion,
		OK:      false,
		Error:   &ProtocolError{Code: code, Message: message},
	}
}
