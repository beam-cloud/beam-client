package beam

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
)

type fakeGatewayService struct {
	pb.UnimplementedGatewayServiceServer
	authHeader       []string
	stubReq          *pb.GetOrCreateStubRequest
	createReq        *pb.CreateObjectRequest
	headExists       bool
	workspaceStorage bool
	presigned        string
	streamed         bool
}

func (s *fakeGatewayService) Authorize(ctx context.Context, _ *pb.AuthorizeRequest) (*pb.AuthorizeResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	s.authHeader = md.Get("authorization")
	return &pb.AuthorizeResponse{Ok: true, WorkspaceId: "workspace-123", NewToken: "token-next"}, nil
}

func (s *fakeGatewayService) HeadObject(context.Context, *pb.HeadObjectRequest) (*pb.HeadObjectResponse, error) {
	return &pb.HeadObjectResponse{Ok: true, Exists: s.headExists, ObjectId: "object-123", UseWorkspaceStorage: s.workspaceStorage}, nil
}

func (s *fakeGatewayService) CreateObject(_ context.Context, req *pb.CreateObjectRequest) (*pb.CreateObjectResponse, error) {
	s.createReq = req
	return &pb.CreateObjectResponse{
		Ok:           true,
		ObjectId:     "object-created",
		PresignedUrl: s.presigned,
		PutHeaders:   map[string]string{"x-beam-test": "true"},
	}, nil
}

func (s *fakeGatewayService) GetOrCreateStub(_ context.Context, req *pb.GetOrCreateStubRequest) (*pb.GetOrCreateStubResponse, error) {
	s.stubReq = req
	return &pb.GetOrCreateStubResponse{Ok: true, StubId: "stub-123"}, nil
}

func (s *fakeGatewayService) PutObjectStream(stream pb.GatewayService_PutObjectStreamServer) error {
	var last *pb.PutObjectRequest
	for {
		req, err := stream.Recv()
		if err != nil {
			break
		}
		last = req
	}
	s.streamed = last != nil
	return stream.SendAndClose(&pb.PutObjectResponse{Ok: true, ObjectId: "object-streamed"})
}

func (s *fakeGatewayService) StopContainer(context.Context, *pb.StopContainerRequest) (*pb.StopContainerResponse, error) {
	return &pb.StopContainerResponse{Ok: true}, nil
}

type fakeImageService struct {
	pb.UnimplementedImageServiceServer
	verifyReq *pb.VerifyImageBuildRequest
	buildReq  *pb.BuildImageRequest
	exists    bool
}

func (s *fakeImageService) VerifyImageBuild(_ context.Context, req *pb.VerifyImageBuildRequest) (*pb.VerifyImageBuildResponse, error) {
	s.verifyReq = req
	return &pb.VerifyImageBuildResponse{Exists: s.exists, ImageId: "image-123"}, nil
}

func (s *fakeImageService) BuildImage(req *pb.BuildImageRequest, stream pb.ImageService_BuildImageServer) error {
	s.buildReq = req
	if err := stream.Send(&pb.BuildImageResponse{Msg: "building"}); err != nil {
		return err
	}
	return stream.Send(&pb.BuildImageResponse{Done: true, Success: true, ImageId: "image-built", PythonVersion: req.GetPythonVersion()})
}

type fakeVolumeService struct {
	pb.UnimplementedVolumeServiceServer
}

func (s *fakeVolumeService) GetOrCreateVolume(context.Context, *pb.GetOrCreateVolumeRequest) (*pb.GetOrCreateVolumeResponse, error) {
	return &pb.GetOrCreateVolumeResponse{Ok: true, Volume: &pb.VolumeInstance{Id: "volume-123"}}, nil
}

type fakePodService struct {
	pb.UnimplementedPodServiceServer
	createReq       *pb.CreatePodRequest
	execReq         *pb.PodSandboxExecRequest
	execResponses   []*pb.PodSandboxExecResponse
	execCalls       int
	uploadReq       *pb.PodSandboxUploadFileRequest
	exposeURL       string
	listURLs        map[int32]string
	statusResponses []*pb.PodSandboxStatusResponse
	stdoutResponses []string
	stderrResponses []string
}

