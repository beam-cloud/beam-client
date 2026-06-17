package beam

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
)

type SandboxConfig struct {
	Name      string
	App       string
	Image     *Image
	CPU       float64
	MemoryMiB int64
	GPU       string
	GPUCount  uint32
	KeepWarm  time.Duration
	Ports     []int
	Volumes   []VolumeMount
	Secrets   []string
	Env       map[string]string
	// SyncLocalDir uploads Workdir to the sandbox when true. The zero value is false.
	SyncLocalDir  bool
	Workdir       string
	BlockNetwork  bool
	AllowList     []string
	DockerEnabled bool
	Pool          *PoolConfig
}

type Sandbox struct {
	client      *Client
	containerID string
	stubID      string
	FS          *FileSystem
	Docker      *Docker
}

type SandboxStatus struct {
	Status   string
	ExitCode int
}

type NetworkPermissions struct {
	BlockNetwork bool
	AllowList    []string
}

func (c *Client) CreateSandbox(ctx context.Context, config SandboxConfig) (*Sandbox, error) {
	req, err := c.prepareSandboxStub(ctx, config)
	if err != nil {
		return nil, err
	}
	stub, err := c.gateway.GetOrCreateStub(ctx, req)
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "create sandbox stub", err)
	}
	if !stub.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "create sandbox stub", stub.GetErrMsg(), nil)
	}
	create, err := c.pod.CreatePod(ctx, &pb.CreatePodRequest{StubId: stub.GetStubId()})
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "create sandbox", err)
	}
	if !create.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "create sandbox", create.GetErrorMsg(), nil)
	}
	return newSandbox(c, create.GetContainerId(), stub.GetStubId()), nil
}

func (c *Client) ConnectSandbox(ctx context.Context, containerID string) (*Sandbox, error) {
	if containerID == "" {
		return nil, sdkError(ErrValidation, "connect sandbox", "container ID is required", nil)
	}
	res, err := c.pod.SandboxConnect(ctx, &pb.PodSandboxConnectRequest{ContainerId: containerID})
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "connect sandbox", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "connect sandbox", res.GetErrorMsg(), nil)
	}
	return newSandbox(c, containerID, res.GetStubId()), nil
}

func (c *Client) CreateSandboxFromMemorySnapshot(ctx context.Context, checkpointID string) (*Sandbox, error) {
	if checkpointID == "" {
		return nil, sdkError(ErrValidation, "create sandbox from snapshot", "checkpoint ID is required", nil)
	}
	res, err := c.pod.CreatePod(ctx, &pb.CreatePodRequest{CheckpointId: ptrString(checkpointID)})
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "create sandbox from snapshot", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "create sandbox from snapshot", res.GetErrorMsg(), nil)
	}
	return newSandbox(c, res.GetContainerId(), res.GetStubId()), nil
}

func newSandbox(c *Client, containerID, stubID string) *Sandbox {
	s := &Sandbox{client: c, containerID: containerID, stubID: stubID}
	s.FS = &FileSystem{sandbox: s}
	s.Docker = &Docker{sandbox: s}
	return s
}

func (s *Sandbox) SandboxID() string {
	if s == nil {
		return ""
	}
	return s.containerID
}

func (s *Sandbox) StubID() string {
	if s == nil {
		return ""
	}
	return s.stubID
}

func (s *Sandbox) Terminate(ctx context.Context) error {
	res, err := s.client.gateway.StopContainer(ctx, &pb.StopContainerRequest{ContainerId: s.containerID})
	if err != nil {
		return wrapError(ErrSandboxConnection, "terminate sandbox", err)
	}
	if !res.GetOk() {
		return sdkError(ErrSandboxConnection, "terminate sandbox", res.GetErrorMsg(), nil)
	}
	return nil
}

func (s *Sandbox) Status(ctx context.Context) (SandboxStatus, error) {
	res, err := s.client.pod.SandboxStatus(ctx, &pb.PodSandboxStatusRequest{ContainerId: s.containerID})
	if err != nil {
		return SandboxStatus{}, wrapError(ErrSandboxConnection, "sandbox status", err)
	}
	if !res.GetOk() {
		return SandboxStatus{}, sdkError(ErrSandboxConnection, "sandbox status", res.GetErrorMsg(), nil)
	}
	return SandboxStatus{Status: res.GetStatus(), ExitCode: int(res.GetExitCode())}, nil
}

