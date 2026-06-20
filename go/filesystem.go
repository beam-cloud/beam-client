package beam

import (
	"context"
	"os"
	"path/filepath"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
)

// FileSystem exposes file operations inside a sandbox.
type FileSystem struct {
	sandbox *Sandbox
}

// FileInfo describes a file or directory in a sandbox.
type FileInfo struct {
	Name        string
	Mode        int32
	Size        int64
	ModTime     time.Time
	Owner       string
	Group       string
	IsDir       bool
	Permissions uint32
}

// FileSearchResult is one file's search results.
type FileSearchResult struct {
	Path    string
	Matches []FileSearchMatch
}

// FileSearchMatch is one text match in a file.
type FileSearchMatch struct {
	Content string
	Start   FilePosition
	End     FilePosition
}

// FilePosition is a one-based line and column position.
type FilePosition struct {
	Line   int
	Column int
}

// Upload writes data to sandboxPath.
func (fsys *FileSystem) Upload(ctx context.Context, sandboxPath string, data []byte, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o644
	}
	res, err := fsys.sandbox.client.pod.SandboxUploadFile(ctx, &pb.PodSandboxUploadFileRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
		Mode:          int32(mode.Perm()),
		Data:          data,
	})
	if err != nil {
		return wrapError(ErrFilesystem, "upload file", err)
	}
	if !res.GetOk() {
		return sdkError(ErrFilesystem, "upload file", res.GetErrorMsg(), nil)
	}
	return nil
}

// WriteBytes writes data to sandboxPath. It is an alias for Upload.
func (fsys *FileSystem) WriteBytes(ctx context.Context, sandboxPath string, data []byte, mode os.FileMode) error {
	return fsys.Upload(ctx, sandboxPath, data, mode)
}

// WriteText writes text to sandboxPath.
func (fsys *FileSystem) WriteText(ctx context.Context, sandboxPath, text string, mode os.FileMode) error {
	return fsys.Upload(ctx, sandboxPath, []byte(text), mode)
}

// UploadFile uploads a local file to sandboxPath.
func (fsys *FileSystem) UploadFile(ctx context.Context, localPath, sandboxPath string) error {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return wrapError(ErrFilesystem, "read local file", err)
	}
	info, err := os.Stat(localPath)
	if err != nil {
		return wrapError(ErrFilesystem, "stat local file", err)
	}
	return fsys.Upload(ctx, sandboxPath, data, info.Mode())
}

// Download reads a sandbox file into memory.
func (fsys *FileSystem) Download(ctx context.Context, sandboxPath string) ([]byte, error) {
	res, err := fsys.sandbox.client.pod.SandboxDownloadFile(ctx, &pb.PodSandboxDownloadFileRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
	})
	if err != nil {
		return nil, wrapError(ErrFilesystem, "download file", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrFilesystem, "download file", res.GetErrorMsg(), nil)
	}
	return res.GetData(), nil
}

// ReadBytes reads a sandbox file into memory. It is an alias for Download.
func (fsys *FileSystem) ReadBytes(ctx context.Context, sandboxPath string) ([]byte, error) {
	return fsys.Download(ctx, sandboxPath)
}

// ReadText reads a sandbox file as a string.
func (fsys *FileSystem) ReadText(ctx context.Context, sandboxPath string) (string, error) {
	data, err := fsys.Download(ctx, sandboxPath)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

// DownloadFile downloads a sandbox file to localPath.
func (fsys *FileSystem) DownloadFile(ctx context.Context, sandboxPath, localPath string) error {
	data, err := fsys.Download(ctx, sandboxPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return wrapError(ErrFilesystem, "write local file", err)
	}
	if err := os.WriteFile(localPath, data, 0o644); err != nil {
		return wrapError(ErrFilesystem, "write local file", err)
	}
	return nil
}

// Stat returns metadata for sandboxPath.
func (fsys *FileSystem) Stat(ctx context.Context, sandboxPath string) (FileInfo, error) {
	res, err := fsys.sandbox.client.pod.SandboxStatFile(ctx, &pb.PodSandboxStatFileRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
	})
	if err != nil {
		return FileInfo{}, wrapError(ErrFilesystem, "stat file", err)
	}
	if !res.GetOk() {
		return FileInfo{}, sdkError(ErrFilesystem, "stat file", res.GetErrorMsg(), nil)
	}
	return fileInfoFromProto(res.GetFileInfo()), nil
}

// List lists files directly under sandboxPath.
func (fsys *FileSystem) List(ctx context.Context, sandboxPath string) ([]FileInfo, error) {
	res, err := fsys.sandbox.client.pod.SandboxListFiles(ctx, &pb.PodSandboxListFilesRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
	})
	if err != nil {
		return nil, wrapError(ErrFilesystem, "list files", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrFilesystem, "list files", res.GetErrorMsg(), nil)
	}
	out := make([]FileInfo, 0, len(res.GetFiles()))
	for _, file := range res.GetFiles() {
		out = append(out, fileInfoFromProto(file))
	}
	return out, nil
}

