package stackruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strings"
	"time"
)

const (
	ProtocolVersion    = 1
	maximumMessageSize = 1_048_576
)

type Principal struct {
	UID  int    `json:"uid"`
	GID  int    `json:"gid"`
	Name string `json:"name,omitempty"`
}

type RuntimeIdentity struct {
	ProtocolVersion   int       `json:"protocolVersion"`
	RuntimeInstanceID string    `json:"runtimeInstanceId"`
	HostBootID        string    `json:"hostBootId"`
	Principal         Principal `json:"principal"`
	Platform          string    `json:"platform"`
	Arch              string    `json:"arch"`
	DefaultCWD        string    `json:"defaultCwd"`
	Shell             string    `json:"shell"`
	Capabilities      []string  `json:"capabilities"`
}

type ExecRequest struct {
	CWD       string   `json:"cwd"`
	Program   string   `json:"program"`
	Args      []string `json:"args"`
	TimeoutMS int      `json:"timeoutMs"`
}

type ExecResult struct {
	ExitCode        int    `json:"exitCode"`
	Stdout          string `json:"stdout"`
	Stderr          string `json:"stderr"`
	TimedOut        bool   `json:"timedOut"`
	StdoutTruncated bool   `json:"stdoutTruncated,omitempty"`
	StderrTruncated bool   `json:"stderrTruncated,omitempty"`
}

type DockerInspectRequest struct {
	ContextName   string `json:"contextName"`
	Selector      string `json:"selector"`
	RequestedUser string `json:"requestedUser"`
	CWD           string `json:"cwd"`
}

type DockerBindingEvidence struct {
	DockerDaemonID          string    `json:"dockerDaemonId"`
	ContainerID             string    `json:"containerId"`
	ContainerStartedAt      string    `json:"containerStartedAt"`
	ContainerInitStartTicks string    `json:"containerInitStartTicks"`
	ContainerState          string    `json:"containerState"`
	Principal               Principal `json:"principal"`
	DefaultCWD              string    `json:"defaultCwd"`
	Shell                   *string   `json:"shell"`
	MountsDigest            string    `json:"mountsDigest"`
	Capabilities            []string  `json:"capabilities"`
}

type DockerExecRequest struct {
	ContextName                     string   `json:"contextName"`
	DockerDaemonID                  string   `json:"dockerDaemonId"`
	ContainerID                     string   `json:"containerId"`
	ContainerStartedAt              string   `json:"containerStartedAt"`
	ExpectedContainerInitStartTicks string   `json:"expectedContainerInitStartTicks"`
	MountsDigest                    string   `json:"mountsDigest"`
	User                            string   `json:"user"`
	ExpectedUID                     *int     `json:"expectedUid"`
	ExpectedGID                     *int     `json:"expectedGid"`
	CWD                             string   `json:"cwd"`
	Program                         string   `json:"program"`
	Args                            []string `json:"args"`
	TimeoutMS                       int      `json:"timeoutMs"`
}

type Request struct {
	Version int             `json:"version"`
	ID      string          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type ProtocolError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type Response struct {
	Version int            `json:"version"`
	ID      string         `json:"id"`
	OK      bool           `json:"ok"`
	Result  any            `json:"result,omitempty"`
	Error   *ProtocolError `json:"error,omitempty"`
}

type IdentityProvider func(context.Context) (RuntimeIdentity, error)
type Executor func(context.Context, ExecRequest) (ExecResult, error)

type DockerService interface {
	Inspect(context.Context, DockerInspectRequest) (DockerBindingEvidence, error)
	Execute(context.Context, DockerExecRequest) (ExecResult, error)
}

var ErrStaleDockerBinding = errors.New("docker runtime binding is stale")
var ErrDockerExecutionUnknown = errors.New("Docker execution state is unknown")

type Dependencies struct {
	Identity IdentityProvider
	Execute  Executor
	Docker   DockerService
}

type Server struct {
	identity IdentityProvider
	execute  Executor
	docker   DockerService
}

func NewServer(dependencies Dependencies) *Server {
	return &Server{
		identity: dependencies.Identity,
		execute:  dependencies.Execute,
		docker:   dependencies.Docker,
	}
}

func (server *Server) Serve(ctx context.Context, input io.Reader, output io.Writer) error {
	if server.identity == nil {
		return errors.New("runtime identity provider is required")
	}

	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 64*1024), maximumMessageSize)
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)

	for scanner.Scan() {
		if len(bytes.TrimSpace(scanner.Bytes())) == 0 {
			continue
		}
		request, err := decodeRequest(scanner.Bytes())
		if err != nil {
			if encodeErr := encoder.Encode(errorResponse("", "invalid_request", err.Error())); encodeErr != nil {
				return encodeErr
			}
			continue
		}

		response := server.handle(ctx, request)
		if err := encoder.Encode(response); err != nil {
			return err
		}
	}
	return scanner.Err()
}

