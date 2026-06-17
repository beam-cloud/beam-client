package beam

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"

	pb "github.com/beam-cloud/beta9/proto"
)

type Image struct {
	id                 string
	pythonVersion      string
	pythonPackages     []string
	commands           []string
	existingImageURI   string
	existingImageCreds map[string]string
	env                map[string]string
	secrets            []string
	dockerfile         string
	buildContextDir    string
	buildContextObject string
	forceRebuild       bool
	gpu                string
	ignorePython       bool
	buildLogSink       func(ImageBuildLog)
}

type ImageOption func(*Image)

type ImageBuildLog struct {
	Message string
	Warning bool
}

type ImageBuildResult struct {
	ImageID       string
	PythonVersion string
	Cached        bool
}

func NewImage(opts ...ImageOption) *Image {
	img := &Image{pythonVersion: "python3"}
	for _, opt := range opts {
		opt(img)
	}
	return img
}

func ImageFromRegistry(uri string, opts ...ImageOption) *Image {
	img := NewImage(append([]ImageOption{WithRegistry(uri)}, opts...)...)
	return img
}

func ImageFromID(id string) *Image {
	return &Image{id: id, pythonVersion: "python3"}
}

func ImageFromDockerfile(dockerfilePath string, opts ...ImageOption) (*Image, error) {
	content, err := os.ReadFile(dockerfilePath)
	if err != nil {
		return nil, wrapError(ErrImageBuild, "read Dockerfile", err)
	}
	img := NewImage(append([]ImageOption{
		WithDockerfile(string(content), filepath.Dir(dockerfilePath)),
		WithIgnorePython(true),
	}, opts...)...)
	return img, nil
}

func WithPythonVersion(version string) ImageOption {
	return func(i *Image) {
		i.pythonVersion = version
	}
}

func WithPythonPackages(packages ...string) ImageOption {
	return func(i *Image) {
		i.pythonPackages = append(i.pythonPackages, packages...)
	}
}

func WithCommands(commands ...string) ImageOption {
	return func(i *Image) {
		i.commands = append(i.commands, commands...)
	}
}

func WithRegistry(uri string) ImageOption {
	return func(i *Image) {
		i.existingImageURI = uri
	}
}

func WithBaseImageCredentials(creds map[string]string) ImageOption {
	return func(i *Image) {
		i.existingImageCreds = copyStringMap(creds)
	}
}

func WithEnv(env map[string]string) ImageOption {
	return func(i *Image) {
		i.env = copyStringMap(env)
	}
}

func WithSecrets(secrets ...string) ImageOption {
	return func(i *Image) {
		i.secrets = append(i.secrets, secrets...)
	}
}

func WithDockerfile(contents, contextDir string) ImageOption {
	return func(i *Image) {
		i.dockerfile = contents
		i.buildContextDir = contextDir
		if i.buildContextDir == "" {
			i.buildContextDir = "."
		}
	}
}

func WithBuildContextObject(objectID string) ImageOption {
	return func(i *Image) {
		i.buildContextObject = objectID
	}
}

func WithForceRebuild(force bool) ImageOption {
	return func(i *Image) {
		i.forceRebuild = force
	}
}

func WithBuildGPU(gpu string) ImageOption {
	return func(i *Image) {
		i.gpu = gpu
	}
}

func WithIgnorePython(ignore bool) ImageOption {
	return func(i *Image) {
		i.ignorePython = ignore
	}
}

func WithBuildLogSink(sink func(ImageBuildLog)) ImageOption {
	return func(i *Image) {
		i.buildLogSink = sink
	}
}

func (i *Image) ID() string {
	if i == nil {
		return ""
	}
	return i.id
}

func (i *Image) PythonVersion() string {
	if i == nil || i.pythonVersion == "" {
		return "python3"
	}
	return i.pythonVersion
}

func (i *Image) WithDocker() *Image {
	i.commands = append(i.commands,
		"apt-get update && apt-get install -y ca-certificates curl gnupg",
		`set -eux; . /etc/os-release; distro="${ID:-ubuntu}"; codename="${VERSION_CODENAME:-}"; case "$distro" in debian|ubuntu) ;; *) distro=ubuntu ;; esac; if [ -z "$codename" ]; then codename="$(awk -F= '/VERSION_CODENAME/ {print $2}' /etc/os-release)"; fi; install -m 0755 -d /etc/apt/keyrings; curl -fsSL "https://download.docker.com/linux/${distro}/gpg" | gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg; chmod a+r /etc/apt/keyrings/docker.gpg; echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${distro} ${codename} stable" > /etc/apt/sources.list.d/docker.list`,
		"apt-get update && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin",
		"if [ -x /usr/libexec/docker/cli-plugins/docker-compose ]; then ln -sf /usr/libexec/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose; elif [ -x /usr/lib/docker/cli-plugins/docker-compose ]; then ln -sf /usr/lib/docker/cli-plugins/docker-compose /usr/local/bin/docker-compose; fi",
		"docker --version && docker compose version && docker-compose version",
		"apt-get clean && rm -rf /var/lib/apt/lists/*",
	)
	return i
}