func (s *fakePodService) CreatePod(_ context.Context, req *pb.CreatePodRequest) (*pb.CreatePodResponse, error) {
	s.createReq = req
	return &pb.CreatePodResponse{Ok: true, ContainerId: "container-123", StubId: req.GetStubId()}, nil
}

func (s *fakePodService) SandboxConnect(context.Context, *pb.PodSandboxConnectRequest) (*pb.PodSandboxConnectResponse, error) {
	return &pb.PodSandboxConnectResponse{Ok: true, StubId: "stub-123"}, nil
}

func (s *fakePodService) SandboxExec(_ context.Context, req *pb.PodSandboxExecRequest) (*pb.PodSandboxExecResponse, error) {
	s.execReq = req
	s.execCalls++
	if len(s.execResponses) > 0 {
		res := s.execResponses[0]
		s.execResponses = s.execResponses[1:]
		return res, nil
	}
	return &pb.PodSandboxExecResponse{Ok: true, Pid: 42}, nil
}

func (s *fakePodService) SandboxStatus(_ context.Context, req *pb.PodSandboxStatusRequest) (*pb.PodSandboxStatusResponse, error) {
	if len(s.statusResponses) > 0 {
		res := s.statusResponses[0]
		s.statusResponses = s.statusResponses[1:]
		return res, nil
	}
	if req.GetPid() == 0 {
		return &pb.PodSandboxStatusResponse{Ok: true, Status: "running", ExitCode: -1}, nil
	}
	return &pb.PodSandboxStatusResponse{Ok: true, Status: "complete", ExitCode: 0}, nil
}

func (s *fakePodService) SandboxStdout(context.Context, *pb.PodSandboxStdoutRequest) (*pb.PodSandboxStdoutResponse, error) {
	stdout := "stdout"
	if len(s.stdoutResponses) > 0 {
		stdout = s.stdoutResponses[0]
		s.stdoutResponses = s.stdoutResponses[1:]
	}
	return &pb.PodSandboxStdoutResponse{Ok: true, Stdout: stdout}, nil
}

func (s *fakePodService) SandboxStderr(context.Context, *pb.PodSandboxStderrRequest) (*pb.PodSandboxStderrResponse, error) {
	stderr := "stderr"
	if len(s.stderrResponses) > 0 {
		stderr = s.stderrResponses[0]
		s.stderrResponses = s.stderrResponses[1:]
	}
	return &pb.PodSandboxStderrResponse{Ok: true, Stderr: stderr}, nil
}