func (server *Server) handle(ctx context.Context, request Request) Response {
	if request.Version != ProtocolVersion {
		return errorResponse(request.ID, "unsupported_version", "protocol version must be 1")
	}
	if request.ID == "" {
		return errorResponse("", "invalid_request", "request id is required")
	}
	switch request.Method {
	case "handshake":
		return server.handshake(ctx, request.ID)
	case "exec":
		return server.exec(ctx, request)
	case "docker.inspect":
		return server.dockerInspect(ctx, request)
	case "docker.exec":
		return server.dockerExec(ctx, request)
	default:
		return errorResponse(request.ID, "method_not_found", "unsupported runtime method")
	}
}

func (server *Server) handshake(ctx context.Context, requestID string) Response {
	identity, err := server.identity(ctx)
	if err != nil {
		return errorResponse(requestID, "identity_unavailable", err.Error())
	}
	return Response{
		Version: ProtocolVersion,
		ID:      requestID,
		OK:      true,
		Result:  identity,
	}
}

func (server *Server) exec(ctx context.Context, request Request) Response {
	if server.execute == nil {
		return errorResponse(request.ID, "capability_unavailable", "argv execution is unavailable")
	}

	var params ExecRequest
	if err := decodeStrict(request.Params, &params); err != nil {
		return errorResponse(request.ID, "invalid_params", err.Error())
	}
	if err := validateExecution(params.CWD, params.Program, params.Args, params.TimeoutMS); err != nil {
		return errorResponse(request.ID, "invalid_params", err.Error())
	}

	result, err := server.execute(ctx, params)
	if err != nil {
		return errorResponse(request.ID, "execution_failed", err.Error())
	}
	return Response{
		Version: ProtocolVersion,
		ID:      request.ID,
		OK:      true,
		Result:  result,
	}
}

func (server *Server) dockerInspect(ctx context.Context, request Request) Response {
	if server.docker == nil {
		return errorResponse(request.ID, "capability_unavailable", "Docker access is unavailable")
	}
	var params DockerInspectRequest
	if err := decodeStrict(request.Params, &params); err != nil {
		return errorResponse(request.ID, "invalid_params", err.Error())
	}
	if strings.TrimSpace(params.Selector) == "" || strings.ContainsRune(params.Selector, '\x00') {
		return errorResponse(request.ID, "invalid_params", "container selector is required")
	}
	if strings.TrimSpace(params.ContextName) == "" || strings.ContainsRune(params.ContextName, '\x00') {
		return errorResponse(request.ID, "invalid_params", "contextName is required")
	}
	if strings.TrimSpace(params.RequestedUser) == "" || strings.ContainsRune(params.RequestedUser, '\x00') {
		return errorResponse(request.ID, "invalid_params", "requestedUser is required")
	}
	if !path.IsAbs(params.CWD) {
		return errorResponse(request.ID, "invalid_params", "cwd must be an absolute POSIX path")
	}

	result, err := server.docker.Inspect(ctx, params)
	if err != nil {
		return errorResponse(request.ID, "docker_inspect_failed", err.Error())
	}
	return Response{Version: ProtocolVersion, ID: request.ID, OK: true, Result: result}
}