func (s *Sandbox) WaitReady(ctx context.Context) error {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		status, err := s.Status(ctx)
		if err != nil {
			lastErr = err
		} else {
			lastErr = nil
			switch status.Status {
			case "running", "ready":
				return nil
			case "failed", "error", "stopped", "terminated", "complete":
				return sdkError(ErrSandboxConnection, "wait ready", "sandbox exited before becoming ready", nil)
			}
		}
		select {
		case <-ctx.Done():
			if lastErr != nil {
				return sdkError(ErrSandboxConnection, "wait ready", "last status check failed: "+lastErr.Error(), ctx.Err())
			}
			return wrapError(ErrSandboxConnection, "wait ready", ctx.Err())
		case <-ticker.C:
		}
	}
}

func (s *Sandbox) UpdateTTL(ctx context.Context, ttl time.Duration) error {
	seconds := int32(ttl.Seconds())
	if ttl < 0 {
		seconds = -1
	}
	res, err := s.client.pod.SandboxUpdateTTL(ctx, &pb.PodSandboxUpdateTTLRequest{
		ContainerId: s.containerID,
		Ttl:         seconds,
	})
	if err != nil {
		return wrapError(ErrSandboxConnection, "update ttl", err)
	}
	if !res.GetOk() {
		return sdkError(ErrSandboxConnection, "update ttl", res.GetErrorMsg(), nil)
	}
	return nil
}

func (s *Sandbox) ExposePort(ctx context.Context, port int) (string, error) {
	res, err := s.client.pod.SandboxExposePort(ctx, &pb.PodSandboxExposePortRequest{
		ContainerId: s.containerID,
		StubId:      s.stubID,
		Port:        int32(port),
	})
	if err != nil {
		return "", wrapError(ErrSandboxConnection, "expose port", err)
	}
	if !res.GetOk() {
		return "", sdkError(ErrSandboxConnection, "expose port", res.GetErrorMsg(), nil)
	}
	return res.GetUrl(), nil
}

func (s *Sandbox) ListURLs(ctx context.Context) (map[int]string, error) {
	res, err := s.client.pod.SandboxListUrls(ctx, &pb.PodSandboxListUrlsRequest{ContainerId: s.containerID})
	if err != nil {
		return nil, wrapError(ErrSandboxConnection, "list urls", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrSandboxConnection, "list urls", res.GetErrorMsg(), nil)
	}
	out := make(map[int]string, len(res.GetUrls()))
	for port, url := range res.GetUrls() {
		out[int(port)] = url
	}
	return out, nil
}

func (s *Sandbox) UpdateNetworkPermissions(ctx context.Context, permissions NetworkPermissions) error {
	if permissions.BlockNetwork && len(permissions.AllowList) > 0 {
		return sdkError(ErrValidation, "update network permissions", "block network and allow list cannot both be set", nil)
	}
	res, err := s.client.pod.SandboxUpdateNetworkPermissions(ctx, &pb.PodSandboxUpdateNetworkPermissionsRequest{
		ContainerId:  s.containerID,
		StubId:       s.stubID,
		BlockNetwork: permissions.BlockNetwork,
		AllowList:    append([]string{}, permissions.AllowList...),
	})
	if err != nil {
		return wrapError(ErrSandboxConnection, "update network permissions", err)
	}
	if !res.GetOk() {
		return sdkError(ErrSandboxConnection, "update network permissions", res.GetErrorMsg(), nil)
	}
	return nil
}

func (s *Sandbox) SnapshotMemory(ctx context.Context) (string, error) {
	res, err := s.client.pod.SandboxSnapshotMemory(ctx, &pb.PodSandboxSnapshotMemoryRequest{
		ContainerId: s.containerID,
		StubId:      s.stubID,
	})
	if err != nil {
		return "", wrapError(ErrSandboxConnection, "snapshot memory", err)
	}
	if !res.GetOk() {
		return "", sdkError(ErrSandboxConnection, "snapshot memory", res.GetErrorMsg(), nil)
	}
	if res.GetCheckpointId() == "" {
		return "", sdkError(ErrSandboxConnection, "snapshot memory", "backend returned an empty checkpoint ID", nil)
	}
	return res.GetCheckpointId(), nil
}