// Mkdir creates a directory in the sandbox.
func (fsys *FileSystem) Mkdir(ctx context.Context, sandboxPath string, mode os.FileMode) error {
	if mode == 0 {
		mode = 0o755
	}
	res, err := fsys.sandbox.client.pod.SandboxCreateDirectory(ctx, &pb.PodSandboxCreateDirectoryRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
		Mode:          int32(mode.Perm()),
	})
	if err != nil {
		return wrapError(ErrFilesystem, "mkdir", err)
	}
	if !res.GetOk() {
		return sdkError(ErrFilesystem, "mkdir", res.GetErrorMsg(), nil)
	}
	return nil
}

// RemoveFile removes a sandbox file.
func (fsys *FileSystem) RemoveFile(ctx context.Context, sandboxPath string) error {
	res, err := fsys.sandbox.client.pod.SandboxDeleteFile(ctx, &pb.PodSandboxDeleteFileRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
	})
	if err != nil {
		return wrapError(ErrFilesystem, "remove file", err)
	}
	if !res.GetOk() {
		return sdkError(ErrFilesystem, "remove file", res.GetErrorMsg(), nil)
	}
	return nil
}

// RemoveDir removes a sandbox directory.
func (fsys *FileSystem) RemoveDir(ctx context.Context, sandboxPath string) error {
	res, err := fsys.sandbox.client.pod.SandboxDeleteDirectory(ctx, &pb.PodSandboxDeleteDirectoryRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
	})
	if err != nil {
		return wrapError(ErrFilesystem, "remove dir", err)
	}
	if !res.GetOk() {
		return sdkError(ErrFilesystem, "remove dir", res.GetErrorMsg(), nil)
	}
	return nil
}

// Remove removes a sandbox file or directory. Directories are removed with the
// backend directory-delete RPC, which may require the directory to be empty.
func (fsys *FileSystem) Remove(ctx context.Context, sandboxPath string) error {
	info, err := fsys.Stat(ctx, sandboxPath)
	if err != nil {
		return err
	}
	if info.IsDir {
		return fsys.RemoveDir(ctx, sandboxPath)
	}
	return fsys.RemoveFile(ctx, sandboxPath)
}

// Replace replaces pattern with replacement under sandboxPath.
func (fsys *FileSystem) Replace(ctx context.Context, sandboxPath, pattern, replacement string) error {
	res, err := fsys.sandbox.client.pod.SandboxReplaceInFiles(ctx, &pb.PodSandboxReplaceInFilesRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
		Pattern:       pattern,
		NewString:     replacement,
	})
	if err != nil {
		return wrapError(ErrFilesystem, "replace in files", err)
	}
	if !res.GetOk() {
		return sdkError(ErrFilesystem, "replace in files", res.GetErrorMsg(), nil)
	}
	return nil
}

// Find searches file contents under sandboxPath with a regex pattern.
func (fsys *FileSystem) Find(ctx context.Context, sandboxPath, pattern string) ([]FileSearchResult, error) {
	res, err := fsys.sandbox.client.pod.SandboxFindInFiles(ctx, &pb.PodSandboxFindInFilesRequest{
		ContainerId:   fsys.sandbox.containerID,
		ContainerPath: sandboxPath,
		Pattern:       pattern,
	})
	if err != nil {
		return nil, wrapError(ErrFilesystem, "find in files", err)
	}
	if !res.GetOk() {
		return nil, sdkError(ErrFilesystem, "find in files", res.GetErrorMsg(), nil)
	}
	out := make([]FileSearchResult, 0, len(res.GetResults()))
	for _, result := range res.GetResults() {
		item := FileSearchResult{Path: result.GetPath()}
		for _, match := range result.GetMatches() {
			item.Matches = append(item.Matches, FileSearchMatch{
				Content: match.GetContent(),
				Start:   positionFromProto(match.GetRange().GetStart()),
				End:     positionFromProto(match.GetRange().GetEnd()),
			})
		}
		out = append(out, item)
	}
	return out, nil
}

func fileInfoFromProto(info *pb.PodSandboxFileInfo) FileInfo {
	if info == nil {
		return FileInfo{}
	}
	return FileInfo{
		Name:        info.GetName(),
		Mode:        info.GetMode(),
		Size:        info.GetSize(),
		ModTime:     time.Unix(info.GetModTime(), 0),
		Owner:       info.GetOwner(),
		Group:       info.GetGroup(),
		IsDir:       info.GetIsDir(),
		Permissions: info.GetPermissions(),
	}
}

func positionFromProto(pos *pb.FileSearchPosition) FilePosition {
	if pos == nil {
		return FilePosition{}
	}
	return FilePosition{Line: int(pos.GetLine()), Column: int(pos.GetColumn())}
}
