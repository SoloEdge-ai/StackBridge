//go:build linux

package stackruntime

import (
	"context"
	"testing"
)

func TestContainerExecutorRejectsAChangedInitProcess(t *testing.T) {
	t.Parallel()

	response := RunContainerExec(context.Background(), ContainerExecRequest{
		ExpectedInitStartTicks: "1",
		Program:                "/usr/bin/true",
		TimeoutMS:              1_000,
	})
	if response.OK || response.Error == nil || response.Error.Code != "stale_binding" {
		t.Fatalf("expected stale binding response: %#v", response)
	}
}

func TestContainerProbeReturnsStructuredIdentityWithoutExternalUserTools(t *testing.T) {
	t.Parallel()

	initStartTicks, err := readLinuxProcessStartTicks(1)
	if err != nil {
		t.Fatalf("read init process identity: %v", err)
	}
	response := RunContainerProbe(initStartTicks)
	if !response.OK || response.Result == nil {
		t.Fatalf("container probe failed: %#v", response)
	}
	if response.Result.InitStartTicks != initStartTicks || response.Result.Principal.UID < 0 || response.Result.DefaultCWD == "" {
		t.Fatalf("unexpected container probe result: %#v", response.Result)
	}
}

func TestContainerExecutorOwnsTimeoutAndTargetOutput(t *testing.T) {
	t.Parallel()

	initStartTicks, err := readLinuxProcessStartTicks(1)
	if err != nil {
		t.Fatalf("read init process identity: %v", err)
	}
	response := RunContainerExec(context.Background(), ContainerExecRequest{
		ExpectedInitStartTicks: initStartTicks,
		Program:                "/bin/sh",
		Args:                   []string{"-c", "trap '' TERM; printf '%s\\n' container-timeout; sleep 5"},
		TimeoutMS:              100,
	})
	if !response.OK || response.Result == nil {
		t.Fatalf("container execution failed: %#v", response)
	}
	if !response.Result.TimedOut || response.Result.Stdout != "container-timeout\n" {
		t.Fatalf("timeout result was not owned by the helper: %#v", response.Result)
	}
}

func TestContainerExecutorDoesNotInterpretTargetExitOrStderrAsControlState(t *testing.T) {
	t.Parallel()

	initStartTicks, err := readLinuxProcessStartTicks(1)
	if err != nil {
		t.Fatalf("read init process identity: %v", err)
	}
	response := RunContainerExec(context.Background(), ContainerExecRequest{
		ExpectedInitStartTicks: initStartTicks,
		Program:                "/bin/sh",
		Args:                   []string{"-c", "printf '%s\\n' 'STACKBRIDGE_STALE_BINDING' >&2; exit 124"},
		TimeoutMS:              1_000,
	})
	if !response.OK || response.Result == nil {
		t.Fatalf("container execution failed: %#v", response)
	}
	if response.Result.ExitCode != 124 || response.Result.TimedOut || response.Result.Stderr != "STACKBRIDGE_STALE_BINDING\n" {
		t.Fatalf("target output was interpreted as control state: %#v", response.Result)
	}
}