func (s *Sandbox) CreateImageFromFilesystem(ctx context.Context) (string, error) {
	res, err := s.client.pod.SandboxCreateImageFromFilesystem(ctx, &pb.PodSandboxCreateImageFromFilesystemRequest{
		ContainerId: s.containerID,
		StubId:      s.stubID,
	})
	if err != nil {
		return "", wrapError(ErrSandboxConnection, "create image from filesystem", err)
	}
	if !res.GetOk() {
		return "", sdkError(ErrSandboxConnection, "create image from filesystem", res.GetErrorMsg(), nil)
	}
	if res.GetImageId() == "" {
		return "", sdkError(ErrSandboxConnection, "create image from filesystem", "backend returned an empty image ID", nil)
	}
	return res.GetImageId(), nil
}

func (c *Client) prepareSandboxStub(ctx context.Context, config SandboxConfig) (*pb.GetOrCreateStubRequest, error) {
	if config.BlockNetwork && len(config.AllowList) > 0 {
		return nil, sdkError(ErrValidation, "create sandbox", "block network and allow list cannot both be set", nil)
	}
	image := config.Image
	if image == nil {
		image = NewImage(WithPythonVersion("python3.11"))
	}
	imageResult, err := image.Build(ctx, c)
	if err != nil {
		return nil, err
	}

	root := config.Workdir
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			return nil, wrapError(ErrFilesystem, "create sandbox", err)
		}
	}
	ignorePatterns := []string(nil)
	if !config.SyncLocalDir {
		ignorePatterns = []string{"*"}
	}
	syncer := NewFileSyncer(root, WithIgnorePatterns(ignorePatterns...))
	syncResult, err := syncer.Sync(ctx, c)
	if err != nil {
		return nil, err
	}

	volumes, err := c.prepareVolumes(ctx, config.Volumes)
	if err != nil {
		return nil, err
	}
	name := config.Name
	if name == "" {
		name = "sandbox"
	}
	app := config.App
	if app == "" {
		app = name
	}
	if app == "" {
		app = filepath.Base(root)
	}
	cpu := config.CPU
	if cpu == 0 {
		cpu = 1
	}
	memory := config.MemoryMiB
	if memory == 0 {
		memory = 128
	}
	keepWarm := config.KeepWarm
	if keepWarm == 0 {
		keepWarm = 10 * time.Minute
	}

	return &pb.GetOrCreateStubRequest{
		ObjectId:           syncResult.ObjectID,
		ImageId:            imageResult.ImageID,
		StubType:           "sandbox",
		Name:               name,
		PythonVersion:      imageResult.PythonVersion,
		Cpu:                int64(cpu * 1000),
		Memory:             memory,
		Gpu:                config.GPU,
		GpuCount:           config.GPUCount,
		KeepWarmSeconds:    float32(keepWarm.Seconds()),
		Workers:            1,
		MaxPendingTasks:    100,
		Volumes:            volumes,
		ForceCreate:        true,
		Authorized:         false,
		Secrets:            secretVars(config.Secrets),
		Autoscaler:         &pb.Autoscaler{Type: "queue_depth", MaxContainers: 1, TasksPerContainer: 1},
		TaskPolicy:         &pb.TaskPolicy{Timeout: 3600, MaxRetries: 3},
		ConcurrentRequests: 1,
		CheckpointEnabled:  false,
		Entrypoint:         []string{"tail", "-f", "/dev/null"},
		Ports:              uint32Ports(config.Ports),
		Env:                envSlice(config.Env),
		AppName:            app,
		BlockNetwork:       config.BlockNetwork,
		AllowList:          append([]string{}, config.AllowList...),
		DockerEnabled:      config.DockerEnabled,
		Pool:               config.Pool.proto(),
	}, nil
}

func (c *Client) prepareVolumes(ctx context.Context, mounts []VolumeMount) ([]*pb.Volume, error) {
	if len(mounts) == 0 {
		return nil, nil
	}
	out := make([]*pb.Volume, 0, len(mounts))
	for _, mount := range mounts {
		volume, err := mount.prepare(ctx, c)
		if err != nil {
			return nil, err
		}
		out = append(out, volume)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].GetMountPath() < out[j].GetMountPath()
	})
	return out, nil
}

func secretVars(secrets []string) []*pb.SecretVar {
	if len(secrets) == 0 {
		return nil
	}
	out := make([]*pb.SecretVar, 0, len(secrets))
	for _, secret := range secrets {
		out = append(out, &pb.SecretVar{Name: secret})
	}
	return out
}

func uint32Ports(ports []int) []uint32 {
	if len(ports) == 0 {
		return nil
	}
	out := make([]uint32, 0, len(ports))
	for _, port := range ports {
		out = append(out, uint32(port))
	}
	return out
}
