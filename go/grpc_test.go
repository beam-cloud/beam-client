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
	createReq *pb.CreatePodRequest
	execReq   *pb.PodSandboxExecRequest
	uploadReq *pb.PodSandboxUploadFileRequest
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
	return &pb.PodSandboxExecResponse{Ok: true, Pid: 42}, nil
}

func (s *fakePodService) SandboxStatus(context.Context, *pb.PodSandboxStatusRequest) (*pb.PodSandboxStatusResponse, error) {
	return &pb.PodSandboxStatusResponse{Ok: true, Status: "complete", ExitCode: 0}, nil
}

func (s *fakePodService) SandboxStdout(context.Context, *pb.PodSandboxStdoutRequest) (*pb.PodSandboxStdoutResponse, error) {
	return &pb.PodSandboxStdoutResponse{Ok: true, Stdout: "stdout"}, nil
}

func (s *fakePodService) SandboxStderr(context.Context, *pb.PodSandboxStderrRequest) (*pb.PodSandboxStderrResponse, error) {
	return &pb.PodSandboxStderrResponse{Ok: true, Stderr: "stderr"}, nil
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
	return &pb.PodSandboxExposePortResponse{Ok: true, Url: "https://sandbox.example"}, nil
}

func (s *fakePodService) SandboxListUrls(context.Context, *pb.PodSandboxListUrlsRequest) (*pb.PodSandboxListUrlsResponse, error) {
	return &pb.PodSandboxListUrlsResponse{Ok: true, Urls: map[int32]string{8080: "https://sandbox.example"}}, nil
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
		SyncLocalDir:  false,
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
	data, err := sb.FS.Download(context.Background(), "/workspace/file.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "downloaded" {
		t.Fatalf("bad download: %q", data)
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
}