func (s *fakePodService) SandboxKill(context.Context, *pb.PodSandboxKillRequest) (*pb.PodSandboxKillResponse, error) {
	return &pb.PodSandboxKillResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxListProcesses(context.Context, *pb.PodSandboxListProcessesRequest) (*pb.PodSandboxListProcessesResponse, error) {
	return &pb.PodSandboxListProcessesResponse{Ok: true, Processes: []*pb.ProcessInfo{
		{Pid: 42, Cmd: "echo hi", Cwd: "/workspace", Env: []string{"A=1"}, ExitCode: 0},
	}}, nil
}

func (s *fakePodService) SandboxUploadFile(_ context.Context, req *pb.PodSandboxUploadFileRequest) (*pb.PodSandboxUploadFileResponse, error) {
	s.uploadReq = req
	return &pb.PodSandboxUploadFileResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxDownloadFile(context.Context, *pb.PodSandboxDownloadFileRequest) (*pb.PodSandboxDownloadFileResponse, error) {
	return &pb.PodSandboxDownloadFileResponse{Ok: true, Data: []byte("downloaded")}, nil
}

func (s *fakePodService) SandboxStatFile(context.Context, *pb.PodSandboxStatFileRequest) (*pb.PodSandboxStatFileResponse, error) {
	return &pb.PodSandboxStatFileResponse{Ok: true, FileInfo: &pb.PodSandboxFileInfo{Name: "file.txt", Size: 4, Permissions: 0o644}}, nil
}

func (s *fakePodService) SandboxListFiles(context.Context, *pb.PodSandboxListFilesRequest) (*pb.PodSandboxListFilesResponse, error) {
	return &pb.PodSandboxListFilesResponse{Ok: true, Files: []*pb.PodSandboxFileInfo{{Name: "file.txt", Size: 4}}}, nil
}

func (s *fakePodService) SandboxCreateDirectory(context.Context, *pb.PodSandboxCreateDirectoryRequest) (*pb.PodSandboxCreateDirectoryResponse, error) {
	return &pb.PodSandboxCreateDirectoryResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxDeleteFile(context.Context, *pb.PodSandboxDeleteFileRequest) (*pb.PodSandboxDeleteFileResponse, error) {
	return &pb.PodSandboxDeleteFileResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxDeleteDirectory(context.Context, *pb.PodSandboxDeleteDirectoryRequest) (*pb.PodSandboxDeleteDirectoryResponse, error) {
	return &pb.PodSandboxDeleteDirectoryResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxExposePort(context.Context, *pb.PodSandboxExposePortRequest) (*pb.PodSandboxExposePortResponse, error) {
	exposeURL := s.exposeURL
	if exposeURL == "" {
		exposeURL = "https://sandbox.example"
	}
	return &pb.PodSandboxExposePortResponse{Ok: true, Url: exposeURL}, nil
}

func (s *fakePodService) SandboxListUrls(context.Context, *pb.PodSandboxListUrlsRequest) (*pb.PodSandboxListUrlsResponse, error) {
	urls := s.listURLs
	if urls == nil {
		urls = map[int32]string{8080: "https://sandbox.example"}
	}
	return &pb.PodSandboxListUrlsResponse{Ok: true, Urls: urls}, nil
}

func (s *fakePodService) SandboxUpdateTTL(context.Context, *pb.PodSandboxUpdateTTLRequest) (*pb.PodSandboxUpdateTTLResponse, error) {
	return &pb.PodSandboxUpdateTTLResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxUpdateNetworkPermissions(context.Context, *pb.PodSandboxUpdateNetworkPermissionsRequest) (*pb.PodSandboxUpdateNetworkPermissionsResponse, error) {
	return &pb.PodSandboxUpdateNetworkPermissionsResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxSnapshotMemory(context.Context, *pb.PodSandboxSnapshotMemoryRequest) (*pb.PodSandboxSnapshotMemoryResponse, error) {
	return &pb.PodSandboxSnapshotMemoryResponse{Ok: true, CheckpointId: "checkpoint-123"}, nil
}

func (s *fakePodService) SandboxCreateImageFromFilesystem(context.Context, *pb.PodSandboxCreateImageFromFilesystemRequest) (*pb.PodSandboxCreateImageFromFilesystemResponse, error) {
	return &pb.PodSandboxCreateImageFromFilesystemResponse{Ok: true, ImageId: "image-fs-123"}, nil
}

func (s *fakePodService) SandboxReplaceInFiles(context.Context, *pb.PodSandboxReplaceInFilesRequest) (*pb.PodSandboxReplaceInFilesResponse, error) {
	return &pb.PodSandboxReplaceInFilesResponse{Ok: true}, nil
}

func (s *fakePodService) SandboxFindInFiles(context.Context, *pb.PodSandboxFindInFilesRequest) (*pb.PodSandboxFindInFilesResponse, error) {
	return &pb.PodSandboxFindInFilesResponse{Ok: true, Results: []*pb.FileSearchResult{
		{Path: "/workspace/file.txt", Matches: []*pb.FileSearchMatch{{Content: "needle"}}},
	}}, nil
}

type fakeServices struct {
	gateway *fakeGatewayService
	image   *fakeImageService
	volume  *fakeVolumeService
	pod     *fakePodService
}

func newFakeClient(t *testing.T) (*Client, *fakeServices) {
	t.Helper()
	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	services := &fakeServices{
		gateway: &fakeGatewayService{headExists: true},
		image:   &fakeImageService{exists: true},
		volume:  &fakeVolumeService{},
		pod:     &fakePodService{},
	}
	pb.RegisterGatewayServiceServer(server, services.gateway)
	pb.RegisterImageServiceServer(server, services.image)
	pb.RegisterVolumeServiceServer(server, services.volume)
	pb.RegisterPodServiceServer(server, services.pod)
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() {
		server.Stop()
		_ = listener.Close()
	})

	dialer := func(context.Context, string) (net.Conn, error) {
		return listener.Dial()
	}
	client, err := NewClient(
		context.Background(),
		WithToken("token-original"),
		WithAddress("bufnet:443"),
		WithTLS(false),
		WithDialOptions(grpc.WithContextDialer(dialer)),
		WithDialOptions(grpc.WithTransportCredentials(insecure.NewCredentials())),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
	})
	return client, services
}

func TestAuthorizeSendsBearerToken(t *testing.T) {
	client, services := newFakeClient(t)
	workspace, err := client.Authorize(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if workspace.ID != "workspace-123" || workspace.Token != "token-next" {
		t.Fatalf("unexpected workspace: %#v", workspace)
	}
	if !reflect.DeepEqual(services.gateway.authHeader, []string{"Bearer token-original"}) {
		t.Fatalf("unexpected auth metadata: %#v", services.gateway.authHeader)
	}
	if _, err := client.Authorize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(services.gateway.authHeader, []string{"Bearer token-next"}) {
		t.Fatalf("refreshed token was not used: %#v", services.gateway.authHeader)
	}
}

func TestSandboxExposedURLsUseConfiguredLoopbackHost(t *testing.T) {
	client, services := newFakeClient(t)
	client.mu.Lock()
	client.config.GatewayHost = "127.0.0.1"
	client.mu.Unlock()

	services.pod.exposeURL = "http://localhost:1994/sandbox/id/container-123/8080"
	services.pod.listURLs = map[int32]string{
		8080: "http://localhost:1994/sandbox/id/container-123/8080",
		9000: "https://sandbox.example/9000",
	}
	sandbox := &Sandbox{client: client, containerID: "container-123", stubID: "stub-123"}

	exposedURL, err := sandbox.ExposePort(context.Background(), 8080)
	if err != nil {
		t.Fatal(err)
	}
	if exposedURL != "http://127.0.0.1:1994/sandbox/id/container-123/8080" {
		t.Fatalf("unexpected exposed URL: %s", exposedURL)
	}

	urls, err := sandbox.ListURLs(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if urls[8080] != "http://127.0.0.1:1994/sandbox/id/container-123/8080" {
		t.Fatalf("unexpected listed local URL: %#v", urls)
	}
	if urls[9000] != "https://sandbox.example/9000" {
		t.Fatalf("unexpected non-local URL rewrite: %#v", urls)
	}
}

func TestCreateSandboxMapsStubRequest(t *testing.T) {
	client, services := newFakeClient(t)
	sb, err := client.CreateSandbox(context.Background(), SandboxConfig{
		Name:          "test-sandbox",
		App:           "test-app",
		Image:         NewImage(WithPythonVersion("python3.11"), WithPythonPackages("requests"), WithCommands("echo build")),
		CPU:           2.5,
		MemoryMiB:     512,
		GPU:           "T4",
		GPUCount:      1,
		Ports:         []int{8080, 9090},
		Secrets:       []string{"SECRET_NAME"},
		Env:           map[string]string{"B": "2", "A": "1"},
		AllowList:     []string{"8.8.8.8/32"},
		DockerEnabled: true,
		Volumes: []VolumeMount{
			NewVolume("cache", "/cache"),
			NewCloudBucket("/bucket", CloudBucketConfig{BucketName: "bucket-name", ReadOnly: true}),
		},
		Pool: &PoolConfig{Name: "pool-a", GPU: []string{"T4"}, Nodes: 1},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sb.SandboxID() != "container-123" {
		t.Fatalf("unexpected sandbox ID: %s", sb.SandboxID())
	}
	req := services.gateway.stubReq
	if req == nil {
		t.Fatal("missing stub request")
	}
	if req.GetObjectId() != "object-123" || req.GetImageId() != "image-123" || req.GetStubType() != "sandbox" {
		t.Fatalf("bad object/image/stub type: %#v", req)
	}
	if req.GetName() != "test-sandbox" || req.GetAppName() != "test-app" {
		t.Fatalf("bad names: %s %s", req.GetName(), req.GetAppName())
	}
	if req.GetCpu() != 2500 || req.GetMemory() != 512 || req.GetGpu() != "T4" || req.GetGpuCount() != 1 {
		t.Fatalf("bad resources: cpu=%d mem=%d gpu=%s count=%d", req.GetCpu(), req.GetMemory(), req.GetGpu(), req.GetGpuCount())
	}
	if !reflect.DeepEqual(req.GetPorts(), []uint32{8080, 9090}) {
		t.Fatalf("bad ports: %#v", req.GetPorts())
	}
	if !reflect.DeepEqual(req.GetEnv(), []string{"A=1", "B=2"}) {
		t.Fatalf("bad env: %#v", req.GetEnv())
	}
	if len(req.GetSecrets()) != 1 || req.GetSecrets()[0].GetName() != "SECRET_NAME" {
		t.Fatalf("bad secrets: %#v", req.GetSecrets())
	}
	if req.GetBlockNetwork() || !reflect.DeepEqual(req.GetAllowList(), []string{"8.8.8.8/32"}) {
		t.Fatalf("bad network config")
	}
	if !req.GetDockerEnabled() || req.GetPool().GetName() != "pool-a" {
		t.Fatalf("bad docker/pool config")
	}
	paths := []string{req.GetVolumes()[0].GetMountPath(), req.GetVolumes()[1].GetMountPath()}
	sort.Strings(paths)
	if !reflect.DeepEqual(paths, []string{"/bucket", "/cache"}) {
		t.Fatalf("bad volume paths: %#v", paths)
	}
	if services.pod.createReq.GetStubId() != "stub-123" {
		t.Fatalf("bad create pod request: %#v", services.pod.createReq)
	}
	if services.image.verifyReq.GetPythonVersion() != "python3.11" {
		t.Fatalf("bad image verify request: %#v", services.image.verifyReq)
	}
}

func TestSandboxWaitReadyRetriesTransientStatusErrors(t *testing.T) {
	client, services := newFakeClient(t)
	services.pod.statusResponses = []*pb.PodSandboxStatusResponse{
		{Ok: false, ErrorMsg: "Failed to get sandbox status"},
		{Ok: true, Status: "pending"},
		{Ok: true, Status: "running"},
	}

	sb, err := client.ConnectSandbox(context.Background(), "container-123")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := sb.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if len(services.pod.statusResponses) != 0 {
		t.Fatalf("expected all status responses to be consumed, got %d", len(services.pod.statusResponses))
	}
}

func TestSandboxPollAndWait(t *testing.T) {
	client, services := newFakeClient(t)
	sb, err := client.ConnectSandbox(context.Background(), "container-123")
	if err != nil {
		t.Fatal(err)
	}

	services.pod.statusResponses = []*pb.PodSandboxStatusResponse{
		{Ok: true, Status: "running", ExitCode: -1},
	}
	exitCode, err := sb.Poll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != nil {
		t.Fatalf("expected running sandbox to have nil exit code, got %d", *exitCode)
	}

	services.pod.statusResponses = []*pb.PodSandboxStatusResponse{
		{Ok: true, Status: "running", ExitCode: -1},
		{Ok: true, Status: "complete", ExitCode: 17},
	}
	waitExitCode, err := sb.Wait(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if waitExitCode != 17 {
		t.Fatalf("unexpected wait exit code: %d", waitExitCode)
	}
}

func TestExecRetriesSandboxReadinessErrors(t *testing.T) {
	client, services := newFakeClient(t)
	services.pod.execResponses = []*pb.PodSandboxExecResponse{
		{Ok: false, ErrorMsg: "sandbox process manager is not ready"},
		{Ok: true, Pid: 42},
	}
	oldDelay := sandboxExecReadyRetryDelay
	sandboxExecReadyRetryDelay = time.Millisecond
	t.Cleanup(func() { sandboxExecReadyRetryDelay = oldDelay })

	sb, err := client.ConnectSandbox(context.Background(), "container-123")
	if err != nil {
		t.Fatal(err)
	}
	proc, err := sb.Exec(context.Background(), []string{"echo", "ready"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if proc.PID != 42 || services.pod.execCalls != 2 {
		t.Fatalf("expected retry to create pid 42 after 2 exec calls, pid=%d calls=%d", proc.PID, services.pod.execCalls)
	}
}

func TestImageBuildStream(t *testing.T) {
	client, services := newFakeClient(t)
	services.image.exists = false
	var logs []ImageBuildLog
	img := NewImage(
		WithPythonVersion("python3.11"),
		WithPythonPackages("requests"),
		WithCommands("echo build"),
		WithBuildLogSink(func(log ImageBuildLog) {
			logs = append(logs, log)
		}),
	)
	result, err := img.Build(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if result.ImageID != "image-built" || result.Cached {
		t.Fatalf("bad image result: %#v", result)
	}
	if services.image.buildReq == nil || services.image.buildReq.GetCommands()[0] != "echo build" {
		t.Fatalf("bad build request: %#v", services.image.buildReq)
	}
	if len(logs) != 1 || logs[0].Message != "building" {
		t.Fatalf("bad build logs: %#v", logs)
	}
}

func TestFileSyncPresignedUpload(t *testing.T) {
	client, services := newFakeClient(t)
	services.gateway.headExists = false
	services.gateway.workspaceStorage = true
	var uploaded bool
	uploadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("unexpected upload method: %s", r.Method)
		}
		if r.Header.Get("x-beam-test") != "true" {
			t.Fatalf("missing upload header")
		}
		uploaded = true
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadServer.Close()
	services.gateway.presigned = uploadServer.URL

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := NewFileSyncer(dir, WithoutDefaultIgnoreFile()).Sync(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if !uploaded {
		t.Fatal("expected presigned upload")
	}
	if result.ObjectID != "object-created" || result.Cached {
		t.Fatalf("bad sync result: %#v", result)
	}
	if services.gateway.createReq.GetHash() == "" || services.gateway.createReq.GetSize() == 0 {
		t.Fatalf("bad create object request: %#v", services.gateway.createReq)
	}
}

func TestFileSyncUsesPresignedUploadForLocalWorkspaceStorage(t *testing.T) {
	client, services := newFakeClient(t)
	client.mu.Lock()
	client.config.GatewayHost = "0.0.0.0"
	client.mu.Unlock()

	services.gateway.headExists = false
	services.gateway.workspaceStorage = true
	var uploaded bool
	uploadServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPut {
			t.Fatalf("unexpected upload method: %s", r.Method)
		}
		if r.Header.Get("x-beam-test") != "true" {
			t.Fatalf("missing upload header")
		}
		uploaded = true
		w.WriteHeader(http.StatusOK)
	}))
	defer uploadServer.Close()
	services.gateway.presigned = uploadServer.URL

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := NewFileSyncer(dir, WithoutDefaultIgnoreFile()).Sync(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if !uploaded {
		t.Fatal("expected presigned upload")
	}
	if services.gateway.streamed {
		t.Fatal("unexpected object stream upload")
	}
	if result.ObjectID != "object-created" || result.Cached {
		t.Fatalf("bad sync result: %#v", result)
	}
	if services.gateway.createReq == nil {
		t.Fatal("expected create object request")
	}
}

func TestFileSyncStreamsWhenWorkspaceStorageDisabled(t *testing.T) {
	client, services := newFakeClient(t)
	services.gateway.headExists = false
	services.gateway.workspaceStorage = false

	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := NewFileSyncer(dir, WithoutDefaultIgnoreFile()).Sync(context.Background(), client)
	if err != nil {
		t.Fatal(err)
	}
	if !services.gateway.streamed {
		t.Fatal("expected object stream upload")
	}
	if result.ObjectID != "object-streamed" || result.Cached {
		t.Fatalf("bad sync result: %#v", result)
	}
	if services.gateway.createReq != nil {
		t.Fatalf("unexpected create object request: %#v", services.gateway.createReq)
	}
}

func TestProcessAndFilesystemRPCs(t *testing.T) {
	client, services := newFakeClient(t)
	sb, err := client.ConnectSandbox(context.Background(), "container-123")
	if err != nil {
		t.Fatal(err)
	}
	proc, err := sb.Exec(context.Background(), []string{"sh", "-lc", "echo hi"}, ExecOptions{
		Workdir: "/tmp",
		Env:     map[string]string{"A": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if services.pod.execReq.GetCommand() != "sh -lc 'echo hi'" || services.pod.execReq.GetCwd() != "/tmp" {
		t.Fatalf("bad exec request: %#v", services.pod.execReq)
	}
	result, err := proc.Output(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.ExitCode != 0 || result.Stdout != "stdout" || result.Stderr != "stderr" {
		t.Fatalf("bad output: %#v", result)
	}
	processes, err := sb.ListProcesses(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(processes) != 1 || processes[0].Env["A"] != "1" {
		t.Fatalf("bad processes: %#v", processes)
	}

	if err := sb.FS.Upload(context.Background(), "/workspace/file.txt", []byte("data"), 0o600); err != nil {
		t.Fatal(err)
	}
	if services.pod.uploadReq.GetContainerPath() != "/workspace/file.txt" || services.pod.uploadReq.GetMode() != 0o600 {
		t.Fatalf("bad upload request: %#v", services.pod.uploadReq)
	}
	if err := sb.FS.WriteText(context.Background(), "/workspace/text.txt", "text", 0o644); err != nil {
		t.Fatal(err)
	}
	if services.pod.uploadReq.GetContainerPath() != "/workspace/text.txt" || string(services.pod.uploadReq.GetData()) != "text" {
		t.Fatalf("bad write text request: %#v", services.pod.uploadReq)
	}
	data, err := sb.FS.Download(context.Background(), "/workspace/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "downloaded" {
		t.Fatalf("bad download: %q", data)
	}
	text, err := sb.FS.ReadText(context.Background(), "/workspace/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if text != "downloaded" {
		t.Fatalf("bad read text: %q", text)
	}
	info, err := sb.FS.Stat(context.Background(), "/workspace/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "file.txt" || info.Size != 4 {
		t.Fatalf("bad stat: %#v", info)
	}
	results, err := sb.FS.Find(context.Background(), "/workspace", "needle")
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Matches[0].Content != "needle" {
		t.Fatalf("bad find results: %#v", results)
	}
	if err := sb.FS.Remove(context.Background(), "/workspace/file.txt"); err != nil {
		t.Fatal(err)
	}
}

func TestProcessStreamReadsStdoutAndStderrDeltasThroughExit(t *testing.T) {
	client, services := newFakeClient(t)
	services.pod.statusResponses = []*pb.PodSandboxStatusResponse{
		{Ok: true, Status: "running", ExitCode: -1},
		{Ok: true, Status: "running", ExitCode: -1},
		{Ok: true, Status: "exited", ExitCode: 7},
	}
	services.pod.stdoutResponses = []string{"out-a\n", "", "out-b\n", ""}
	services.pod.stderrResponses = []string{"err-a\n", "", "err-b\n", ""}

	sb, err := client.ConnectSandbox(context.Background(), "container-123")
	if err != nil {
		t.Fatal(err)
	}
	proc, err := sb.Exec(context.Background(), []string{"sh", "-lc", "emit logs"}, ExecOptions{})
	if err != nil {
		t.Fatal(err)
	}
	var entries []LogEntry
	exitCode, err := proc.Stream(context.Background(), func(entry LogEntry) {
		entries = append(entries, entry)
	})
	if err != nil {
		t.Fatal(err)
	}
	if exitCode != 7 {
		t.Fatalf("unexpected exit code: %d", exitCode)
	}
	want := []LogEntry{
		{Stream: "stdout", Data: "out-a\n"},
		{Stream: "stderr", Data: "err-a\n"},
		{Stream: "stdout", Data: "out-b\n"},
		{Stream: "stderr", Data: "err-b\n"},
	}
	if !reflect.DeepEqual(entries, want) {
		t.Fatalf("unexpected stream entries:\n got %#v\nwant %#v", entries, want)
	}
	if len(services.pod.stdoutResponses) != 0 || len(services.pod.stderrResponses) != 0 {
		t.Fatalf("expected final stream drains to be consumed, stdout=%q stderr=%q", services.pod.stdoutResponses, services.pod.stderrResponses)
	}
}
