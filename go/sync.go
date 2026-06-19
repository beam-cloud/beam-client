package beam

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	pb "github.com/beam-cloud/beta9/proto"
)

var deterministicZipTime = time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)

var defaultIgnorePatterns = []string{
	".git/",
	".hg/",
	".svn/",
	".DS_Store",
	"__pycache__/",
	"*.pyc",
	".venv/",
	"venv/",
	"node_modules/",
	"dist/",
	"build/",
}

// FileSyncer creates deterministic workspace archives and uploads them to Beam.
type FileSyncer struct {
	Root           string
	IgnoreFile     string
	IgnorePatterns []string
	CreateIgnore   bool
}

// FileSyncOption configures a FileSyncer.
type FileSyncOption func(*FileSyncer)

// NewFileSyncer creates a syncer rooted at root.
func NewFileSyncer(root string, opts ...FileSyncOption) *FileSyncer {
	s := &FileSyncer{
		Root:         root,
		IgnoreFile:   ".beamignore",
		CreateIgnore: true,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// WithIgnoreFile sets the ignore file name. The default is ".beamignore".
func WithIgnoreFile(name string) FileSyncOption {
	return func(s *FileSyncer) {
		s.IgnoreFile = name
	}
}

// WithIgnorePatterns appends ignore patterns.
func WithIgnorePatterns(patterns ...string) FileSyncOption {
	return func(s *FileSyncer) {
		s.IgnorePatterns = append(s.IgnorePatterns, patterns...)
	}
}

// WithoutDefaultIgnoreFile disables loading the default ignore file.
func WithoutDefaultIgnoreFile() FileSyncOption {
	return func(s *FileSyncer) {
		s.CreateIgnore = false
	}
}

// FileSyncResult describes an uploaded or cached workspace archive.
type FileSyncResult struct {
	ObjectID string
	Hash     string
	Size     int64
	Files    []string
	Cached   bool
}

// Sync archives and uploads the sync root, reusing an existing object when the
// content hash already exists.
func (s *FileSyncer) Sync(ctx context.Context, c *Client) (FileSyncResult, error) {
	archive, hash, files, err := s.Archive()
	if err != nil {
		return FileSyncResult{}, err
	}
	size := int64(len(archive))

	head, err := c.gateway.HeadObject(ctx, &pb.HeadObjectRequest{
		Hash:               hash,
		SupportsPutHeaders: true,
	})
	if err != nil {
		return FileSyncResult{}, wrapError(ErrFilesystem, "head object", err)
	}
	if head.GetOk() && head.GetExists() {
		return FileSyncResult{ObjectID: head.GetObjectId(), Hash: hash, Size: size, Files: files, Cached: true}, nil
	}
	if !head.GetOk() && head.GetErrorMsg() != "" {
		return FileSyncResult{}, sdkError(ErrFilesystem, "head object", head.GetErrorMsg(), nil)
	}

	if !head.GetUseWorkspaceStorage() {
		result, err := s.putObjectStream(ctx, c, archive, hash, size, files)
		if err != nil {
			return FileSyncResult{}, err
		}
		return result, nil
	}

	create, err := c.gateway.CreateObject(ctx, &pb.CreateObjectRequest{
		ObjectMetadata:     &pb.ObjectMetadata{Name: hash + ".zip", Size: size},
		Hash:               hash,
		Size:               size,
		Overwrite:          true,
		SupportsPutHeaders: true,
	})
	if err != nil {
		return FileSyncResult{}, wrapError(ErrFilesystem, "create object", err)
	}
	if !create.GetOk() {
		return FileSyncResult{}, sdkError(ErrFilesystem, "create object", create.GetErrorMsg(), nil)
	}
	if create.GetPresignedUrl() != "" {
		req, err := http.NewRequestWithContext(ctx, http.MethodPut, create.GetPresignedUrl(), bytes.NewReader(archive))
		if err != nil {
			return FileSyncResult{}, wrapError(ErrFilesystem, "upload object", err)
		}
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/zip")
		for k, v := range create.GetPutHeaders() {
			req.Header.Set(k, v)
		}
		res, err := c.http.Do(req)
		if err != nil {
			return FileSyncResult{}, wrapError(ErrFilesystem, "upload object", err)
		}
		io.Copy(io.Discard, res.Body)
		res.Body.Close()
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return FileSyncResult{}, sdkError(ErrFilesystem, "upload object", res.Status, nil)
		}
		return FileSyncResult{ObjectID: create.GetObjectId(), Hash: hash, Size: size, Files: files}, nil
	}

	return FileSyncResult{ObjectID: create.GetObjectId(), Hash: hash, Size: size, Files: files}, nil
}

func (s *FileSyncer) putObjectStream(ctx context.Context, c *Client, archive []byte, hash string, size int64, files []string) (FileSyncResult, error) {
	stream, err := c.gateway.PutObjectStream(ctx)
	if err != nil {
		return FileSyncResult{}, wrapError(ErrFilesystem, "put object stream", err)
	}
	err = stream.Send(&pb.PutObjectRequest{
		ObjectContent: archive,
		ObjectMetadata: &pb.ObjectMetadata{
			Name: hash + ".zip",
			Size: size,
		},
		Hash:      hash,
		Overwrite: true,
	})
	if err != nil {
		return FileSyncResult{}, wrapError(ErrFilesystem, "put object stream", err)
	}
	put, err := stream.CloseAndRecv()
	if err != nil {
		return FileSyncResult{}, wrapError(ErrFilesystem, "put object stream", err)
	}
	if !put.GetOk() {
		return FileSyncResult{}, sdkError(ErrFilesystem, "put object stream", put.GetErrorMsg(), nil)
	}
	return FileSyncResult{ObjectID: put.GetObjectId(), Hash: hash, Size: size, Files: files}, nil
}

// Archive returns a deterministic zip archive, its hash, and included files.
func (s *FileSyncer) Archive() ([]byte, string, []string, error) {
	root := s.Root
	if root == "" {
		root = "."
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
	}
	info, err := os.Stat(absRoot)
	if err != nil {
		return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
	}
	if !info.IsDir() {
		return nil, "", nil, sdkError(ErrValidation, "archive workspace", "sync root must be a directory", nil)
	}

	patterns, err := s.ignorePatterns(absRoot)
	if err != nil {
		return nil, "", nil, err
	}
	var files []string
	err = filepath.WalkDir(absRoot, func(fullPath string, d os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if fullPath == absRoot {
			return nil
		}
		rel, err := filepath.Rel(absRoot, fullPath)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		ignored := matchIgnore(rel, d.IsDir(), patterns)
		if ignored && d.IsDir() {
			return filepath.SkipDir
		}
		if ignored || d.IsDir() {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
	}
	sort.Strings(files)

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, rel := range files {
		fullPath := filepath.Join(absRoot, filepath.FromSlash(rel))
		info, err := os.Stat(fullPath)
		if err != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
		}
		header, err := zip.FileInfoHeader(info)
		if err != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
		}
		header.Name = rel
		header.Method = zip.Deflate
		header.Modified = deterministicZipTime
		w, err := zw.CreateHeader(header)
		if err != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
		}
		f, err := os.Open(fullPath)
		if err != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
		}
		_, copyErr := io.Copy(w, f)
		closeErr := f.Close()
		if copyErr != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", copyErr)
		}
		if closeErr != nil {
			zw.Close()
			return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", closeErr)
		}
	}
	if err := zw.Close(); err != nil {
		return nil, "", nil, wrapError(ErrFilesystem, "archive workspace", err)
	}
	sum := sha256.Sum256(buf.Bytes())
	return buf.Bytes(), hex.EncodeToString(sum[:]), files, nil
}

