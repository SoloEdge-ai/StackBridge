//go:build linux

package stackruntime

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"syscall"
	"time"
)

func NewOSExecutor(maximumOutputBytes int) Executor {
	if maximumOutputBytes < 1 {
		panic("maximum output bytes must be positive")
	}

	return func(ctx context.Context, request ExecRequest) (ExecResult, error) {
		timeoutCtx, cancel := context.WithTimeout(
			ctx,
			time.Duration(request.TimeoutMS)*time.Millisecond,
		)
		defer cancel()

		stdout := newBoundedBuffer(maximumOutputBytes)
		stderr := newBoundedBuffer(maximumOutputBytes)
		command := exec.CommandContext(timeoutCtx, request.Program, request.Args...)
		command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		command.Cancel = func() error {
			if command.Process == nil {
				return nil
			}
			return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
		}
		command.WaitDelay = 2 * time.Second
		command.Dir = request.CWD
		command.Stdout = stdout
		command.Stderr = stderr

		runErr := command.Run()
		result := ExecResult{
			ExitCode:        -1,
			Stdout:          stdout.String(),
			Stderr:          stderr.String(),
			StdoutTruncated: stdout.Truncated(),
			StderrTruncated: stderr.Truncated(),
		}
		if command.ProcessState != nil {
			result.ExitCode = command.ProcessState.ExitCode()
		}
		if errors.Is(timeoutCtx.Err(), context.DeadlineExceeded) {
			result.TimedOut = true
			return result, nil
		}
		if ctx.Err() != nil {
			return result, ctx.Err()
		}
		if runErr == nil {
			return result, nil
		}
		var exitError *exec.ExitError
		if errors.As(runErr, &exitError) {
			return result, nil
		}
		return result, fmt.Errorf("start process: %w", runErr)
	}
}

type boundedBuffer struct {
	buffer    bytes.Buffer
	maximum   int
	truncated bool
}

func newBoundedBuffer(maximum int) *boundedBuffer {
	return &boundedBuffer{maximum: maximum}
}

func (buffer *boundedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := buffer.maximum - buffer.buffer.Len()
	if remaining <= 0 {
		buffer.truncated = true
		return originalLength, nil
	}
	if len(data) > remaining {
		data = data[:remaining]
		buffer.truncated = true
	}
	_, _ = buffer.buffer.Write(data)
	return originalLength, nil
}

func (buffer *boundedBuffer) String() string {
	return buffer.buffer.String()
}

func (buffer *boundedBuffer) Truncated() bool {
	return buffer.truncated
}