func (i *Image) Build(ctx context.Context, c *Client) (ImageBuildResult, error) {
	if i == nil {
		i = NewImage()
	}
	if i.id != "" {
		return ImageBuildResult{ImageID: i.id, PythonVersion: i.PythonVersion(), Cached: true}, nil
	}
	if i.buildContextObject == "" && i.dockerfile != "" && i.buildContextDir != "" {
		syncer := NewFileSyncer(i.buildContextDir)
		result, err := syncer.Sync(ctx, c)
		if err != nil {
			return ImageBuildResult{}, err
		}
		i.buildContextObject = result.ObjectID
	}

	verify, err := c.image.VerifyImageBuild(ctx, i.verifyRequest())
	if err != nil {
		return ImageBuildResult{}, wrapError(ErrImageBuild, "verify image", err)
	}
	if verify.GetExists() && verify.GetImageId() != "" && !i.forceRebuild {
		i.id = verify.GetImageId()
		return ImageBuildResult{ImageID: i.id, PythonVersion: i.PythonVersion(), Cached: true}, nil
	}

	stream, err := c.image.BuildImage(ctx, i.buildRequest())
	if err != nil {
		return ImageBuildResult{}, wrapError(ErrImageBuild, "build image", err)
	}
	var final *pb.BuildImageResponse
	for {
		msg, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return ImageBuildResult{}, wrapError(ErrImageBuild, "build image", err)
		}
		if msg.GetMsg() != "" && i.buildLogSink != nil {
			i.buildLogSink(ImageBuildLog{Message: msg.GetMsg(), Warning: msg.GetWarning()})
		}
		if msg.GetDone() {
			final = msg
			break
		}
	}
	if final == nil {
		return ImageBuildResult{}, sdkError(ErrImageBuild, "build image", "image build stream ended without a final response", nil)
	}
	if !final.GetSuccess() {
		if final.GetMsg() == "" {
			return ImageBuildResult{}, sdkError(ErrImageBuild, "build image", "image build failed", nil)
		}
		return ImageBuildResult{}, sdkError(ErrImageBuild, "build image", final.GetMsg(), nil)
	}
	i.id = final.GetImageId()
	if final.GetPythonVersion() != "" {
		i.pythonVersion = final.GetPythonVersion()
	}
	return ImageBuildResult{ImageID: i.id, PythonVersion: i.PythonVersion()}, nil
}

func (i *Image) verifyRequest() *pb.VerifyImageBuildRequest {
	req := &pb.VerifyImageBuildRequest{
		PythonVersion:    i.PythonVersion(),
		PythonPackages:   append([]string{}, i.pythonPackages...),
		Commands:         append([]string{}, i.commands...),
		ForceRebuild:     i.forceRebuild,
		ExistingImageUri: i.existingImageURI,
		EnvVars:          envSlice(i.env),
		Dockerfile:       i.dockerfile,
		BuildCtxObject:   i.buildContextObject,
		Secrets:          append([]string{}, i.secrets...),
		Gpu:              i.gpu,
		IgnorePython:     i.ignorePython,
	}
	if i.id != "" {
		req.ImageId = ptrString(i.id)
	}
	return req
}

func (i *Image) buildRequest() *pb.BuildImageRequest {
	return &pb.BuildImageRequest{
		PythonVersion:      i.PythonVersion(),
		PythonPackages:     append([]string{}, i.pythonPackages...),
		Commands:           append([]string{}, i.commands...),
		ExistingImageUri:   i.existingImageURI,
		ExistingImageCreds: copyStringMap(i.existingImageCreds),
		EnvVars:            envSlice(i.env),
		Dockerfile:         i.dockerfile,
		BuildCtxObject:     i.buildContextObject,
		Secrets:            append([]string{}, i.secrets...),
		Gpu:                i.gpu,
		IgnorePython:       i.ignorePython,
	}
}

func envSlice(values map[string]string) []string {
	if len(values) == 0 {
		return nil
	}
	keys := make([]string, 0, len(values))
	for k := range values {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+values[k])
	}
	return out
}

func copyStringMap(values map[string]string) map[string]string {
	if len(values) == 0 {
		return nil
	}
	out := make(map[string]string, len(values))
	for k, v := range values {
		out[k] = v
	}
	return out
}
