//go:build linux

package stackruntime

import (
	"context"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestOSExecutorRunsArgvInTheRequestedDirectory(t *testing.T) {
	t.Parallel()

	workingDirectory := t.TempDir()
	execute := NewOSExecutor(1_048_576)

	result, err := execute(context.Background(), ExecRequest{
		CWD:       workingDirectory,
		Program:   "/usr/bin/printf",
		Args:      []string{"%s\\n", "hello from argv"},
		TimeoutMS: 5_000,
	})
	if err != nil {
		t.Fatalf("Execute returned an error: %v", err)
	}
	if result.ExitCode != 0 || result.Stdout != "hello from argv\n" || result.Stderr != "" {
		t.Fatalf("unexpected result: %#v", result)
	}
}

func TestOSExecutorKillsTheProcessGroupOnTimeout(t *testing.T) {
	t.Parallel()

	execute := NewOSExecutor(1_048_576)
	result, err := execute(context.Background(), ExecRequest{
		CWD:       t.TempDir(),
		Program:   "/bin/sh",
		Args:      []string{"-c", "sleep 30 & child=$!; printf '%s\\n' \"$child\"; wait"},
		TimeoutMS: 100,
	})
	if err != nil {
		t.Fatalf("Execute returned an error: %v", err)
	}
	if !result.TimedOut {
		t.Fatalf("expected a timeout result: %#v", result)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(result.Stdout))
	if err != nil {
		t.Fatalf("child PID was not captured: %q", result.Stdout)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for {
		stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", childPID))
		if os.IsNotExist(err) {
			break
		}
		if err != nil {
			t.Fatalf("inspect child process %d: %v", childPID, err)
		}
		closing := strings.LastIndex(string(stat), ") ")
		if closing >= 0 && strings.HasPrefix(string(stat[closing+2:]), "Z ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child process %d survived timeout: %s", childPID, stat)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
