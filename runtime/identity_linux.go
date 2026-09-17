//go:build linux

package stackruntime

import (
	"context"
	"fmt"
	"os"
	"os/user"
	"runtime"
	"strings"
)

func NewLinuxIdentityProvider(runtimeInstanceID string) IdentityProvider {
	return func(context.Context) (RuntimeIdentity, error) {
		if runtimeInstanceID == "" {
			return RuntimeIdentity{}, fmt.Errorf("runtime instance id is required")
		}

		bootIDBytes, err := os.ReadFile("/proc/sys/kernel/random/boot_id")
		if err != nil {
			return RuntimeIdentity{}, fmt.Errorf("read host boot id: %w", err)
		}
		workingDirectory, err := os.Getwd()
		if err != nil {
			return RuntimeIdentity{}, fmt.Errorf("read working directory: %w", err)
		}

		principalName := ""
		if currentUser, lookupErr := user.Current(); lookupErr == nil {
			principalName = currentUser.Username
		}
		shell := os.Getenv("SHELL")
		if shell == "" {
			if _, statErr := os.Stat("/bin/sh"); statErr == nil {
				shell = "/bin/sh"
			}
		}
		if shell == "" {
			return RuntimeIdentity{}, fmt.Errorf("no supported shell was found")
		}

		return RuntimeIdentity{
			ProtocolVersion:   ProtocolVersion,
			RuntimeInstanceID: runtimeInstanceID,
			HostBootID:        strings.TrimSpace(string(bootIDBytes)),
			Principal: Principal{
				UID:  os.Getuid(),
				GID:  os.Getgid(),
				Name: principalName,
			},
			Platform:     "linux",
			Arch:         runtime.GOARCH,
			DefaultCWD:   workingDirectory,
			Shell:        shell,
			Capabilities: []string{"process.argv"},
		}, nil
	}
}
