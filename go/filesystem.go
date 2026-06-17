package beam

import (
	"context"
	"os"
	"path/filepath"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
)

type FileSystem struct {
	sandbox *Sandbox
}

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

type FileSearchResult struct {
	Path    string
	Matches []FileSearchMatch
}

type FileSearchMatch struct {
	Content string
	Start   FilePosition
	End     FilePosition
}

type FilePosition struct {
	Line   int
	Column int
}

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