func (server *Server) dockerExec(ctx context.Context, request Request) Response {
	if server.docker == nil {
		return errorResponse(request.ID, "capability_unavailable", "Docker access is unavailable")
	}
	var params DockerExecRequest
	if err := decodeStrict(request.Params, &params); err != nil {
		return errorResponse(request.ID, "invalid_params", err.Error())
	}
	if strings.TrimSpace(params.DockerDaemonID) == "" {
		return errorResponse(request.ID, "invalid_params", "dockerDaemonId is required")
	}
	if strings.TrimSpace(params.ContextName) == "" || strings.ContainsRune(params.ContextName, '\x00') {
		return errorResponse(request.ID, "invalid_params", "contextName is required")
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(params.ContainerID) {
		return errorResponse(request.ID, "invalid_params", "containerId must be a full lowercase Docker ID")
	}
	if _, err := time.Parse(time.RFC3339Nano, params.ContainerStartedAt); err != nil {
		return errorResponse(request.ID, "invalid_params", "containerStartedAt must be RFC3339")
	}
	if !regexp.MustCompile(`^[1-9][0-9]*$`).MatchString(params.ExpectedContainerInitStartTicks) {
		return errorResponse(request.ID, "invalid_params", "expectedContainerInitStartTicks must be a positive integer")
	}
	if !regexp.MustCompile(`^sha256:[0-9a-f]{64}$`).MatchString(params.MountsDigest) {
		return errorResponse(request.ID, "invalid_params", "mountsDigest must be a SHA-256 digest")
	}
	if strings.TrimSpace(params.User) == "" || strings.ContainsRune(params.User, '\x00') {
		return errorResponse(request.ID, "invalid_params", "user is required")
	}
	if params.ExpectedUID == nil || params.ExpectedGID == nil || *params.ExpectedUID < 0 || *params.ExpectedGID < 0 {
		return errorResponse(request.ID, "invalid_params", "expectedUid and expectedGid are required")
	}
	if err := validateExecution(params.CWD, params.Program, params.Args, params.TimeoutMS); err != nil {
		return errorResponse(request.ID, "invalid_params", err.Error())
	}

	result, err := server.docker.Execute(ctx, params)
	if errors.Is(err, ErrStaleDockerBinding) {
		return errorResponse(request.ID, "stale_binding", err.Error())
	}
	if errors.Is(err, ErrDockerExecutionUnknown) {
		return errorResponse(request.ID, "execution_unknown", err.Error())
	}
	if err != nil {
		return errorResponse(request.ID, "docker_execution_failed", err.Error())
	}
	return Response{Version: ProtocolVersion, ID: request.ID, OK: true, Result: result}
}

func validateExecution(cwd, program string, args []string, timeoutMS int) error {
	if !path.IsAbs(cwd) {
		return errors.New("cwd must be an absolute POSIX path")
	}
	if strings.TrimSpace(program) == "" || strings.ContainsRune(program, '\x00') {
		return errors.New("program is required")
	}
	if len(args) > 1_024 {
		return errors.New("too many arguments")
	}
	for _, argument := range args {
		if strings.ContainsRune(argument, '\x00') {
			return errors.New("arguments cannot contain NUL")
		}
	}
	if timeoutMS < 1 || timeoutMS > 86_400_000 {
		return errors.New("timeoutMs is outside the supported range")
	}
	return nil
}

func decodeRequest(data []byte) (Request, error) {
	var request Request
	if err := decodeStrict(data, &request); err != nil {
		return Request{}, fmt.Errorf("decode request: %w", err)
	}
	return request, nil
}

func decodeStrict(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("request must contain one JSON object")
	}
	return nil
}

func errorResponse(id, code, message string) Response {
	return Response{
		Version: ProtocolVersion,
		ID:      id,
		OK:      false,
		Error: &ProtocolError{
			Code:    code,
			Message: message,
		},
	}
}
