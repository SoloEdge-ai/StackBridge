//go:build linux

package stackruntime

import (
	"context"
	"testing"
)

func TestLinuxIdentityProviderReportsTheAuthenticatedRuntimePrincipal(t *testing.T) {
	t.Parallel()

	identity, err := NewLinuxIdentityProvider("runtime.test.1")(context.Background())
	if err != nil {
		t.Fatalf("identity probe failed: %v", err)
	}
	if identity.ProtocolVersion != 1 || identity.RuntimeInstanceID != "runtime.test.1" {
		t.Fatalf("unexpected protocol identity: %#v", identity)
	}
	if identity.HostBootID == "" || identity.Platform != "linux" || identity.Arch == "" {
		t.Fatalf("missing host identity: %#v", identity)
	}
	if identity.Principal.UID < 0 || identity.Principal.GID < 0 {
		t.Fatalf("invalid principal: %#v", identity.Principal)
	}
	if identity.DefaultCWD == "" || identity.Shell == "" {
		t.Fatalf("missing execution defaults: %#v", identity)
	}
}