func (s *FileSyncer) ignorePatterns(root string) ([]string, error) {
	patterns := append([]string{}, defaultIgnorePatterns...)
	if len(s.IgnorePatterns) > 0 {
		return append(patterns, s.IgnorePatterns...), nil
	}
	if s.IgnoreFile == "" {
		return patterns, nil
	}
	ignorePath := filepath.Join(root, s.IgnoreFile)
	content, err := os.ReadFile(ignorePath)
	if errors.Is(err, os.ErrNotExist) {
		if s.CreateIgnore {
			content = []byte(strings.Join(defaultIgnorePatterns, "\n") + "\n")
			_ = os.WriteFile(ignorePath, content, 0o644)
		} else {
			return patterns, nil
		}
	} else if err != nil {
		return nil, wrapError(ErrFilesystem, "read ignore file", err)
	}
	for _, line := range strings.Split(string(content), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}
	return patterns, nil
}

func matchIgnore(rel string, isDir bool, patterns []string) bool {
	rel = path.Clean(filepath.ToSlash(rel))
	if rel == "." {
		return false
	}
	ignored := false
	for _, pattern := range patterns {
		negated := strings.HasPrefix(pattern, "!")
		if negated {
			pattern = strings.TrimPrefix(pattern, "!")
		}
		if pattern == "" {
			continue
		}
		if ignorePatternMatches(rel, isDir, pattern) {
			ignored = !negated
		}
	}
	return ignored
}

func ignorePatternMatches(rel string, isDir bool, pattern string) bool {
	pattern = filepath.ToSlash(strings.TrimSpace(pattern))
	if pattern == "*" {
		return true
	}
	dirOnly := strings.HasSuffix(pattern, "/")
	pattern = strings.TrimSuffix(pattern, "/")
	if dirOnly {
		return isDir && (rel == pattern || strings.HasPrefix(rel, pattern+"/") || strings.HasPrefix(rel, path.Base(pattern)+"/"))
	}
	pattern = strings.TrimPrefix(pattern, "/")
	if ok, _ := path.Match(pattern, rel); ok {
		return true
	}
	if !strings.Contains(pattern, "/") {
		if ok, _ := path.Match(pattern, path.Base(rel)); ok {
			return true
		}
	}
	return rel == pattern || strings.HasPrefix(rel, pattern+"/")
}
