package stackruntime

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestGoRuntimeConsumesTheAuthoritativeTargetContractFixture(t *testing.T) {
	t.Parallel()

	data, err := os.ReadFile(filepath.Join("..", "packages", "protocol", "fixtures", "m0-b0-target-contract.json"))
	if err != nil {
		t.Fatalf("read shared target contract fixture: %v", err)
	}
	var fixture struct {
		ConnectionProfiles []struct {
			SchemaVersion int    `json:"schemaVersion"`
			Kind          string `json:"kind"`
		} `json:"connectionProfiles"`
		ExecutionTargets []struct {
			SchemaVersion int    `json:"schemaVersion"`
			Kind          string `json:"kind"`
		} `json:"executionTargets"`
		RuntimeBindings []struct {
			SchemaVersion           int    `json:"schemaVersion"`
			TargetKind              string `json:"targetKind"`
			ContainerID             string `json:"containerId"`
			ContainerInitStartTicks string `json:"containerInitStartTicks"`
		} `json:"runtimeBindings"`
		ExecutionRequests []struct {
			SchemaVersion int `json:"schemaVersion"`
			Command       struct {
				Kind string   `json:"kind"`
				Args []string `json:"args"`
			} `json:"command"`
		} `json:"executionRequests"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode shared target contract fixture: %v", err)
	}
	if len(fixture.ConnectionProfiles) != 2 || len(fixture.ExecutionTargets) != 3 || len(fixture.RuntimeBindings) != 3 || len(fixture.ExecutionRequests) != 3 {
		t.Fatalf("unexpected fixture coverage: %#v", fixture)
	}
	dockerBinding := fixture.RuntimeBindings[2]
	if dockerBinding.SchemaVersion != 2 || dockerBinding.TargetKind != "docker" || len(dockerBinding.ContainerID) != 64 || dockerBinding.ContainerInitStartTicks == "" {
		t.Fatalf("Docker binding fixture was not consumed: %#v", fixture.RuntimeBindings[2])
	}
	edge := fixture.ExecutionRequests[2]
	if edge.SchemaVersion != 2 || edge.Command.Kind != "argv" || len(edge.Command.Args) != 4 || edge.Command.Args[1] != "空 格" {
		t.Fatalf("structured argv edge fixture was not preserved: %#v", edge)
	}
}
